import Phaser from 'phaser';
import { io, type Socket } from 'socket.io-client';
import {
  ARRIVE_EPS_PX,
  UpdateClock,
  ZoneDwellFilter,
  ZONE_DWELL_MS,
  paceForPath,
  pathLengthPx,
} from '@meditracker/shared';
import type { FloorplanMeta, PatientProfile, Zone, ZoneAction } from '@meditracker/shared';
import { demoSocket, localConfigUrl, markDemoUi, resolveZones } from './demo-mode';
import { Pathfinder, type WalkableGrid } from './pathfinder';
import { Crowd, type CrowdUnit } from './crowd';
import { poseFor, sittableAt } from './pose';
import { composeSheet, decodeChoice, isComposed, type Manifest } from './char-builder';
import { mountCharPicker } from './char-picker';
import { GuideLayer } from './guide-layer';

/** 익명 id → 캐릭터 고르기용 (같은 사람은 늘 같은 캐릭터로 보이게) */
function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

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

/**
 * 서버 주소. 끝 슬래시를 떼므로 `VITE_SERVER_URL=/` 이면 빈 문자열 = **같은 도메인**이 된다
 * (서버가 화면까지 서빙하는 배포 구성). 이 화면은 `/patient/` 아래에 얹히지만 API 는
 * 루트 기준 절대경로(`/floorplan`)로 부르므로 base 와 무관하게 맞는다.
 */
const SERVER_URL = (import.meta.env.VITE_SERVER_URL ?? 'http://localhost:8080').replace(/\/+$/, '');

/**
 * public/ 자원(도트맵·캐릭터)의 앞머리.
 *
 * 이 화면은 개발 때는 루트(5174), 배포 때는 서버의 `/patient/` 아래에 얹힌다.
 * `/pixelmap.png` 처럼 루트 절대경로로 적으면 배포에서 직원용 쪽을 뒤져 404 가 난다.
 * Vite 가 base 를 넣어 주는 `BASE_URL` 을 붙여야 두 경우 모두 맞는다.
 * (API 는 반대로 항상 루트 기준이라 SERVER_URL 을 쓴다 — 서로 다른 주소다.)
 */
const ASSETS = import.meta.env.BASE_URL;

// 시연 모드(서버 없는 정적 호스팅) 지원 — 아래 DEMO 플래그로 갈린다

/**
 * pixelmap.png 은 도면의 몇 배인가 — build-pixel-map.py 의 MAP_SCALE 과 같아야 한다.
 * 타일 1칸(16px) = 도면 32px ≈ 52cm 이라 캐릭터(16x32)가 두 칸 키로 선다.
 */
const MAP_SCALE = 0.5;
/** 스프라이트는 맵과 같은 축척이므로 확대하지 않는다 — 확대는 카메라 줌이 담당 */
const CHAR_SCALE = 1;
/**
 * 화면 가로에 타일이 대략 이 개수 보이도록 줌을 정한다 (포켓몬 골드류 타일 탑뷰).
 * 줌과 시야는 상충한다 — 6배면 캐릭터는 크지만 10m×5m 만 보여 주변 사람이 한 명도
 * 안 잡힌다. 다른 사람이 보이는 쪽을 택해 4배(약 15m×8m)로 둔다.
 */
const TILES_ACROSS = 20;
const MAX_ZOOM = 4;
/** 카메라 추종 보간 계수 (0~1). 낮으면 부드럽게 뒤따르고, 1이면 즉시 붙는다 */
const FOLLOW_LERP = 0.08;
/** 내 캐릭터 표시색 — 도면 팔레트(회색·크림·민트·우드·벽돌)에 없는 청록 */
const ME_MARK_COLOR = 0x22d3ee;
/** 머리 위 화살표가 위아래로 흔들리는 폭(px)과 주기(ms) */
const ARROW_BOB_PX = 2.5;
const ARROW_BOB_MS = 900;
const TILE = 16;

// 보행 속도·도착 판정·따라잡기는 @meditracker/shared 의 walk-pacing 이 단일 출처.
// 직원용 패널과 **같은 계산**을 써야 같은 사람이 두 화면에서 같은 자리에 있다.
// (shared 는 도면 px 기준 → 화면 좌표로 쓸 땐 ×MAP_SCALE)
const ARRIVE_EPS = ARRIVE_EPS_PX * MAP_SCALE;

/**
 * 복도(방 사이)를 나타내는 가짜 존 id — zones.json 에 없는 값이어야 한다.
 * 실제 존과 같은 자리에서 다뤄야 표시 안정화가 그대로 재사용된다 (직원용과 동일한 처리).
 */
const TRANSIT_ZONE_ID = '__transit';
const TRANSIT_ZONE_LABEL = '복도 이동 중';
/** 도착 문구를 띄워 두는 시간 — 너무 짧으면 못 보고, 길면 다음 안내를 가린다 */
const GUIDE_DONE_MS = 4000;

const CHARACTERS = [
  { id: 'adam', label: '민준' },
  { id: 'alex', label: '지호' },
  { id: 'amelia', label: '서연' },
  { id: 'bob', label: '준서' },
] as const;

