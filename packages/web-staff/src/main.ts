import Phaser from 'phaser';
import { io, type Socket } from 'socket.io-client';
import { ZoneDwellFilter, ZONE_DWELL_MS } from '@meditracker/shared';
import type {
  FloorplanMeta,
  MapAnnotation,
  PositionEstimate,
  PresenceState,
  TagGroup,
  TagMetaMap,
  Zone,
} from '@meditracker/shared';
import { Pathfinder, type WalkableGrid } from './pathfinder';
import { groupColor, TagPanel, type TagRow } from './tag-panel';

/**
 * 직원용 화면 (설계서 8) — 실제 도면 배경 방식
 * - 병원 도면(floorplan.png)을 배경으로 그대로 깔아 방 모양·크기·위치가 100% 일치
 * - 존/아바타 좌표는 도면 이미지 픽셀 좌표계 → 동일 변환으로 배치
 * - namespace: /staff — 서버가 권한 필터링한 presence:update 만 수신
 *
 * ⚠️ 불변식 B-5: 브라우저 스토리지(localStorage 등) 사용 금지.
 */

const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? 'http://localhost:8080';

async function resolveToken(): Promise<string> {
  const urlToken = new URLSearchParams(window.location.search).get('token');
  if (urlToken) return urlToken;
  const res = await fetch(`${SERVER_URL}/dev-token?type=staff`);
  return (await res.json()).token;
}

const adminBtn = document.getElementById('admin-btn') as HTMLAnchorElement | null;
if (adminBtn) {
  adminBtn.href = `${SERVER_URL}/monitor?back=${encodeURIComponent(window.location.href)}`;
}

// 환자용 패널은 별 앱(별 포트) — 개발 기본값은 vite --port 5174
const PATIENT_URL = import.meta.env.VITE_PATIENT_URL ?? 'http://localhost:5174';
const patientBtn = document.getElementById('patient-btn') as HTMLAnchorElement | null;
if (patientBtn) patientBtn.href = PATIENT_URL;

// 도면이 거의 정사각형(26700×25700)이라 캔버스도 그 비율에 맞춤 (Scale.FIT 으로 창에 맞게 축소)
const CW = 1120;
const CH = 1120;
const TOP = 40; // 상단 제목 여백
const PAD = 6;

// 그룹 색은 tag-panel.ts 가 단일 출처 — 맵 위 점·목록 아이콘·그룹 버튼이 같은 색을 쓴다

// 걸어가는 느낌: 도면 축척 1px ≈ 1.62cm, 성인 보행 1.4m/s → 약 86 도면px/초
const WALK_PX_PER_SEC = 86;
/** 이 거리 안이면 도착으로 간주 — RSSI 노이즈로 제자리 떨림 방지 */
const ARRIVE_EPS_PX = 12;

// 방 이름 라벨 — 방 폭에 맞춰 크기를 정한다 (좁은 방은 줄여서라도 방 안에 넣는다)
const NAME_FONT = 'sans-serif';
const NAME_SIZE_MAX = 14;
const NAME_SIZE_MIN = 9;
const NAME_PAD_X = 4;
/** 이보다 큰 영역은 '방'이 아니라 로비·복도 → 중앙 정렬하지 않고 도면 라벨 위치를 그대로 쓴다 */
const ROOM_MAX_PX = 420;
/** 방 중앙으로 옮길 수 있는 최대 거리 (도면 px ≈ 1m). 폭 측정이 문틈으로 샜을 때의 안전장치 */
const NAME_MAX_SHIFT_PX = 60;

