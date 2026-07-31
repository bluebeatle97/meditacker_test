import Phaser from 'phaser';
import { io, type Socket } from 'socket.io-client';
import { ZoneDwellFilter, ZONE_DWELL_MS } from '@meditracker/shared';
import type { FloorplanMeta, PatientProfile, Zone, ZoneAction } from '@meditracker/shared';
import { Pathfinder, type WalkableGrid } from './pathfinder';

/**
 * 환자용 화면 (설계서 8) — **도트(픽셀아트) 방식**
 *
 * - 배경은 도면을 타일로 다시 그린 pixelmap.png (tools/build-pixel-map.py 생성).
 *   출력이 도면의 정수배(MAP_SCALE)라 서버 좌표 × MAP_SCALE 이 곧 화면 좌표다.
 * - 카메라가 본인 캐릭터를 따라다닌다(줌 정수배 — 도트가 뭉개지지 않게).
 *   '전체 보기' 버튼으로 층 전체를 한눈에 볼 수 있다.
 * - 첫 진입 시 캐릭터를 고른다. 선택값은 **서버**에 저장한다
 *   (⚠️ 불변식 B-5: 브라우저 스토리지 금지). 태그 반납 시 서버가 초기화한다.
 * - 타 환자 아바타 미표시 — 서버가 애초에 좌표를 안 보냄 (불변식 B-1)
 * - namespace: /patient
 */

const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? 'http://localhost:8080';

/**
 * pixelmap.png 은 도면의 몇 배인가 — build-pixel-map.py 의 MAP_SCALE 과 같아야 한다.
 * 타일 1칸(16px) = 도면 32px ≈ 52cm 이라 캐릭터(16x32)가 두 칸 키로 선다.
 */
const MAP_SCALE = 0.5;
/** 스프라이트는 맵과 같은 축척이므로 확대하지 않는다 — 확대는 카메라 줌이 담당 */
const CHAR_SCALE = 1;
/** 화면 가로에 타일이 대략 이 개수 보이도록 줌을 정한다 (포켓몬 골드류 타일 탑뷰) */
const TILES_ACROSS = 20;
/** 줌 상한 — 더 키우면 도트가 너무 굵어져 뭉툭해 보인다 */
const MAX_ZOOM = 4;
/** 카메라 추종 보간 계수 (0~1). 낮으면 부드럽게 뒤따르고, 1이면 즉시 붙는다 */
const FOLLOW_LERP = 0.08;
const TILE = 16;

// 걷는 속도: 도면 1px ≈ 1.62cm, 보행 1.4m/s → 약 86 도면px/초 → 화면은 ×MAP_SCALE
const WALK_PX_PER_SEC = 86 * MAP_SCALE;
const ARRIVE_EPS = 12 * MAP_SCALE;

const CHARACTERS = [
  { id: 'adam', label: '민준' },
  { id: 'alex', label: '지호' },
  { id: 'amelia', label: '서연' },
  { id: 'bob', label: '준서' },
] as const;

/** 스프라이트 시트 24프레임 = 6프레임 × 4방향 (오른쪽·위·왼쪽·아래 순서) */
const DIR_ROW = { right: 0, up: 1, left: 2, down: 3 } as const;
type Dir = keyof typeof DIR_ROW;


/**
 * 오류를 화면에 띄운다.
 * 캔버스만 비어 있으면 원인을 알 수 없어서(실제로 그런 신고가 있었다) 반드시 보이게 한다.
 */
function fatal(what: string, err: unknown): void {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  console.error(`[patient] ${what}`, err);
  const el = document.getElementById('fatal');
  if (el) {
    el.textContent = `화면을 띄우지 못했습니다 — ${what}
${msg}`;
    el.classList.add('show');
  }
}
window.addEventListener('error', (e) => fatal('실행 오류', e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) => fatal('처리되지 않은 오류', e.reason));

async function resolveToken(): Promise<string> {
  const urlToken = new URLSearchParams(window.location.search).get('token');
  if (urlToken) return urlToken;
  const res = await fetch(`${SERVER_URL}/dev-token?type=patient`);
  return (await res.json()).token;
}