/** 스프라이트 시트 24프레임 = 6프레임 × 4방향 (오른쪽·위·왼쪽·아래 순서) */
const DIR_ROW = { right: 0, up: 1, left: 2, down: 3 } as const;
/**
 * 앉기는 12프레임 = **오른쪽 6 + 왼쪽 6**. 뒤 6장은 앞 6장을 좌우로 뒤집은 것이다
 * (픽셀 단위로 대조해 확인 — 512픽셀 전부 동일). 위·아래를 향해 앉는 그림은 없다.
 * 원본이 32px 프레임에 사람을 16px 폭으로 넣어 둔 것을 추출 때 16px 로 다시 담는다
 * (`tools/build-characters.py`). 그 처리가 없으면 사람이 반으로 쪼개져 보인다.
 */
const SIT_FRAMES = 6;

/** 조합한 내 캐릭터 시트의 텍스처 키 (군중은 기존 4종 시트를 그대로 쓴다) */
const ME_SHEET_KEY = 'me-sheet';
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

/** 서버 없이 브라우저 안에서만 도는 중 (정적 호스팅 시연) — boot() 에서 정해진다 */
let DEMO = false;

async function resolveToken(): Promise<string> {
  const q = new URLSearchParams(window.location.search);
  const urlToken = q.get('token');
  if (urlToken) return urlToken;
  if (DEMO) return 'demo'; // 검사할 서버가 없다 — 자리만 채운다

  // 팔찌 QR 로 들어온 경우 — QR 에는 핀(비콘 뒷 6자리)이 들어 있다
  const pin = q.get('pin');
  if (pin) return claimByPin(pin);

  // 그 외에는 번호를 직접 받는다. QR 은 이 입력을 대신 채워주는 것뿐이라
  // 나중에 QR 을 붙여도 이 화면은 그대로 남는다 (번호가 안 읽히는 팔찌·구형 폰 대비).
  return runPinGate();
}

/**
 * 팔찌 번호 입력 화면.
 *
 * 맞을 때까지 계속 받는다 — 틀렸다고 화면을 닫아버리면 환자는 갈 곳이 없다.
 * 오류는 서버 문구를 그대로 보여준다(없는 번호 / 이미 사용 중 / 아직 등록 안 됨):
 * 데스크에 뭐라고 말해야 할지가 그 문구에 들어 있다.
 */
function runPinGate(): Promise<string> {
  return new Promise((resolve) => {
    const wrap = document.getElementById('pin-gate')!;
    const input = document.getElementById('pin-input') as HTMLInputElement;
    const go = document.getElementById('pin-go') as HTMLButtonElement;
    const err = document.getElementById('pin-err')!;

    // 공백·하이픈은 눈으로 읽어 치다 보면 섞인다. 6자리가 차야 버튼이 열린다
    const clean = (): string => input.value.replace(/[^0-9A-Za-z]/g, '').toUpperCase();
    const sync = (): void => {
      go.disabled = clean().length !== 6;
    };
    input.addEventListener('input', () => {
      err.textContent = '';
      sync();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !go.disabled) go.click();
    });

    go.addEventListener('click', async () => {
      go.disabled = true;
      go.textContent = '확인 중…';
      try {
        const token = await claimByPin(clean());
        wrap.classList.remove('show');
        resolve(token);
      } catch (e) {
        err.textContent = (e as Error).message;
        go.textContent = '입장하기';
        sync();
        input.select();
      }
    });

    wrap.classList.add('show');
    sync();
    input.focus();
  });
}

/**
 * 핀으로 입장. **처음 찍은 기기가 그 팔찌를 차지한다** — 팔찌의 핀은 안 바뀌는데 환자는
 * 바뀌므로, 이게 없으면 예전 환자가 브라우저 기록의 링크로 다음 사람 위치를 본다.
 *
 * 받은 토큰은 주소창에 남긴다(`?pin=` → `?token=`). 새로고침해도 다시 차지하려 들지 않게
 * 하려는 것이다 — 두 번째 요청은 '이미 사용 중' 으로 막히기 때문이다.
 * ⚠️ 불변식 B-5: localStorage 같은 브라우저 저장소는 안 쓴다. 주소는 저장소가 아니다.
 */
async function claimByPin(pin: string): Promise<string> {
  const res = await fetch(`${SERVER_URL}/patient-token`, {
    method: 'POST',
    body: JSON.stringify({ pin }),
  });
  const d = (await res.json()) as { ok: boolean; token?: string; error?: string };
  if (!d.ok || !d.token) throw new Error(d.error ?? '입장할 수 없습니다');
  const url = new URL(window.location.href);
  url.searchParams.delete('pin');
  url.searchParams.set('token', d.token);
  window.history.replaceState(null, '', url.toString());
  return d.token;
}

/**
 * 첫 진입 — 캐릭터를 만들고(1단계) 별명을 받는다(2단계).
 *
 * 두 단계로 나눈 것은 화면 높이 때문만이 아니다. 캐릭터를 다 만든 다음에 이름을
 * 물어야 "이 캐릭터의 이름" 이 된다. 고르는 부분은 `char-picker.ts` 가 맡는다.
 */