class StaffMapScene extends Phaser.Scene {
  private socket!: Socket;
  private zones = new Map<string, Zone>();
  private avatars = new Map<string, Phaser.GameObjects.Container>();
  private avatarLabels = new Map<string, Phaser.GameObjects.Text>();
  private lastPosAt = new Map<string, number>();
  private tagMeta: TagMetaMap = {};
  /** 왼쪽 목록에 쓸 태그별 상태 (존·체류시각·마지막 신호) */
  private states = new Map<string, PresenceState>();
  /** 아바타의 색을 바꿀 수 있게 원(테두리·후광) 참조를 들고 있는다 (그룹 변경 시 recolor) */
  private avatarDots = new Map<string, { halo: Phaser.GameObjects.Arc; dot: Phaser.GameObjects.Arc }>();
  private panel!: TagPanel;
  private pickedTag?: string;
  private pickRing?: Phaser.GameObjects.Arc;
  /** 아바타별 남은 경로 (도면 좌표 waypoint) — 벽을 피해 문으로 돌아간다 */
  private paths = new Map<string, Array<{ x: number; y: number }>>();
  /** 즉시 배치할 태그 (최초 등장·자리비움) — 걷지 않고 순간 이동 */
  private teleport = new Set<string>();
  private pf!: Pathfinder;
  private blockedOverlay?: Phaser.GameObjects.Image;
  /** 방 이름 라벨 묶음 — 버튼으로 통째 토글 */
  private nameLayer?: Phaser.GameObjects.Container;
  /** 라벨 폭 계산용 (화면에 그리지 않는 캔버스) */
  private measureCtx = document.createElement('canvas').getContext('2d')!;
  /**
   * 목록에 쓸 '구역' 안정화 — 복도를 지나가며 스치는 방까지 글자로 반영하면
   * 현황이 계속 바뀌어 읽을 수 없다. 아바타 이동은 그대로 실시간이다.
   * (관제 페이지는 원본을 봐야 하므로 여기서만 적용)
   */
  private zoneDwell = new ZoneDwellFilter(ZONE_DWELL_MS);

  private plan!: FloorplanMeta;
  private worldScale = 1;
  private offX = 0;
  private offY = 0;
  private absentPt = { x: CW - 62, y: 22 }; // 도면 밖 우상단

  constructor() {
    super('staff-map');
  }

  /** 도면 이미지 픽셀 → 화면 좌표 */
  private sx(x: number): number {
    return this.offX + x * this.worldScale;
  }
  private sy(y: number): number {
    return this.offY + y * this.worldScale;
  }

  async create(): Promise<void> {
    this.add.text(16, 12, 'MediTracker — 직원용 (고트의원 6F)', {
      color: '#ffffff',
      fontSize: '18px',
      fontStyle: 'bold',
    });

    const [plan, zones, meta, grid] = await Promise.all([
      fetch(`${SERVER_URL}/floorplan`).then((r) => r.json() as Promise<FloorplanMeta>),
      fetch(`${SERVER_URL}/zones`).then((r) => r.json() as Promise<Zone[]>),
      fetch(`${SERVER_URL}/tag-meta`).then((r) => r.json() as Promise<TagMetaMap>),
      fetch(`${SERVER_URL}/walkable`).then((r) => r.json() as Promise<WalkableGrid>),
    ]);
    this.plan = plan;
    this.tagMeta = meta;
    this.pf = new Pathfinder(grid);
    for (const z of zones) this.zones.set(z.zoneId, z);

    // 도면 배경을 캔버스에 fit (비율 유지, 중앙 정렬)
    this.worldScale = Math.min((CW - 2 * PAD) / plan.width, (CH - TOP - PAD) / plan.height);
    this.offX = (CW - plan.width * this.worldScale) / 2;
    this.offY = TOP + (CH - TOP - PAD - plan.height * this.worldScale) / 2;

    await this.loadPlanImage(plan.image);
    this.add
      .image(this.offX, this.offY, 'plan')
      .setOrigin(0, 0)
      .setDisplaySize(plan.width * this.worldScale, plan.height * this.worldScale);

    // 통제구역(벽·계단·엘리베이터 샤프트) 오버레이 — 버튼으로 토글
    const oc = this.pf.makeOverlayCanvas();
    this.textures.addCanvas('blocked', oc);
    this.blockedOverlay = this.add
      .image(this.offX, this.offY, 'blocked')
      .setOrigin(0, 0)
      .setDisplaySize(plan.width * this.worldScale, plan.height * this.worldScale)
      .setVisible(false);
    this.setupOverlayToggle();

    // 방 이름 (아바타보다 먼저 만들어 아바타가 위에 그려지게)
    this.drawNames(zones, plan.annotations ?? []);
    this.setupNameToggle();

    // 자리비움 표시 (도면 밖 우상단)
    this.add
      .text(this.absentPt.x, this.absentPt.y - 16, '자리비움', { color: '#888888', fontSize: '11px' })
      .setOrigin(0.5, 1);

    // 왼쪽 비콘 목록 (DOM) — 이름·메모 편집은 여기서
    this.panel = new TagPanel(
      document.getElementById('sidebar')!,
      (tagId, name, memo, group) => this.saveMeta(tagId, name, memo, group),
      (tagId) => this.pickTag(tagId),
    );
    // 체류 시간·마지막 신호가 흐르므로 1초마다 다시 그린다
    this.time.addEvent({ delay: 1000, loop: true, callback: () => this.refreshPanel() });

    this.connect(await resolveToken());
  }