/** 첫 진입 커스터마이징 — 저장까지 끝나면 프로필을 돌려준다 */
function runSetup(token: string): Promise<PatientProfile> {
  return new Promise((resolve) => {
    const wrap = document.getElementById('setup')!;
    const grid = document.getElementById('chars')!;
    const nick = document.getElementById('nick') as HTMLInputElement;
    const start = document.getElementById('start') as HTMLButtonElement;
    let picked: string | null = null;

    for (const c of CHARACTERS) {
      const el = document.createElement('div');
      el.className = 'char';
      el.innerHTML = `<div class="pic" style="background-image:url(/characters/${c.id}-idle.png)"></div>
                      <div class="nm">${c.label}</div>`;
      el.addEventListener('click', () => {
        picked = c.id;
        for (const other of Array.from(grid.children)) other.classList.remove('sel');
        el.classList.add('sel');
        start.disabled = false;
      });
      grid.appendChild(el);
    }

    start.addEventListener('click', async () => {
      if (!picked) return;
      start.disabled = true;
      start.textContent = '저장 중…';
      await fetch(`${SERVER_URL}/patient-profile`, {
        method: 'POST',
        body: JSON.stringify({ token, charId: picked, nickname: nick.value }),
      });
      wrap.classList.remove('show');
      resolve({ charId: picked, nickname: nick.value.trim() || null });
    });

    wrap.classList.add('show');
  });
}

class PatientScene extends Phaser.Scene {
  private socket!: Socket;
  private zones = new Map<string, Zone>();
  private pf!: Pathfinder;
  private me!: Phaser.GameObjects.Sprite;
  private nameTag?: Phaser.GameObjects.Text;
  private profile!: PatientProfile;
  private token!: string;
  private plan!: FloorplanMeta;
  /** 픽셀맵 실제 크기 (타일 경계까지 채워져 도면 × MAP_SCALE 보다 조금 클 수 있다) */
  private mapW = 0;
  private mapH = 0;

  /** 남은 경로 (화면 좌표) — 벽을 피해 문으로 돌아간다 */
  private path: Array<{ x: number; y: number }> = [];
  private facing: Dir = 'down';
  private teleport = true;
  private overview = false;
  /**
   * 상단 안내의 '현재 위치' 안정화 — 복도를 지나가며 스치는 방까지 바로 띄우면
   * 글자가 계속 바뀌어 읽을 수 없다. 캐릭터·카메라는 그대로 즉시 따라간다.
   */
  private zoneDwell = new ZoneDwellFilter(ZONE_DWELL_MS);
  private lastSelf?: { zone: string | null; waitingRank: number; estimatedWaitSec: number };
  /**
   * 같은 구역에 있는 **다른 손님**(익명). 서버는 좌표를 주지 않고 인원수만 준다(불변식 B-1)
   * → 방 안에 그 수만큼 세워 둔다. 실제 위치가 아니라 '이 방에 몇 명 있다'는 표현이다.
   */
  private others: Phaser.GameObjects.Sprite[] = [];

  constructor() {
    super('patient');
  }

  /** 도면 좌표 → 화면(픽셀맵) 좌표 */
  private m(v: number): number {
    return v * MAP_SCALE;
  }

  /**
   * 에셋은 Phaser 정식 로더로 받는다.
   * 캐릭터는 어느 것을 고를지 아직 모르니 4종을 다 받는다 (한 장 4~6KB).
   * ⚠️ create() 안에서 load.start() 를 쓰면 씬이 LOADING 으로 되돌아가 update() 가 멈춘다 —
   *    그래서 preload() 에서 받아야 한다.
   */
  preload(): void {
    this.load.image('pixelmap', '/pixelmap.png');
    for (const c of CHARACTERS) {
      this.load.spritesheet(`${c.id}-idle`, `/characters/${c.id}-idle.png`, {
        frameWidth: 16,
        frameHeight: 32,
      });
      this.load.spritesheet(`${c.id}-run`, `/characters/${c.id}-run.png`, {
        frameWidth: 16,
        frameHeight: 32,
      });
    }
  }

  async create(): Promise<void> {
    try {
      await this.boot();
    } catch (err) {
      fatal('초기화', err);
    }
  }