function runSetup(token: string, manifest: Manifest | null): Promise<PatientProfile> {
  return new Promise((resolve) => {
    const wrap = document.getElementById('setup')!;
    const title = document.getElementById('cc-title')!;
    const step1 = document.getElementById('cc-step1')!;
    const step2 = document.getElementById('cc-step2')!;
    const nick = document.getElementById('nick') as HTMLInputElement;
    const next = document.getElementById('start') as HTMLButtonElement;
    const go = document.getElementById('go') as HTMLButtonElement;
    const back = document.getElementById('back') as HTMLButtonElement;

    const picker = mountCharPicker(
      ASSETS,
      manifest,
      CHARACTERS.map((c) => c.id),
    );
    wrap.classList.add('show');

    // 미리보기 무대는 두 단계에 걸쳐 그대로 둔다 — 별명을 지을 때도 캐릭터가 보여야 한다
    const step = (second: boolean): void => {
      step1.hidden = second;
      step2.hidden = !second;
      title.textContent = second ? '별명 정하기' : '내 캐릭터 만들기';
      if (second) nick.focus();
    };
    next.addEventListener('click', () => step(true));
    back.addEventListener('click', () => step(false));

    go.addEventListener('click', async () => {
      go.disabled = true;
      const charId = picker.charId();
      // 시연 모드는 저장할 서버가 없다 — 고른 값은 이 페이지에만 남는다
      // (⚠️ 불변식 B-5: 브라우저 스토리지 금지 → 새로고침하면 다시 만든다)
      if (!DEMO) {
        go.textContent = '저장 중…';
        await fetch(`${SERVER_URL}/patient-profile`, {
          method: 'POST',
          body: JSON.stringify({ token, charId, nickname: nick.value }),
        });
      }
      picker.stop();
      wrap.classList.remove('show');
      resolve({ charId, nickname: nick.value.trim() || null });
    });
  });
}