  /**
   * 방 이름 라벨.
   * 표기·위치는 도면 PDF 라벨 그대로 — 방 이름은 `Zone.name`(존), 그 외 가구·설비는
   * `floorplan.annotations` 가 출처다. 배경 PNG 에는 글자가 없으므로 여기서만 그린다.
   */
  private drawNames(zones: Zone[], annotations: MapAnnotation[]): void {
    const layer = this.add.container(0, 0);
    for (const z of zones) {
      layer.add(this.roomName(z.tilePosition.x, z.tilePosition.y, z.name));
    }
    // 가구·설비 라벨은 방이 아니라 넓은 공간 안의 한 지점 → 도면 위치를 그대로 둔다
    for (const a of annotations) {
      layer.add(
        this.add
          .text(this.sx(a.x), this.sy(a.y), a.text, {
            fontFamily: NAME_FONT,
            fontSize: '10px',
            color: '#5c6b7d',
            backgroundColor: '#ffffffb0',
            padding: { x: 3, y: 1 },
          })
          .setOrigin(0.5, 0.5),
      );
    }
    this.nameLayer = layer;
  }

  /**
   * 방 이름 라벨 — 방 가운데에, 방 폭에 들어가는 가장 큰 글씨로.
   * 벽 격자로 방 크기를 실측해 크기·줄바꿈을 정하므로 좁은 방에서도 옆방을 침범하지 않는다.
   */
  private roomName(anchorX: number, anchorY: number, text: string): Phaser.GameObjects.Text {
    const box = this.pf.roomBoxAt(anchorX, anchorY);
    // 로비·복도처럼 넓은 영역은 중심이 라벨의 방을 대표하지 못한다 → 도면 라벨 위치 유지
    const room = box && box.w <= ROOM_MAX_PX && box.h <= ROOM_MAX_PX ? box : null;
    // 도면 라벨 위치는 이미 그 방 안이다 — 중앙 정렬은 거기서 1m 안쪽으로만 허용
    const near = (v: number, anchor: number): number =>
      Math.max(anchor - NAME_MAX_SHIFT_PX, Math.min(anchor + NAME_MAX_SHIFT_PX, v));
    const cx = room ? near(room.cx, anchorX) : anchorX;
    const cy = room ? near(room.cy, anchorY) : anchorY;
    // 벽에 딱 붙으면 답답해 보인다 — 양쪽에 여백을 남긴다
    const availW = room ? room.w * this.worldScale - 2 * NAME_PAD_X - 10 : Number.POSITIVE_INFINITY;
    const availH = room ? room.h * this.worldScale - 6 : Number.POSITIVE_INFINITY;

    const { lines, size } = this.fitName(text, availW, availH);
    return this.add
      .text(this.sx(cx), this.sy(cy), lines.join('\n'), {
        fontFamily: NAME_FONT,
        fontSize: `${size}px`,
        fontStyle: 'bold',
        color: '#0d1520',
        backgroundColor: '#ffffffe8',
        align: 'center',
        padding: { x: NAME_PAD_X, y: 1 },
      })
      .setOrigin(0.5, 0.5);
  }