  private async boot(): Promise<void> {
    this.token = await resolveToken();
    const [plan, zones, grid, profile] = await Promise.all([
      fetch(`${SERVER_URL}/floorplan`).then((r) => r.json() as Promise<FloorplanMeta>),
      fetch(`${SERVER_URL}/zones`).then((r) => r.json() as Promise<Zone[]>),
      fetch(`${SERVER_URL}/walkable`).then((r) => r.json() as Promise<WalkableGrid>),
      fetch(`${SERVER_URL}/patient-profile?token=${encodeURIComponent(this.token)}`)
        .then((r) => r.json() as Promise<PatientProfile | null>)
        .catch(() => null),
    ]);
    this.plan = plan;
    this.pf = new Pathfinder(grid);
    for (const z of zones) this.zones.set(z.zoneId, z);

    // 첫 진입이면 캐릭터를 고르고 나서 시작
    this.profile = profile ?? (await runSetup(this.token));

    this.makeAnims();

    // 픽셀맵은 타일 경계까지 채워져 도면 크기보다 조금 클 수 있다 → 텍스처 실측값을 쓴다
    const src = this.textures.get('pixelmap').getSourceImage();
    this.mapW = src.width;
    this.mapH = src.height;
    if (!this.mapW || !this.mapH) {
      throw new Error('pixelmap.png 을 불러오지 못했습니다 (tools/build-pixel-map.py 로 생성)');
    }
    this.add.image(0, 0, 'pixelmap').setOrigin(0, 0);
    this.cameras.main.setBounds(0, 0, this.mapW, this.mapH);
    this.cameras.main.setBackgroundColor('#0e1420');
    // ⚠️ pixelArt: true 는 게임 설정의 roundPixels 를 강제로 켠다. 그대로 두면 카메라와
    //    스프라이트가 도면 1px(줌 4배에서 화면 4px) 단위로 스냅해 이동이 뚝뚝 끊긴다.
    //    실제 렌더링은 **카메라의** roundPixels 를 보므로 여기서 끈다 — 줌 4배면
    //    도면 0.25px 이동이 화면 1px 이라 이것만으로 충분히 매끄럽다.
    this.cameras.main.setRoundPixels(false);

    // 시작 위치: 접수데스크 (아직 신호가 없을 때의 기본값)
    const start = this.zones.get('reception') ?? [...this.zones.values()][0];
    this.me = this.add
      .sprite(this.m(start.tilePosition.x), this.m(start.tilePosition.y), `${this.profile.charId}-idle`)
      .setScale(CHAR_SCALE)
      .setOrigin(0.5, 0.85); // 발끝이 좌표에 오도록
    this.me.play('idle-down');
    if (this.profile.nickname) {
      this.nameTag = this.add
        .text(this.me.x, this.me.y + 6, this.profile.nickname, {
          fontFamily: 'sans-serif',
          fontSize: '13px',
          color: '#0d1520',
          backgroundColor: '#ffffffdd',
          padding: { x: 4, y: 1 },
        })
        .setOrigin(0.5, 0);
    }

    this.cameras.main.setZoom(this.followZoom());
    this.cameras.main.startFollow(this.me, false, FOLLOW_LERP, FOLLOW_LERP);
    this.cameras.main.centerOn(this.me.x, this.me.y); // lerp 수렴을 기다리면 첫 화면이 빈 구석이다
    // 창 크기가 바뀌면 줌을 다시 계산 (보이는 타일 수를 일정하게)
    this.scale.on('resize', (size: Phaser.Structs.Size) => {
      this.cameras.resize(size.width, size.height);
      if (!this.overview) this.cameras.main.setZoom(this.followZoom());
    });
    this.setupOverviewButton();
    this.setHud(null);
    // 머문 시간이 차면 안내 문구를 바꾼다 (이벤트가 안 와도 갱신되도록 주기 확인)
    this.time.addEvent({
      delay: 500,
      loop: true,
      callback: () => {
        if (this.lastSelf) this.setHud(this.lastSelf);
      },
    });

    this.connect();
  }

  /**
   * 따라가기 줌 — 화면 폭에 타일이 TILES_ACROSS 개쯤 보이도록.
   * 도트가 뭉개지지 않게 **정수배**만 쓴다 (2~6배로 제한).
   */
  private followZoom(): number {
    const z = Math.round(this.scale.width / (TILES_ACROSS * TILE));
    return Math.max(2, Math.min(MAX_ZOOM, z));
  }