class PatientScene extends Phaser.Scene {
  private socket!: Socket;
  /** 서버 없이 브라우저 안에서 가짜 좌표를 만들어 쓰는 중 */
  private demo = false;
  private zones = new Map<string, Zone>();
  private pf!: Pathfinder;
  private me!: Phaser.GameObjects.Sprite;
  private nameTag?: Phaser.GameObjects.Text;
  /** 내 캐릭터 강조 — 발밑 링과 머리 위 화살표 (겹쳐도 내가 누군지 보이게) */
  private meRing?: Phaser.GameObjects.Ellipse;
  /** 방 안내 — 목적지까지 바닥에 깔리는 빨간 화살표 */
  private guide?: GuideLayer;
  private meArrow?: Phaser.GameObjects.Triangle;
  private profile!: PatientProfile;
  /** 조합 시트의 동작별 [시작 프레임, 개수] — charparts/manifest.json 에서 온다 */
  private meFrames: Record<string, [number, number]> = {};
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
  private lastSelf?: {
    zone: string | null;
    waitingRank: number;
    estimatedWaitSec: number;
    inTransit?: boolean;
  };
  /** 다른 사람들 (직원용 화면과 같은 좌표를 익명으로 받아 그린다) */
  private crowd?: Crowd;
  /** 본인 실좌표를 마지막으로 받은 시각 — 이게 흐르면 존 중앙 스냅을 쓰지 않는다 */
  private lastPosAt = 0;
  /**
   * 직전 서버 좌표 (도면). 경로를 캐릭터의 현재 위치가 아니라 여기서부터 계산한다 —
   * 캐릭터 위치에서 재면 직원용 패널과 A* 입력이 달라져 다른 문으로 돌아간다.
   */
  private lastPoint?: { x: number; y: number };
  /** 이번 구간 보행 속도 (도면 px/초). 다음 좌표가 올 때쯤 도착하도록 매 구간 다시 정한다 */
  private pace = 0;
  /** 좌표 브로드캐스트 주기 관측 — 본인(pos:self)과 다른 사람들(crowd)이 같이 쓴다 */
  private posClock = new UpdateClock();

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
    this.load.image('pixelmap', `${ASSETS}pixelmap.png`);
    for (const c of CHARACTERS) {
      // 포즈 4종 모두 (한 장 3~6KB). sit·phone 은 머무는 사람에게 쓴다 —
      // 대기실에 전원이 서 있으면 그것만으로 화면이 어색하다.
      for (const pose of ['idle', 'run', 'sit', 'phone'] as const) {
        this.load.spritesheet(`${c.id}-${pose}`, `${ASSETS}characters/${c.id}-${pose}.png`, {
          frameWidth: 16,
          frameHeight: 32,
        });
      }
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
    // 존 목록을 서버에서 받아 보고, 안 되면 시연 모드 — 도면·존·벽은 고정 파일이라
    // 빌드에 든 사본을 쓴다
    const source = await resolveZones(SERVER_URL);
    this.demo = DEMO;
    const from = (route: string, local: string): string =>
      DEMO ? localConfigUrl(local) : `${SERVER_URL}${route}`;

    this.token = TOKEN;
    const [plan, zones, grid, staffArea] = await Promise.all([
      fetch(from('/floorplan', 'floorplan')).then((r) => r.json() as Promise<FloorplanMeta>),
      Promise.resolve(source.zones),
      fetch(from('/walkable', 'walkable')).then((r) => r.json() as Promise<WalkableGrid>),
      // 직원 전용 구역 — 안내 경로가 여길 지나지 않게 돌아가는 데만 쓴다.
      // 없어도(예전 배포) 동작해야 하므로 실패는 조용히 넘긴다
      fetch(from('/staff-area', 'staff-area'))
        .then((r) => (r.ok ? (r.json() as Promise<WalkableGrid>) : null))
        .catch(() => null),
    ]);
    this.plan = plan;
    this.pf = new Pathfinder(grid);
    this.pf.setAvoidMask(staffArea);
    for (const z of zones) this.zones.set(z.zoneId, z);

    // 캐릭터는 이 화면이 뜨기 전에 이미 다 만들어져 있다 (main 참고)
    this.profile = PROFILE;
    this.meFrames = ME_FRAMES;
    if (ME_SHEET) {
      this.textures.addSpriteSheet(ME_SHEET_KEY, ME_SHEET as unknown as HTMLImageElement, {
        frameWidth: 16,
        frameHeight: 32,
      });
    }

    this.makeAnims();

    // 픽셀맵은 타일 경계까지 채워져 도면 크기보다 조금 클 수 있다 → 텍스처 실측값을 쓴다
    const src = this.textures.get('pixelmap').getSourceImage();
    this.mapW = src.width;
    this.mapH = src.height;
    if (!this.mapW || !this.mapH) {
      throw new Error('pixelmap.png 을 불러오지 못했습니다 (tools/build-pixel-map.py 로 생성)');
    }
    this.add.image(0, 0, 'pixelmap').setOrigin(0, 0).setDepth(0); // 그리기 층: 배경 0
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
      .sprite(this.m(start.tilePosition.x), this.m(start.tilePosition.y), this.meSheetKey())
      .setScale(CHAR_SCALE)
      .setOrigin(0.5, 0.85) // 발끝이 좌표에 오도록
      .setDepth(2); // 다른 사람(1) 위
    this.me.play('idle-down');

    // 방 안내 화살표는 바닥(0) 위, 사람(1) 아래에 깔린다
    this.guide = new GuideLayer({
      scene: this,
      pf: this.pf,
      zones: this.zones,
      scale: MAP_SCALE,
      depth: 0.5,
    });

    // 사람이 겹쳐도 내 캐릭터를 바로 찾을 수 있게 — 발밑 링 + 머리 위 화살표.
    // 도면 팔레트(회색·크림·우드·벽돌)에 없는 청록이라 어느 바닥에서도 눈에 띈다.
    this.meRing = this.add
      .ellipse(this.me.x, this.me.y, 16, 7, ME_MARK_COLOR, 0.5)
      .setStrokeStyle(1, ME_MARK_COLOR, 0.9)
      .setDepth(1.5); // 다른 사람(1) 위, 내 캐릭터(2) 아래
    this.meArrow = this.add
      .triangle(this.me.x, this.me.y, 0, 0, 8, 0, 4, 7, ME_MARK_COLOR)
      .setStrokeStyle(1, 0x0d1520, 0.6)
      .setDepth(3);

    if (this.profile.nickname) {
      this.nameTag = this.add
        .text(this.me.x, this.me.y + 4, this.profile.nickname, {
          fontFamily: 'sans-serif',
          fontSize: '12px',
          color: '#0d1520',
          backgroundColor: '#ffffffdd',
          padding: { x: 4, y: 1 },
        })
        .setOrigin(0.5, 0)
        .setDepth(3);
    }

    this.applyZoom(this.followZoom());
    this.cameras.main.startFollow(this.me, false, FOLLOW_LERP, FOLLOW_LERP);
    this.cameras.main.centerOn(this.me.x, this.me.y); // lerp 수렴을 기다리면 첫 화면이 빈 구석이다
    // 창 크기가 바뀌면 줌을 다시 계산 (보이는 타일 수를 일정하게)
    this.scale.on('resize', (size: Phaser.Structs.Size) => {
      this.cameras.resize(size.width, size.height);
      if (!this.overview) this.applyZoom(this.followZoom());
    });
    // 다른 사람들 (직원용과 같은 좌표 — 도트 스킨만 다름)
    this.crowd = new Crowd({
      scene: this,
      pf: this.pf,
      mapScale: MAP_SCALE,
      arriveEps: ARRIVE_EPS,
      // 본인 캐릭터와 같은 주기 관측을 공유한다 (같은 브로드캐스트로 움직이므로)
      clock: this.posClock,
      // 익명 id 로 캐릭터를 흩뿌린다 (직원은 늘 같은 캐릭터로 통일해 구분되게)
      sheetFor: (u) =>
        u.kind === 'staff'
          ? 'bob'
          : CHARACTERS[Math.abs(hashCode(u.id)) % CHARACTERS.length].id,
      animFor: (sheet, moving, unit) =>
        `${sheet}-c-${poseFor(this.zones.values(), unit.id, moving, unit.x, unit.y)}`,
    });

    this.setupOverviewButton();
    this.setHud(null);
    /**
     * 머문 시간이 차면 안내 문구를 바꾼다 — 이벤트가 안 와도 주기적으로 재평가해야 한다.
     * ⚠️ Phaser 시계(this.time)에 걸면 안 된다: 렌더 루프에 묶여 있어서 프레임이 멈추면
     *    (탭 백그라운드 등) 시계도 멈추고 구역 이름이 영원히 안 바뀐다(실제로 그랬다).
     *    HUD 는 DOM 이니 브라우저 타이머로 돌린다.
     */
    const hudTimer = window.setInterval(() => this.setHud(this.lastSelf ?? null), 500);
    this.events.once('shutdown', () => window.clearInterval(hudTimer));

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

  /**
   * 줌을 바꾸고 이름표 크기를 되돌린다.
   * 텍스트도 카메라 줌에 같이 확대돼서, 줌 4배면 12px 글씨가 48px 로 나와
   * 캐릭터보다 커진다 → 줌의 역수로 축소해 화면상 크기를 일정하게 유지한다.
   */
  private applyZoom(zoom: number): void {
    this.cameras.main.setZoom(zoom);
    this.nameTag?.setScale(1 / zoom);
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
        this.applyZoom(Math.min(this.scale.width / this.mapW, this.scale.height / this.mapH));
        cam.centerOn(this.mapW / 2, this.mapH / 2);
      } else {
        this.applyZoom(this.followZoom());
        cam.startFollow(this.me, false, FOLLOW_LERP, FOLLOW_LERP);
      }
      btn.textContent = this.overview ? '📍 내 위치' : '🗺 전체 보기';
      btn.classList.toggle('on', this.overview);
    };
  }

  /**
   * 합성 시트를 실제로 만들었는가.
   *
   * 조합형 프로필인데 그 기기에 파츠가 없을 수 있다 — 파츠는 재배포 금지라 기기마다
   * 따로 만들고, 공개 시연판에는 아예 없다. 그때 조합형인 것만 보고 없는 텍스처를
   * 집으면 캐릭터 자리에 초록 네모가 뜬다.
   */
  private composed(): boolean {
    return isComposed(this.profile.charId) && this.textures.exists(ME_SHEET_KEY);
  }

  /** 내 캐릭터가 쓸 텍스처. 합성이 안 됐으면 고정 4종의 첫 번째로 대신한다 */
  private meSheetKey(): string {
    if (this.composed()) return ME_SHEET_KEY;
    const fallback = isComposed(this.profile.charId) ? CHARACTERS[0].id : this.profile.charId;
    return `${fallback}-idle`;
  }

  private makeAnims(): void {
    // 다른 사람들용 — 캐릭터 4종 모두. 정면 idle + 우향 걷기(왼쪽은 flipX)
    for (const c of CHARACTERS) {
      this.anims.create({
        key: `${c.id}-c-idle`,
        frames: this.anims.generateFrameNumbers(`${c.id}-idle`, { start: 18, end: 23 }),
        frameRate: 5,
        repeat: -1,
      });
      this.anims.create({
        key: `${c.id}-c-walk`,
        frames: this.anims.generateFrameNumbers(`${c.id}-run`, { start: 0, end: 5 }),
        frameRate: 10,
        repeat: -1,
      });
      // ⚠️ 앉기는 걷기와 배치가 다르다 — 4방향이 아니라 **오른쪽 6 + 왼쪽 6**(총 12)이다.
      //    걷기와 같다고 보고 18~23 을 집으면 없는 프레임이라 아무것도 안 나온다.
      //    군중은 방향을 추적하지 않으므로 오른쪽 벌만 쓴다.
      this.anims.create({
        key: `${c.id}-c-sit`,
        frames: this.anims.generateFrameNumbers(`${c.id}-sit`, { start: 0, end: SIT_FRAMES - 1 }),
        frameRate: 4,
        repeat: -1,
      });
      // 폰 시트는 9프레임 단일 방향이라 방향 개념이 없다 (그래서 본인 캐릭터엔 안 쓴다)
      this.anims.create({
        key: `${c.id}-c-phone`,
        frames: this.anims.generateFrameNumbers(`${c.id}-phone`, { start: 0, end: 8 }),
        frameRate: 6,
        repeat: -1,
      });
    }
    // 조합 시트는 네 동작이 한 장에 이어져 있어 시작 프레임만 다르다.
    // 예전 고정 캐릭터는 동작마다 파일이 나뉘어 있으므로 키와 오프셋이 둘 다 달라진다.
    const composed = this.composed();
    const base0 = this.meSheetKey().replace(/-idle$/, '');
    const sheet = (kind: 'idle' | 'run' | 'sit'): string =>
      composed ? ME_SHEET_KEY : `${base0}-${kind}`;
    const base = (kind: 'idle' | 'run' | 'sit'): number =>
      composed ? this.meFrames[kind === 'run' ? 'walk' : kind][0] : 0;

    for (const [dir, row] of Object.entries(DIR_ROW)) {
      for (const kind of ['idle', 'run'] as const) {
        this.anims.create({
          key: `${kind}-${dir}`,
          frames: this.anims.generateFrameNumbers(sheet(kind), {
            start: base(kind) + row * 6,
            end: base(kind) + row * 6 + 5,
          }),
          frameRate: kind === 'run' ? 10 : 6,
          repeat: -1,
        });
      }
    }
    // 앉기는 좌·우 두 벌뿐이다. 위·아래로 걷다 앉으면 오른쪽 것을 쓴다.
    for (const [dir, half] of [['right', 0] as const, ['left', 1] as const]) {
      this.anims.create({
        key: `sit-${dir}`,
        frames: this.anims.generateFrameNumbers(sheet('sit'), {
          start: base('sit') + half * SIT_FRAMES,
          end: base('sit') + half * SIT_FRAMES + SIT_FRAMES - 1,
        }),
        frameRate: 4,
        repeat: -1,
      });
    }
  }

  private connect(): void {
    // 시연 모드에서는 같은 모양의 가짜 소켓이 들어온다 — 아래 핸들러는 그대로 돈다
    this.socket = this.demo
      ? (demoSocket([...this.zones.values()]) as unknown as Socket)
      : io(`${SERVER_URL}/patient`, { auth: { token: this.token } });

    // 탭이 백그라운드였다 돌아오면 걷지 말고 진실 좌표로 바로 붙인다 (직원용 패널과 동일)
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      if (this.lastPoint && this.me) {
        this.me.setPosition(this.m(this.lastPoint.x), this.m(this.lastPoint.y));
        this.path = [];
        if (!this.overview) this.cameras.main.centerOn(this.me.x, this.me.y);
      }
      this.crowd?.snapAll();
    });

    this.socket.on(
      'presence:self',
      (p: { zone: string | null; waitingRank: number; estimatedWaitSec: number }) => {
        this.lastSelf = p;
        this.setHud(p);
        // 실좌표(pos:self)가 흐르는 동안은 존 중앙으로 끌어당기지 않는다.
        // 좌표가 아직 없을 때(접속 직후)만 방 위치로 우선 배치한다.
        if (p.zone && Date.now() - this.lastPosAt > 8000) this.walkToZone(p.zone);
      },
    );

    this.socket.on('zone:occupancy', (p: { zoneId: string; anonymousCount: number }) => {
      // 표시 중인 구역의 인원수만 (스쳐간 방 인원수가 떠도 혼란스럽다)
      if (this.zoneDwell.peek('me') !== p.zoneId) return;
      const zone = this.zones.get(p.zoneId);
      const el = document.getElementById('hud-sub');
      if (el && zone) el.textContent = `${zone.name}에 ${p.anonymousCount}명`;
    });

    // 본인 비콘의 실좌표 — 직원용 화면의 내 점과 같은 지점으로 걸어간다.
    // (존 중앙 스냅은 좌표가 없을 때의 대체 수단일 뿐이다)
    type SelfPos = { x: number; y: number; zone: string | null; inTransit?: boolean };
    this.socket.on('pos:self', (p: SelfPos) => {
      this.lastPosAt = Date.now();
      // 주기 관측은 브로드캐스트당 한 번 — pos:self 는 태그 하나뿐이라 여기가 그 지점
      this.posClock.tick();
      // 직전 서버 좌표에서 경로를 잰다 → 직원용 패널과 반드시 같은 경로
      this.walkToPoint(p.x, p.y, this.lastPoint);
      this.lastPoint = { x: p.x, y: p.y };
      // 이 이벤트가 현재 구역도 함께 들고 온다 (3.5초마다 반드시 온다) → 안내 문구의
      // 기준을 이걸로 삼는다. presence:self 는 구역이 바뀔 때만 오므로 그것만 보면
      // 머문 시간이 차도 재평가 기회가 없다.
      this.lastSelf = {
        zone: p.zone,
        inTransit: p.inTransit,
        waitingRank: this.lastSelf?.waitingRank ?? 0,
        estimatedWaitSec: this.lastSelf?.estimatedWaitSec ?? 0,
      };
      this.setHud(this.lastSelf);
    });

    // 다른 사람들의 위치 — 직원용과 같은 좌표. 익명 id·좌표·손님/직원 구분만 온다
    this.socket.on('crowd:positions', (units: CrowdUnit[]) => this.crowd?.sync(units));

    // 직원이 건 방 안내 — 나에게만 온다. null 이면 해제(도착했거나 직원이 껐거나)
    this.socket.on('guide:set', (g: { zoneId: string } | null) => {
      this.guide?.setTarget(g?.zoneId ?? null);
      this.setGuideBar(g?.zoneId ?? null);
      this.setHud(this.lastSelf ?? null);
    });

    this.socket.on('zone:actions', (_actions: ZoneAction[]) => {
      // TODO Phase 4: 구역 액션 버튼 (체크인 등) — 설계서 6.4
    });

    this.socket.on('connect_error', (err) => console.error('[ws] connect error:', err.message));
  }

  /**
   * 상단 안내 띠 — 화살표만으로는 "어디로 가라는 건지" 를 못 읽는다.
   * 도착하면(zoneId=null) 잠깐 '도착했습니다' 를 남기고 사라진다.
   */
  private setGuideBar(zoneId: string | null): void {
    const bar = document.getElementById('guide-bar')!;
    if (zoneId) {
      const zone = this.zones.get(zoneId);
      bar.innerHTML = `<b>${zone ? zone.name : zoneId}</b> 으로 가주세요`;
      bar.className = 'show';
      return;
    }
    if (!bar.classList.contains('show')) return; // 애초에 안내 중이 아니었다
    bar.innerHTML = '<b>도착했습니다</b>';
    bar.className = 'show done';
    window.setTimeout(() => {
      if (bar.classList.contains('done')) bar.className = '';
    }, GUIDE_DONE_MS);
  }

  private setHud(
    p: {
      zone: string | null;
      waitingRank: number;
      estimatedWaitSec: number;
      inTransit?: boolean;
    } | null,
  ): void {
    const who = document.getElementById('hud-who')!;
    const where = document.getElementById('hud-where')!;
    const sub = document.getElementById('hud-sub')!;
    who.textContent = this.profile.nickname ? `${this.profile.nickname} 님` : '안내';
    if (!p) {
      where.textContent = '위치를 확인하는 중…';
      return;
    }
    /**
     * 표시는 '머문 것이 확인된' 구역 기준.
     * 복도(방 사이)는 게이트웨이가 없어 판정이 옆방 이름을 찍으므로, 가짜 존 id 를 끼워
     * 넣어 방과 동등하게 다룬다 — 그래야 복도로 나가는 순간 안내가 정직해진다.
     */
    const settled = this.zoneDwell.update('me', p.inTransit ? TRANSIT_ZONE_ID : p.zone);
    if (settled === TRANSIT_ZONE_ID) {
      where.textContent = TRANSIT_ZONE_LABEL;
    } else {
      const zone = settled ? this.zones.get(settled) : null;
      where.textContent = zone ? zone.name : '추적 구역 밖';
    }
    // 대기 순번이 있을 때만 이 줄을 쓴다 — 없으면 zone:occupancy 가 채운 인원수를 남긴다
    if (p.waitingRank > 0) {
      sub.textContent = `대기 순번 ${p.waitingRank}번 · 예상 ${Math.round(p.estimatedWaitSec / 60)}분`;
    }
  }

  /** 존 라벨 위치까지 (좌표가 아직 없을 때의 대체 수단) */
  private walkToZone(zoneId: string): void {
    const zone = this.zones.get(zoneId);
    if (zone) this.walkToPoint(zone.tilePosition.x, zone.tilePosition.y);
  }

  /**
   * 도면 좌표 한 점까지 벽을 피해 걸어간다 (본인 비콘 실좌표가 여기로 들어온다).
   *
   * @param from 경로 출발점. 서버 좌표로 움직일 때는 **직전 서버 좌표**를 넘긴다 —
   *   그래야 직원용 패널과 A* 입력이 같아져 같은 경로가 나온다. 존 스냅처럼 서버
   *   좌표가 없을 때만 생략해 캐릭터 위치를 쓴다.
   */
  private walkToPoint(fx: number, fy: number, from?: { x: number; y: number }): void {
    const dest = this.pf.nearestWalkable(fx, fy);
    const cur = { x: this.me.x / MAP_SCALE, y: this.me.y / MAP_SCALE };
    if (this.teleport) {
      this.me.setPosition(this.m(dest.x), this.m(dest.y));
      // 카메라도 같이 붙인다 — follow lerp 로 따라오게 두면 첫 화면이 엉뚱한 곳을 본다
      if (!this.overview) this.cameras.main.centerOn(this.me.x, this.me.y);
      this.path = [];
      this.teleport = false;
      return;
    }
    const start = from ?? cur;
    const routeFrom = (fx: number, fy: number): Array<{ x: number; y: number }> =>
      this.pf.hasLineOfSight(fx, fy, dest.x, dest.y)
        ? [dest]
        : (this.pf.findPath(fx, fy, dest.x, dest.y) ?? [dest]);

    let route = routeFrom(start.x, start.y);
    // 캐릭터와 경로 시작점 사이가 벽으로 막혀 있으면 순간이동시키지 말고 경로를 다시 잡는다
    // (붙여 놓으면 화면에서 벽을 뚫고 순간이동한 것으로 보인다)
    if (route[0] && !this.pf.hasLineOfSight(cur.x, cur.y, route[0].x, route[0].y)) {
      route = routeFrom(cur.x, cur.y);
    }
    this.pace = paceForPath(pathLengthPx(cur, route), this.posClock.intervalMs);
    this.path = route.map((p) => ({ x: this.m(p.x), y: this.m(p.y) }));
  }

  update(_time: number, delta: number): void {
    // ⚠️ create() 가 async 라서 Phaser 는 초기화가 끝나기도 전에 이 루프를 돌린다.
    //    아바타가 아직 없을 때 건드리면 매 프레임 예외가 나고 렌더 루프째로 죽는다
    //    (= 화면이 통째로 비어 보인다. 실제로 그렇게 신고됨)
    if (!this.me) return;

    // 구간마다 다시 정해진 속도 (직원용 패널과 같은 계산 — walk-pacing.ts)
    let remaining = (this.pace * MAP_SCALE * delta) / 1000;
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

    // 본인도 대기실·상담실에 머무르면 앉는다 (폰 자세는 방향이 없어 본인에겐 안 쓴다).
    // lastPoint 가 도면 좌표 — 화면 좌표로 존을 찾으면 축척만큼 어긋난다.
    const still =
      !moved && !!this.lastPoint && sittableAt(this.zones.values(), this.lastPoint.x, this.lastPoint.y);
    // 앉기는 좌·우만 있다 — 위·아래를 보고 있었으면 오른쪽으로 앉힌다
    const want = still
      ? `sit-${this.facing === 'left' ? 'left' : 'right'}`
      : `${moved ? 'run' : 'idle'}-${this.facing}`;
    if (this.me.anims.currentAnim?.key !== want) this.me.play(want, true);
    this.nameTag?.setPosition(this.me.x, this.me.y + 6);
    // 강조 표시는 캐릭터를 옮긴 뒤에 따라붙인다 (먼저 하면 한 프레임 뒤처진다)
    this.meRing?.setPosition(this.me.x, this.me.y);
    this.meArrow?.setPosition(
      this.me.x,
      this.me.y - 30 + Math.sin(_time / ARROW_BOB_MS * Math.PI * 2) * ARROW_BOB_PX,
    );
    // 안내 화살표: 지나온 것은 흐려지고, 남은 것은 목적지 쪽으로 밝기가 흐른다
    this.guide?.update(this.me.x, this.me.y, _time);
    this.crowd?.update(delta); // 다른 사람들도 같은 보행 속도로 좁힌다
  }
}