  /**
   * 가용 폭에 맞는 표기 결정. 선호 순서:
   *   1) 한 줄 — 가능한 가장 큰 글씨
   *   2) 공백에서 줄바꿈 — 가능한 가장 큰 글씨
   *   3) 그래도 안 되면 최소 글씨 한 줄 (아주 좁은 방은 조금 넘치게 둔다)
   * 한글 낱말을 글자 단위로 쪼개면("창/고") 읽기 나쁘므로 공백에서만 끊는다.
   */
  private fitName(
    text: string,
    availW: number,
    availH: number,
  ): { lines: string[]; size: number } {
    const lineH = (size: number): number => size * 1.35; // 캔버스 기본 행간 근사
    for (let size = NAME_SIZE_MAX; size >= NAME_SIZE_MIN; size--) {
      if (this.textWidth(text, size) <= availW && lineH(size) <= availH) {
        return { lines: [text], size };
      }
    }
    if (text.includes(' ')) {
      for (let size = NAME_SIZE_MAX; size >= NAME_SIZE_MIN; size--) {
        const lines = this.wrapAtSpaces(text, size, availW);
        const widest = Math.max(...lines.map((l) => this.textWidth(l, size)));
        if (widest <= availW && lines.length * lineH(size) <= availH) return { lines, size };
      }
    }
    return { lines: [text], size: NAME_SIZE_MIN };
  }

  /** 공백 기준 그리디 줄바꿈 */
  private wrapAtSpaces(text: string, size: number, limit: number): string[] {
    const lines: string[] = [];
    let cur = '';
    for (const word of text.split(' ')) {
      const joined = cur ? `${cur} ${word}` : word;
      if (!cur || this.textWidth(joined, size) <= limit) {
        cur = joined;
        continue;
      }
      lines.push(cur);
      cur = word;
    }
    lines.push(cur);
    return lines;
  }

  /** Text 객체와 같은 폰트로 폭만 계산 (객체를 만들어 재기엔 후보가 많다) */
  private textWidth(s: string, size: number): number {
    this.measureCtx.font = `bold ${size}px ${NAME_FONT}`;
    return this.measureCtx.measureText(s).width;
  }

  /** 방 이름 표시 버튼 연결 (기본 ON) */
  private setupNameToggle(): void {
    const btn = document.getElementById('name-btn') as HTMLButtonElement | null;
    if (!btn) return;
    const render = (): void => {
      const on = this.nameLayer?.visible ?? false;
      btn.textContent = on ? '🏷 이름 숨기기' : '🏷 이름 보기';
      btn.classList.toggle('on', on);
    };
    btn.onclick = () => {
      this.nameLayer?.setVisible(!this.nameLayer.visible);
      render();
    };
    render();
  }

  /** 통제구역 표시 버튼 연결 */
  private setupOverlayToggle(): void {
    const btn = document.getElementById('blocked-btn') as HTMLButtonElement | null;
    if (!btn) return;
    const render = (): void => {
      const on = this.blockedOverlay?.visible ?? false;
      btn.textContent = on ? '🚧 통제구역 숨기기' : '🚧 통제구역 보기';
      btn.classList.toggle('on', on);
    };
    btn.onclick = () => {
      this.blockedOverlay?.setVisible(!this.blockedOverlay.visible);
      render();
    };
    render();
  }