  /** 전체 보기 ↔ 따라가기 */
  private setupOverviewButton(): void {
    const btn = document.getElementById('overview-btn') as HTMLButtonElement | null;
    if (!btn) return;
    btn.onclick = () => {
      this.overview = !this.overview;
      const cam = this.cameras.main;
      if (this.overview) {
        cam.stopFollow();
        cam.setZoom(Math.min(this.scale.width / this.mapW, this.scale.height / this.mapH));
        cam.centerOn(this.mapW / 2, this.mapH / 2);
      } else {
        cam.setZoom(this.followZoom());
        cam.startFollow(this.me, false, FOLLOW_LERP, FOLLOW_LERP);
      }
      btn.textContent = this.overview ? '📍 내 위치' : '🗺 전체 보기';
      btn.classList.toggle('on', this.overview);
    };
  }

  private makeAnims(): void {
    // 다른 손님(익명)용 — 정면 idle 하나만 (누구인지 드러나지 않게 한 종류로 통일)
    this.anims.create({
      key: 'other-idle',
      frames: this.anims.generateFrameNumbers('adam-idle', { start: 18, end: 23 }),
      frameRate: 5,
      repeat: -1,
    });
    for (const [dir, row] of Object.entries(DIR_ROW)) {
      for (const kind of ['idle', 'run'] as const) {
        this.anims.create({
          key: `${kind}-${dir}`,
          frames: this.anims.generateFrameNumbers(`${this.profile.charId}-${kind}`, {
            start: row * 6,
            end: row * 6 + 5,
          }),
          frameRate: kind === 'idle' ? 6 : 10,
          repeat: -1,
        });
      }
    }
  }

  private connect(): void {
    this.socket = io(`${SERVER_URL}/patient`, { auth: { token: this.token } });

    this.socket.on(
      'presence:self',
      (p: { zone: string | null; waitingRank: number; estimatedWaitSec: number }) => {
        this.lastSelf = p;
        this.setHud(p);
        if (p.zone) this.walkToZone(p.zone); // 이동은 즉시, 글자만 늦게 바뀐다
      },
    );

    this.socket.on('zone:occupancy', (p: { zoneId: string; anonymousCount: number }) => {
      // 표시 중인 구역의 인원수만 (스쳐간 방 인원수가 떠도 혼란스럽다)
      if (this.zoneDwell.peek('me') !== p.zoneId) return;
      const zone = this.zones.get(p.zoneId);
      const el = document.getElementById('hud-sub');
      if (el && zone) el.textContent = `${zone.name}에 ${p.anonymousCount}명`;
      this.showOthers(p.zoneId, p.anonymousCount - 1); // 본인 제외
    });

    this.socket.on('zone:actions', (_actions: ZoneAction[]) => {
      // TODO Phase 4: 구역 액션 버튼 (체크인 등) — 설계서 6.4
    });

    this.socket.on('connect_error', (err) => console.error('[ws] connect error:', err.message));
  }

  private setHud(
    p: { zone: string | null; waitingRank: number; estimatedWaitSec: number } | null,
  ): void {
    const who = document.getElementById('hud-who')!;
    const where = document.getElementById('hud-where')!;
    const sub = document.getElementById('hud-sub')!;
    who.textContent = this.profile.nickname ? `${this.profile.nickname} 님` : '안내';
    if (!p) {
      where.textContent = '위치를 확인하는 중…';
      return;
    }
    // 표시는 '머문 것이 확인된' 구역 기준
    const settled = this.zoneDwell.update('me', p.zone);
    const zone = settled ? this.zones.get(settled) : null;
    where.textContent = zone ? zone.name : '추적 구역 밖';
    // 대기 순번이 있을 때만 이 줄을 쓴다 — 없으면 zone:occupancy 가 채운 인원수를 남긴다
    if (p.waitingRank > 0) {
      sub.textContent = `대기 순번 ${p.waitingRank}번 · 예상 ${Math.round(p.estimatedWaitSec / 60)}분`;
    }
  }