/**
 * 팔찌 번호부터 받고 나서 게임을 띄운다.
 *
 * **왜 Phaser 보다 먼저인가.** 번호 입력은 순수 DOM 이라 렌더러가 필요 없는데, 씬 안에서
 * 부르면 Phaser 초기화가 실패했을 때(구형 폰·WebGL 차단) 환자가 번호조차 못 넣는다.
 * 화면에는 오류만 남는다. 밖으로 빼면 최소한 입장은 되고, 그 뒤에 실패하면 원인이
 * '지도 렌더링' 으로 좁혀진다.
 */
let TOKEN = '';

/** 만들어 둔 내 캐릭터 — Phaser 가 뜨기 전에 정해진다 */
let PROFILE: PatientProfile;
let ME_SHEET: HTMLCanvasElement | null = null;
let ME_FRAMES: Record<string, [number, number]> = {};

async function main(): Promise<void> {
  const source = await resolveZones(SERVER_URL);
  DEMO = source.demo;
  if (DEMO) markDemoUi();
  TOKEN = await resolveToken();

  // 캐릭터 만들기는 Phaser 를 기다리지 않는다. 순수 DOM + 2D 캔버스라 엔진이 필요 없고,
  // 환자 폰에서 도면·스프라이트가 받아지는 동안 먼저 보여 주는 편이 훨씬 빠르게 느껴진다.
  // 파츠는 기기마다 따로 만든다(재배포 금지) — 없으면 고정 4종으로 떨어진다
  const manifest = await fetch(`${ASSETS}charparts/manifest.json`)
    .then((r) => (r.ok ? (r.json() as Promise<Manifest>) : null))
    .catch(() => null);
  // 저장해 둘 서버가 없으니 시연 모드는 늘 캐릭터 만들기부터 시작한다
  const saved = DEMO
    ? null
    : await fetch(`${SERVER_URL}/patient-profile?token=${encodeURIComponent(TOKEN)}`)
        .then((r) => r.json() as Promise<PatientProfile | null>)
        .catch(() => null);
  PROFILE = saved ?? (await runSetup(TOKEN, manifest));

  // 고른 파츠를 겹쳐 시트 한 장으로. 예전 고정 캐릭터로 저장된 프로필도 있으므로
  // 조합형일 때만 만든다
  const choice = manifest && decodeChoice(PROFILE.charId);
  if (choice && manifest) {
    // 프레임 배치는 manifest 가 원본이다 — 여기 숫자를 따로 적어두면 추출기를 고칠 때
    // 조용히 어긋난다 (앉기 프레임이 반으로 잘렸던 것과 같은 종류의 사고)
    ME_FRAMES = manifest.frames;
    const total = Object.values(manifest.frames).reduce((n, [, c]) => n + c, 0);
    ME_SHEET = await composeSheet(ASSETS, choice, total);
  }
  startGame();
}

function startGame(): void {
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
}

void main().catch((err) => fatal('입장', err));