  /**
   * 도면 이미지 등록.
   * ⚠️ create() 안에서 this.load.start() 를 쓰면 씬이 LOADING 으로 되돌아가 update() 가 멈춘다.
   * ⚠️ img.decode() 는 탭이 백그라운드일 때 브라우저가 디코딩을 보류해 영구 대기한다
   *    (탭을 벗어난 뒤 새로고침하면 화면이 안 뜸) → onload 이벤트를 사용한다.
   */
  private loadPlanImage(file: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        this.textures.addImage('plan', img);
        resolve();
      };
      img.onerror = () => reject(new Error(`도면 이미지 로드 실패: ${file}`));
      img.src = `/${file}`;
    });
  }

  private connect(token: string): void {
    this.socket = io(`${SERVER_URL}/staff`, { auth: { token } });

    this.socket.on('presence:update', (states: PresenceState[]) => {
      for (const state of states) {
        this.states.set(state.tagId, state);
        this.upsertAvatar(state);
      }
      this.refreshPanel();
    });

    this.socket.on('presence:remove', ({ tagId }: { tagId: string }) => {
      this.lastPosAt.delete(tagId);
      const prev = this.states.get(tagId);
      if (prev) this.states.set(tagId, { ...prev, currentZone: null });
      const avatar = this.avatars.get(tagId);
      if (avatar) this.moveTo(tagId, null);
      this.refreshPanel();
    });

    // RSSI 가중평균 연속 위치 → 도면 좌표계 그대로 변환
    this.socket.on('pos:update', (positions: PositionEstimate[]) => {
      for (const p of positions) {
        let avatar = this.avatars.get(p.tagId);
        if (!avatar) {
          avatar = this.makeAvatar(p.tagId);
          this.avatars.set(p.tagId, avatar);
        }
        this.lastPosAt.set(p.tagId, Date.now());
        this.routeTo(p.tagId, avatar, p.x, p.y);
        // 존 판정과 신호 시각은 연속 위치 쪽이 더 최신이다 — 목록 상태에 반영
        const prev = this.states.get(p.tagId);
        this.states.set(p.tagId, {
          tagId: p.tagId,
          currentZone: p.zone,
          lastSeen: Date.now(),
          enteredAt: prev && prev.currentZone === p.zone ? prev.enteredAt : Date.now(),
        });
      }
      this.refreshPanel();
    });

    this.socket.on('tagmeta', (map: TagMetaMap) => {
      this.tagMeta = map;
      for (const [tagId, label] of this.avatarLabels) label.setText(this.labelFor(tagId));
      // 그룹이 바뀌면 색도 바로 바뀌게 (목록 아이콘과 맵 점이 같은 색을 유지)
      for (const [tagId, parts] of this.avatarDots) {
        const c = this.colorFor(tagId);
        parts.halo.setFillStyle(c, 0.25);
        parts.dot.setFillStyle(c);
      }
      this.refreshPanel();
    });

    this.socket.on('connect_error', (err) => {
      console.error('[ws] connect error:', err.message);
    });
  }

  private labelFor(tagId: string): string {
    const m = this.tagMeta[tagId];
    const base = m?.name?.trim() ? m.name.trim() : tagId.slice(-5);
    return m?.memo?.trim() ? `${base} 📝` : base;
  }

  /** 이름·메모·그룹 저장 — 서버가 되돌려주는 tagmeta 브로드캐스트로 화면이 갱신된다 */
  private saveMeta(tagId: string, name: string, memo: string, group: TagGroup): void {
    void fetch(`${SERVER_URL}/tag-meta`, {
      method: 'POST',
      body: JSON.stringify({ tagId, name, memo, group }),
    });
  }

  /** 왼쪽 목록 한 줄에 넣을 정보를 모아 넘긴다 */
  private refreshPanel(): void {
    if (!this.panel) return;
    const rows: TagRow[] = [...this.avatars.keys()].map((tagId) => {
      const st = this.states.get(tagId);
      const zoneId = this.zoneDwell.update(tagId, st?.currentZone ?? null);
      return {
        tagId,
        color: this.colorFor(tagId),
        name: this.tagMeta[tagId]?.name ?? '',
        memo: this.tagMeta[tagId]?.memo ?? '',
        // 아직 배정 안 된 태그는 '미지정' 그룹에 모인다
        group: this.tagMeta[tagId]?.group ?? 'unassigned',
        zoneName: zoneId ? this.zones.get(zoneId)?.name ?? zoneId : null,
        enteredAt: st?.enteredAt ?? 0,
        lastSeen: st?.lastSeen ?? 0,
      };
    });
    this.panel.render(rows);
  }

  /** 목록의 비콘 아이콘을 누르면 맵에서 그 아바타를 링으로 강조 (다시 누르면 해제) */
  private pickTag(tagId: string): void {
    this.pickedTag = this.pickedTag === tagId ? undefined : tagId;
    if (!this.pickRing) {
      this.pickRing = this.add.circle(0, 0, 15).setStrokeStyle(2.5, 0xffffff, 0.95);
      // 깜빡이는 링은 한 번만 만든다 — 매번 tween 을 추가하면 누적된다
      this.tweens.add({
        targets: this.pickRing,
        scale: { from: 0.85, to: 1.5 },
        alpha: { from: 1, to: 0.15 },
        duration: 800,
        yoyo: true,
        repeat: -1,
      });
    }
    this.pickRing.setVisible(this.pickedTag !== undefined);
  }

  private upsertAvatar(state: PresenceState): void {
    let avatar = this.avatars.get(state.tagId);
    if (!avatar) {
      avatar = this.makeAvatar(state.tagId);
      this.avatars.set(state.tagId, avatar);
    }
    // 연속 위치가 흐르는 동안은 존 스냅 생략 (브로드캐스트 주기 3.5초 → 넉넉히 8초)
    if (Date.now() - (this.lastPosAt.get(state.tagId) ?? 0) < 8000) return;
    this.moveTo(state.tagId, state.currentZone);
  }

  /** 태그 색 = 그룹 색. 그룹이 없으면 '미지정' 회색 */
  private colorFor(tagId: string): number {
    return groupColor(this.tagMeta[tagId]?.group);
  }

  private makeAvatar(tagId: string): Phaser.GameObjects.Container {
    const color = this.colorFor(tagId);
    const halo = this.add.circle(0, 0, 11, color, 0.25);
    const circle = this.add.circle(0, 0, 7, color).setStrokeStyle(2, 0xffffff, 0.95);
    this.avatarDots.set(tagId, { halo, dot: circle });
    circle.setInteractive({ useHandCursor: true });
    // 점을 누르면 왼쪽 목록의 그 줄로 이동해 이름을 바로 고칠 수 있게
    circle.on('pointerdown', () => this.panel.focusRow(tagId));
    const label = this.add
      .text(0, 11, this.labelFor(tagId), {
        color: '#ffffff',
        fontSize: '10px',
        backgroundColor: '#000000aa',
        padding: { x: 3, y: 1 },
      })
      .setOrigin(0.5, 0);
    this.avatarLabels.set(tagId, label);
    this.teleport.add(tagId); // 최초 등장은 걷지 않고 바로 제자리에
    return this.add.container(this.absentPt.x, this.absentPt.y, [halo, circle, label]);
  }

  /**
   * 목표 지점까지 벽을 피하는 경로를 계산해 저장 (도면 좌표).
   * 직선으로 갈 수 있으면 A* 를 생략해 비용을 아낀다.
   */
  private routeTo(
    tagId: string,
    avatar: Phaser.GameObjects.Container,
    destX: number,
    destY: number,
  ): void {
    // 현재 화면 좌표 → 도면 좌표
    const curX = (avatar.x - this.offX) / this.worldScale;
    const curY = (avatar.y - this.offY) / this.worldScale;

    if (this.teleport.has(tagId)) {
      this.paths.set(tagId, [{ x: destX, y: destY }]);
      return;
    }
    // 목표가 벽·가구 위면 통행 가능한 지점으로 보정 (그 지점까지만 걷는다)
    const dest = this.pf.nearestWalkable(destX, destY);
    if (this.pf.hasLineOfSight(curX, curY, dest.x, dest.y)) {
      this.paths.set(tagId, [dest]);
      return;
    }
    const path = this.pf.findPath(curX, curY, dest.x, dest.y);
    // 경로를 못 찾으면(격리된 영역 등) 어쩔 수 없이 직선 — 최소한 멈추진 않게
    this.paths.set(tagId, path ?? [dest]);
  }

  /** 존 스냅 이동 (연속 위치 없을 때) — 존 라벨 위치를 목표로 */
  private moveTo(tagId: string, zoneId: string | null): void {
    if (zoneId === null) {
      // 자리비움은 도면 밖이라 걸어가면 어색 → 즉시 이동
      this.teleport.add(tagId);
      this.paths.set(tagId, [
        {
          x: (this.absentPt.x - this.offX) / this.worldScale,
          y: (this.absentPt.y - this.offY) / this.worldScale,
        },
      ]);
      return;
    }
    const zone = this.zones.get(zoneId);
    const avatar = this.avatars.get(tagId);
    if (!zone || !avatar) return;
    this.routeTo(tagId, avatar, zone.tilePosition.x, zone.tilePosition.y);
  }

  /**
   * 매 프레임 목표를 향해 '보행 속도'로 등속 이동 — 순간이동처럼 튀지 않는다.
   * 서버는 3.5초마다 좌표를 주고, 그 사이를 아바타가 걸어서 좁힌다.
   */
  update(_time: number, delta: number): void {
    const step = WALK_PX_PER_SEC * this.worldScale * (delta / 1000);
    const eps = ARRIVE_EPS_PX * this.worldScale;

    for (const [tagId, avatar] of this.avatars) {
      const path = this.paths.get(tagId);
      if (!path || path.length === 0) continue;

      if (this.teleport.has(tagId)) {
        const last = path[path.length - 1];
        avatar.x = this.sx(last.x);
        avatar.y = this.sy(last.y);
        this.paths.set(tagId, []);
        this.teleport.delete(tagId);
        continue;
      }

      // 경로 waypoint 를 순서대로 소비하며 등속 이동
      let remaining = step;
      while (remaining > 0 && path.length > 0) {
        const wp = path[0];
        const tx = this.sx(wp.x);
        const ty = this.sy(wp.y);
        const dx = tx - avatar.x;
        const dy = ty - avatar.y;
        const dist = Math.hypot(dx, dy);

        // 마지막 지점에 거의 닿았으면 정지 (노이즈로 떨지 않게)
        if (path.length === 1 && dist <= eps) {
          path.shift();
          break;
        }
        if (dist <= remaining) {
          avatar.x = tx;
          avatar.y = ty;
          remaining -= dist;
          path.shift();
          continue;
        }
        avatar.x += (dx / dist) * remaining;
        avatar.y += (dy / dist) * remaining;
        remaining = 0;
      }
    }

    // 강조 링은 아바타를 움직인 뒤에 따라붙인다 (먼저 하면 한 프레임 뒤처진다)
    if (this.pickRing?.visible) {
      const target = this.pickedTag ? this.avatars.get(this.pickedTag) : undefined;
      if (target) this.pickRing.setPosition(target.x, target.y);
      else this.pickRing.setVisible(false);
    }
  }
}

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'app',
  width: CW,
  height: CH,
  backgroundColor: '#11151c',
  scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
  scene: [StaffMapScene],
});
(window as unknown as Record<string, unknown>).__game = game;