  /**
   * 같은 방의 다른 손님을 인원수만큼 세운다.
   * 좌표를 받은 게 아니라 **인원수로 만든 표현**이므로, 방 안쪽 통행 가능한 자리에
   * 정해진 순서대로 배치한다 (매번 자리가 바뀌면 사람이 순간이동하는 것처럼 보인다).
   */
  private showOthers(zoneId: string, count: number): void {
    const zone = this.zones.get(zoneId);
    const n = Math.max(0, Math.min(count, 6)); // 너무 많으면 방이 가득 차 보인다
    if (!zone) return;

    while (this.others.length > n) this.others.pop()?.destroy();
    while (this.others.length < n) {
      const i = this.others.length;
      // 황금각으로 흩뿌려 같은 자리에 겹치지 않게
      const angle = i * 2.399;
      const radius = 40 + i * 14;
      const spot = this.pf.nearestWalkable(
        zone.tilePosition.x + Math.cos(angle) * radius,
        zone.tilePosition.y + Math.sin(angle) * radius,
      );
      const sprite = this.add
        .sprite(this.m(spot.x), this.m(spot.y), 'adam-idle')
        .setOrigin(0.5, 0.85)
        .setAlpha(0.85);
      sprite.play('other-idle');
      sprite.setDepth(-1); // 본인 캐릭터보다 뒤에
      this.others.push(sprite);
    }
    // 방이 바뀌면 자리도 옮긴다
    this.others.forEach((sprite, i) => {
      const angle = i * 2.399;
      const radius = 40 + i * 14;
      const spot = this.pf.nearestWalkable(
        zone.tilePosition.x + Math.cos(angle) * radius,
        zone.tilePosition.y + Math.sin(angle) * radius,
      );
      sprite.setPosition(this.m(spot.x), this.m(spot.y));
    });
  }

  /** 존 라벨 위치까지 벽을 피해 걸어간다 */
  private walkToZone(zoneId: string): void {
    const zone = this.zones.get(zoneId);
    if (!zone) return;
    const dest = this.pf.nearestWalkable(zone.tilePosition.x, zone.tilePosition.y);
    if (this.teleport) {
      this.me.setPosition(this.m(dest.x), this.m(dest.y));
      // 카메라도 같이 붙인다 — follow lerp 로 따라오게 두면 첫 화면이 엉뚱한 곳을 본다
      if (!this.overview) this.cameras.main.centerOn(this.me.x, this.me.y);
      this.path = [];
      this.teleport = false;
      return;
    }
    const from = { x: this.me.x / MAP_SCALE, y: this.me.y / MAP_SCALE };
    const route = this.pf.hasLineOfSight(from.x, from.y, dest.x, dest.y)
      ? [dest]
      : this.pf.findPath(from.x, from.y, dest.x, dest.y) ?? [dest];
    this.path = route.map((p) => ({ x: this.m(p.x), y: this.m(p.y) }));
  }

  update(_time: number, delta: number): void {
    // ⚠️ create() 가 async 라서 Phaser 는 초기화가 끝나기도 전에 이 루프를 돌린다.
    //    아바타가 아직 없을 때 건드리면 매 프레임 예외가 나고 렌더 루프째로 죽는다
    //    (= 화면이 통째로 비어 보인다. 실제로 그렇게 신고됨)
    if (!this.me) return;

    let remaining = (WALK_PX_PER_SEC * delta) / 1000;
    let moved = false;

    while (remaining > 0 && this.path.length > 0) {
      const wp = this.path[0];
      const dx = wp.x - this.me.x;
      const dy = wp.y - this.me.y;
      const dist = Math.hypot(dx, dy);

      if (this.path.length === 1 && dist <= ARRIVE_EPS) {
        this.path.shift();
        break;
      }
      // 진행 방향에 맞는 애니메이션
      this.facing =
        Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up';
      moved = true;

      if (dist <= remaining) {
        this.me.setPosition(wp.x, wp.y);
        remaining -= dist;
        this.path.shift();
        continue;
      }
      this.me.setPosition(this.me.x + (dx / dist) * remaining, this.me.y + (dy / dist) * remaining);
      remaining = 0;
    }

    const want = `${moved ? 'run' : 'idle'}-${this.facing}`;
    if (this.me.anims.currentAnim?.key !== want) this.me.play(want, true);
    this.nameTag?.setPosition(this.me.x, this.me.y + 6);
  }
}

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'app',
  backgroundColor: '#0e1420',
  pixelArt: true, // 도트 그래픽: 텍스처 필터를 nearest 로 (선명함은 이게 담당)
  scale: {
    mode: Phaser.Scale.RESIZE,
    width: window.innerWidth,
    height: window.innerHeight,
  },
  scene: [PatientScene],
});
(window as unknown as Record<string, unknown>).__game = game; // 디버깅용 (직원용과 동일)
