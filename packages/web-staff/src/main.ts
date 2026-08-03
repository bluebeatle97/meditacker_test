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
import type {
  FloorplanMeta,
  MapAnnotation,
  PositionEstimate,
  PresenceState,
  TagGroup,
  TagMetaMap,
  Zone,
} from '@meditracker/shared';
import { AlertPanel, STUCK_ALERT_MS, type StuckAlert } from './alert-panel';
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

// 보행 속도·도착 판정·따라잡기 계수는 @meditracker/shared 의 walk-pacing 이 단일 출처.
// 환자용 패널과 **같은 값**을 써야 두 화면의 같은 사람이 같은 자리에 있다.

// 겹친 아바타 흩어놓기 (화면 px) — 점 반지름 7 + 흰 테두리 2 라 9 면 서로 안 먹는다
const SPREAD_TRIGGER_PX = 18; // 이보다 가까우면 비켜선다
const SPREAD_RELEASE_PX = 30; // 이만큼 떨어져야 제자리로 (문턱을 벌려 깜빡임 방지)
const SPREAD_DOT_R = 9; // 비키는 거리. 실제 위치에서 이 이상 떼면 그게 거짓말이 된다

/** 태그마다 고정된 회피 방향 — 무리 구성이 바뀌어도 각도가 변하지 않아야 안 흔들린다 */
function spreadAngleFor(tagId: string): number {
  let h = 0;
  for (let i = 0; i < tagId.length; i++) h = (h * 31 + tagId.charCodeAt(i)) | 0;
  return ((h >>> 0) % 360) * (Math.PI / 180);
}

// 방 이름 라벨 — 방 폭에 맞춰 크기를 정한다 (좁은 방은 줄여서라도 방 안에 넣는다)
const NAME_FONT = 'sans-serif';
const NAME_SIZE_MAX = 14;
const NAME_SIZE_MIN = 9;
const NAME_PAD_X = 4;
/** 이보다 큰 영역은 '방'이 아니라 로비·복도 → 중앙 정렬하지 않고 도면 라벨 위치를 그대로 쓴다 */
const ROOM_MAX_PX = 420;
/** 방 중앙으로 옮길 수 있는 최대 거리 (도면 px ≈ 1m). 폭 측정이 문틈으로 샜을 때의 안전장치 */
const NAME_MAX_SHIFT_PX = 60;
/** 선택한 비콘 강조 링 색 — 흰 도면 위라 어떤 그룹 색과도 안 겹치는 빨강 */
const PICK_RING_COLOR = 0xff2f45;
/** 이름표 기본 위치 (아바타 중심에서 아래로) — 겹치면 여기서부터 아래로 밀어낸다 */
const LABEL_BASE_Y = 11;

/** 도면 확대 배율 — 1 = 도면 전체가 화면에 들어오는 기본 크기 */
const ZOOM_MIN = 1;
const ZOOM_MAX = 6;
/** 버튼 한 번에 곱해지는 배율 (휠은 더 잘게) */
const ZOOM_STEP = 1.4;
const ZOOM_WHEEL_STEP = 1.12;
/** 경고 ! 표 점멸 주기 (켜짐 또는 꺼짐 한 구간, ms) */
const BLINK_MS = 420;
/** 장기체류 경고 배지 — 강조 링과 같은 빨강 */
const ALERT_COLOR = PICK_RING_COLOR;
/** ! 배지 위치 — 비콘(반지름 7, 후광 11) 오른쪽 위 모서리에 걸친다 */
const ALERT_BADGE_AT = { x: 10, y: -10, r: 7.5 };
/**
 * 경고를 볼 그룹 — 환자와 아직 배정 안 된 비콘만.
 * 직원은 한 방에 오래 있는 게 정상(진료·시술)이라 경고하면 매번 울린다.
 */
const ALERT_GROUPS: ReadonlySet<TagGroup> = new Set<TagGroup>(['patient', 'unassigned']);

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
  private alerts!: AlertPanel;
  /** 아바타 위에 뜨는 빨간 ! 배지 (update() 에서 다 같이 점멸시킨다) */
  private alertBadges = new Map<string, Phaser.GameObjects.Container>();
  /** 지금 장기체류 경고 중인 태그 */
  private stuckTags = new Set<string>();
  /**
   * 표시 구역이 바뀐 시각. 목록의 '체류'와 경고가 **같은 값**을 쓰게 하려고
   * 원본 `enteredAt` 이 아니라 안정화된 구역 기준으로 다시 잰다 — 안 그러면
   * 복도를 스치는 채터링에 타이머가 계속 0으로 돌아가 10분이 영영 안 찬다.
   */
  private zoneSince = new Map<string, { zone: string | null; at: number }>();
  /** '확인' 누른 경고 (태그 → 그때의 체류 시작 시각) — 자리를 옮기면 저절로 풀린다 */
  private acked = new Map<string, number>();
  private pickedTag?: string;
  private pickRing?: Phaser.GameObjects.Arc;
  /** 아바타별 남은 경로 (도면 좌표 waypoint) — 벽을 피해 문으로 돌아간다 */
  private paths = new Map<string, Array<{ x: number; y: number }>>();
  /** 즉시 배치할 태그 (최초 등장·자리비움) — 걷지 않고 순간 이동 */
  private teleport = new Set<string>();
  /**
   * 태그별 **직전 서버 좌표**. 경로를 아바타의 현재 화면 위치가 아니라 여기서부터 계산한다 —
   * 아바타 위치에서 재면 두 패널의 A* 입력이 달라져 **아예 다른 문으로 돌아가고**,
   * 그 차이가 좁혀지는 게 아니라 벌어진다. 서버 좌표는 양쪽이 똑같으니 경로도 똑같아진다.
   */
  private lastPoint = new Map<string, { x: number; y: number }>();
  /** 태그별 이번 구간 보행 속도 (도면 px/초) — 다음 좌표가 올 때 정확히 도착하도록 매번 다시 정한다 */
  private pace = new Map<string, number>();
  /** 좌표 브로드캐스트 주기 관측 (환자용 패널과 같은 방식) */
  private posClock = new UpdateClock();
  /**
   * 겹친 아바타를 흩어 놓기 위한 **표시 전용** 오프셋 (컨테이너 로컬 화면 px).
   * 컨테이너 위치(= 논리 좌표)는 건드리지 않고 안에 든 그림만 밀어낸다 —
   * 컨테이너를 옮기면 그 값이 다음 경로 계산의 출발점으로 되먹임된다.
   */
  private clusterOffset = new Map<string, { dx: number; dy: number }>();
  /** 경고 배지의 원래 높이 (오프셋 누적 방지) */
  private alertBadgeBaseY = new Map<string, number>();
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

  /** 확대해도 제자리·같은 크기로 남아야 하는 것(제목)만 그리는 카메라 */
  private uiCam?: Phaser.Cameras.Scene2D.Camera;
  private title!: Phaser.GameObjects.Text;

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
    this.title = this.add.text(16, 12, 'MediTracker — 직원용 (고트의원 6F)', {
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
    // 장기체류 경고창 (DOM) — 이름을 누르면 맵에서 그 비콘을 찾아 준다
    this.alerts = new AlertPanel(
      document.getElementById('alerts')!,
      (tagId) => this.locate(tagId),
      (tagId) => this.ackAlert(tagId),
    );
    // 체류 시간·마지막 신호가 흐르므로 1초마다 다시 그린다
    this.time.addEvent({ delay: 1000, loop: true, callback: () => this.refreshPanel() });

    this.setupZoom();
    this.connect(await resolveToken());
  }

  /**
   * 도면 확대/축소.
   *
   * 카메라 줌만 바꾼다 — 도면·존 라벨·아바타가 통째로 같이 커지므로 좌표계가
   * 어긋날 일이 없다(아바타를 따로 스케일하면 위치 계산을 전부 이중으로 해야 한다).
   * 제목만 UI 카메라로 따로 그려 확대해도 제자리·같은 크기로 남는다.
   */
  private setupZoom(): void {
    const cam = this.cameras.main;
    // 도면 밖으로 밀려나지 않게 — 확대해도 화면이 캔버스 안에 머문다
    cam.setBounds(0, 0, CW, CH);

    // 이 시점의 월드 오브젝트는 UI 카메라가, 제목은 월드 카메라가 무시한다.
    // (뒤에 생기는 아바타·강조 링은 만들 때마다 uiCam.ignore 로 추가한다)
    this.uiCam = this.cameras.add(0, 0, CW, CH);
    this.uiCam.ignore(this.children.list.filter((o) => o !== this.title));
    cam.ignore(this.title);

    const zoomIn = document.getElementById('zoom-in') as HTMLButtonElement | null;
    const zoomOut = document.getElementById('zoom-out') as HTMLButtonElement | null;
    const level = document.getElementById('zoom-level') as HTMLButtonElement | null;
    if (zoomIn) zoomIn.onclick = () => this.zoomTo(cam.zoom * ZOOM_STEP, CW / 2, CH / 2);
    if (zoomOut) zoomOut.onclick = () => this.zoomTo(cam.zoom / ZOOM_STEP, CW / 2, CH / 2);
    // 배율을 누르면 원래대로
    if (level) level.onclick = () => this.zoomTo(ZOOM_MIN, CW / 2, CH / 2);

    // 휠은 커서 밑 지점을 붙잡고 확대 — 보고 있던 방이 화면 밖으로 안 나간다
    this.input.on(
      'wheel',
      (p: Phaser.Input.Pointer, _o: unknown, _dx: number, dy: number) =>
        this.zoomTo(cam.zoom * (dy > 0 ? 1 / ZOOM_WHEEL_STEP : ZOOM_WHEEL_STEP), p.x, p.y),
    );
    // 확대 상태에서는 도면을 끌어서 옮긴다
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      if (!p.isDown || cam.zoom <= ZOOM_MIN) return;
      cam.scrollX -= (p.x - p.prevPosition.x) / cam.zoom;
      cam.scrollY -= (p.y - p.prevPosition.y) / cam.zoom;
    });

    this.renderZoomUi();
  }

  /** 화면의 (screenX, screenY) 밑에 있는 도면 지점을 붙잡은 채 배율만 바꾼다 */
  private zoomTo(next: number, screenX: number, screenY: number): void {
    const cam = this.cameras.main;
    const z = Phaser.Math.Clamp(next, ZOOM_MIN, ZOOM_MAX);
    if (z === cam.zoom) return;
    // 카메라 중심 = scroll + 화면 절반, 화면 1px = 도면 1/zoom px
    const cx = cam.width / 2;
    const cy = cam.height / 2;
    const wx = cam.scrollX + cx + (screenX - cx) / cam.zoom;
    const wy = cam.scrollY + cy + (screenY - cy) / cam.zoom;
    cam.setZoom(z);
    cam.setScroll(wx - cx - (screenX - cx) / z, wy - cy - (screenY - cy) / z);
    this.renderZoomUi();
  }

  /** 배율 표시·버튼 상태 (한계에 닿으면 눌리지 않게) */
  private renderZoomUi(): void {
    const z = this.cameras.main.zoom;
    const level = document.getElementById('zoom-level');
    if (level) level.textContent = `${Math.round(z * 100)}%`;
    const setOff = (id: string, off: boolean): void => {
      const btn = document.getElementById(id) as HTMLButtonElement | null;
      if (btn) btn.disabled = off;
    };
    setOff('zoom-in', z >= ZOOM_MAX - 1e-6);
    setOff('zoom-out', z <= ZOOM_MIN + 1e-6);
    // 확대해 놓으면 끌어서 옮길 수 있다는 걸 커서로 알린다
    this.input.setDefaultCursor(z > ZOOM_MIN ? 'grab' : 'default');
  }

  /** 경고창에서 이름을 눌렀을 때 — 그 비콘으로 화면을 옮기고 강조·편집줄까지 연다 */
  private locate(tagId: string): void {
    const avatar = this.avatars.get(tagId);
    if (avatar && this.cameras.main.zoom > ZOOM_MIN) {
      this.cameras.main.centerOn(avatar.x, avatar.y);
    }
    if (this.pickedTag !== tagId) this.pickTag(tagId);
    this.panel.focusRow(tagId);
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

    /**
     * 탭이 백그라운드로 내려가면 브라우저가 rAF 를 멈춰 아바타가 그 자리에 굳는다.
     * 돌아왔을 때 걸어서 메우려 하면 그동안 새 좌표가 계속 오므로 **영영 못 따라잡는다**
     * (= 환자용 패널과 어긋난 채로 고정된다). 그러니 걷지 말고 진실 좌표로 바로 붙인다.
     */
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      for (const [tagId, avatar] of this.avatars) {
        const p = this.lastPoint.get(tagId);
        if (!p) continue;
        avatar.x = this.sx(p.x);
        avatar.y = this.sy(p.y);
        this.paths.set(tagId, []);
      }
    });

    this.socket.on('presence:update', (states: PresenceState[]) => {
      for (const state of states) {
        this.states.set(state.tagId, state);
        this.upsertAvatar(state);
      }
      this.refreshPanel();
    });

    this.socket.on('presence:remove', ({ tagId }: { tagId: string }) => {
      this.lastPosAt.delete(tagId);
      // 자리비움 구석으로 치우므로 직전 좌표는 무효 — 돌아오면 새로 잡는다
      // (남겨두면 복귀 시 도면 밖에서 방까지 걸어 들어오는 경로가 나온다)
      this.lastPoint.delete(tagId);
      const prev = this.states.get(tagId);
      if (prev) this.states.set(tagId, { ...prev, currentZone: null });
      const avatar = this.avatars.get(tagId);
      if (avatar) this.moveTo(tagId, null);
      this.refreshPanel();
    });

    // RSSI 가중평균 연속 위치 → 도면 좌표계 그대로 변환
    this.socket.on('pos:update', (positions: PositionEstimate[]) => {
      // 브로드캐스트 주기 관측은 배치당 한 번 (태그마다 부르면 0ms 로 수렴한다)
      this.posClock.tick();
      for (const p of positions) {
        let avatar = this.avatars.get(p.tagId);
        if (!avatar) {
          avatar = this.makeAvatar(p.tagId);
          this.avatars.set(p.tagId, avatar);
        }
        this.lastPosAt.set(p.tagId, Date.now());
        // 직전 서버 좌표에서부터 경로를 잰다 → 환자용 패널과 반드시 같은 경로가 나온다
        this.routeTo(p.tagId, avatar, p.x, p.y, this.lastPoint.get(p.tagId));
        this.lastPoint.set(p.tagId, { x: p.x, y: p.y });
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

  /** 화면에 보일 이름 — 아직 지정 안 했으면 태그 뒷자리 */
  private nameFor(tagId: string): string {
    const name = this.tagMeta[tagId]?.name?.trim();
    return name ? name : tagId.slice(-5);
  }

  private labelFor(tagId: string): string {
    const base = this.nameFor(tagId);
    return this.tagMeta[tagId]?.memo?.trim() ? `${base} 📝` : base;
  }

  /** 이름·메모·그룹 저장 — 서버가 되돌려주는 tagmeta 브로드캐스트로 화면이 갱신된다 */
  private saveMeta(tagId: string, name: string, memo: string, group: TagGroup): void {
    void fetch(`${SERVER_URL}/tag-meta`, {
      method: 'POST',
      body: JSON.stringify({ tagId, name, memo, group }),
    });
  }

  /** 왼쪽 목록 한 줄에 넣을 정보를 모아 넘긴다 (장기체류 경고도 여기서 판정) */
  private refreshPanel(): void {
    if (!this.panel) return;
    const now = Date.now();
    const alerts: StuckAlert[] = [];

    const rows: TagRow[] = [...this.avatars.keys()].map((tagId) => {
      const st = this.states.get(tagId);
      const zoneId = this.zoneDwell.update(tagId, st?.currentZone ?? null);
      const zoneName = zoneId ? this.zones.get(zoneId)?.name ?? zoneId : null;
      // 아직 배정 안 된 태그는 '미지정' 그룹에 모인다
      const group = this.tagMeta[tagId]?.group ?? 'unassigned';
      const since = this.dwellSince(tagId, zoneId, now);

      // 자리비움은 '한 자리에 머문' 게 아니라 위치를 모르는 것 → 경고 대상이 아니다
      const stuck =
        zoneName !== null &&
        ALERT_GROUPS.has(group) &&
        now - since >= STUCK_ALERT_MS &&
        this.acked.get(tagId) !== since;
      if (stuck) {
        alerts.push({ tagId, label: this.nameFor(tagId), zoneName, heldMs: now - since });
      }

      return {
        tagId,
        color: this.colorFor(tagId),
        name: this.tagMeta[tagId]?.name ?? '',
        memo: this.tagMeta[tagId]?.memo ?? '',
        group,
        zoneName,
        enteredAt: zoneName === null ? 0 : since,
        lastSeen: st?.lastSeen ?? 0,
        alert: stuck,
      };
    });

    alerts.sort((a, b) => b.heldMs - a.heldMs); // 오래 방치된 사람이 맨 위로
    this.stuckTags = new Set(alerts.map((a) => a.tagId));
    this.panel.render(rows);
    this.alerts?.render(alerts);
  }

  /** 표시 구역이 바뀐 시각 — 같은 구역이 이어지는 동안은 처음 들어온 시각을 유지한다 */
  private dwellSince(tagId: string, zone: string | null, now: number): number {
    const prev = this.zoneSince.get(tagId);
    if (prev && prev.zone === zone) return prev.at;
    this.zoneSince.set(tagId, { zone, at: now });
    return now;
  }

  /** '확인' — 지금 머무는 자리에 대해서만 경고를 끈다. 자리를 옮기면 다시 뜬다 */
  private ackAlert(tagId: string): void {
    const cur = this.zoneSince.get(tagId);
    if (cur) this.acked.set(tagId, cur.at);
    this.refreshPanel();
  }

  /** 목록의 비콘 아이콘을 누르면 맵에서 그 아바타를 링으로 강조 (다시 누르면 해제) */
  private pickTag(tagId: string): void {
    this.pickedTag = this.pickedTag === tagId ? undefined : tagId;
    if (!this.pickRing) {
      // 도면 배경이 흰색이라 흰 링은 아예 안 보인다 → 빨강 + 두껍게
      this.pickRing = this.add.circle(0, 0, 16).setStrokeStyle(3.5, PICK_RING_COLOR, 1);
      // 깜빡이는 링은 한 번만 만든다 — 매번 tween 을 추가하면 누적된다
      this.tweens.add({
        targets: this.pickRing,
        scale: { from: 0.85, to: 1.5 },
        // 너무 옅어지면 흰 도면 위에서 사라진다 — 최저 투명도를 올려 항상 읽히게
        alpha: { from: 1, to: 0.45 },
        duration: 800,
        yoyo: true,
        repeat: -1,
      });
      this.uiCam?.ignore(this.pickRing);
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
    // 점을 누르면 왼쪽 목록의 그 줄로 이동해 이름을 바로 고칠 수 있게.
    // 확대 상태에서 도면을 끌 때는 눌린 게 아니므로 이동 거리로 걸러 낸다.
    circle.on('pointerup', (p: Phaser.Input.Pointer) => {
      if (p.getDistance() < 8) this.panel.focusRow(tagId);
    });
    const label = this.add
      .text(0, LABEL_BASE_Y, this.labelFor(tagId), {
        color: '#ffffff',
        fontSize: '10px',
        backgroundColor: '#000000aa',
        padding: { x: 3, y: 1 },
      })
      .setOrigin(0.5, 0);
    this.avatarLabels.set(tagId, label);
    const bang = this.makeAlertBadge();
    this.alertBadges.set(tagId, bang);
    this.teleport.add(tagId); // 최초 등장은 걷지 않고 바로 제자리에
    const avatar = this.add.container(this.absentPt.x, this.absentPt.y, [
      halo,
      circle,
      label,
      bang,
    ]);
    this.uiCam?.ignore(avatar);
    return avatar;
  }

  /** 비콘 오른쪽 위에 붙는 빨간 ! 배지 — 흰 도면 위에서도 튀게 흰 테두리를 두른다 */
  private makeAlertBadge(): Phaser.GameObjects.Container {
    const { x, y, r } = ALERT_BADGE_AT;
    return this.add
      .container(x, y, [
        this.add.circle(0, 0, r, ALERT_COLOR).setStrokeStyle(1.8, 0xffffff, 0.95),
        this.add
          .text(0, 0, '!', { color: '#ffffff', fontSize: '11px', fontStyle: 'bold' })
          .setOrigin(0.5, 0.55),
      ])
      .setVisible(false);
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
    /**
     * 경로 계산 출발점 (도면 좌표). 서버 좌표를 받아 움직일 때는 **직전 서버 좌표**를 넘긴다 —
     * 아바타 위치에서 재면 두 패널이 서로 다른 경로를 고른다. 존 스냅처럼 서버 좌표가 없는
     * 경우에만 생략해서 아바타 위치를 쓴다.
     */
    from?: { x: number; y: number },
  ): void {
    // 현재 화면 좌표 → 도면 좌표
    const curX = (avatar.x - this.offX) / this.worldScale;
    const curY = (avatar.y - this.offY) / this.worldScale;
    const start = from ?? { x: curX, y: curY };

    if (this.teleport.has(tagId)) {
      this.setLeg(tagId, [{ x: destX, y: destY }], curX, curY);
      return;
    }
    // 목표가 벽·가구 위면 통행 가능한 지점으로 보정 (그 지점까지만 걷는다)
    const dest = this.pf.nearestWalkable(destX, destY);
    const route = (fx: number, fy: number): Array<{ x: number; y: number }> =>
      this.pf.hasLineOfSight(fx, fy, dest.x, dest.y)
        ? [dest]
        : // 경로를 못 찾으면(격리된 영역 등) 어쩔 수 없이 직선 — 최소한 멈추진 않게
          (this.pf.findPath(fx, fy, dest.x, dest.y) ?? [dest]);

    let path = route(start.x, start.y);
    /**
     * 아바타와 경로 시작점 사이가 벽으로 막혀 있으면 (탭이 멈춰 뒤처졌거나 추정치가 크게
     * 튄 경우) **아바타 위치에서** 경로를 다시 잡는다.
     *
     * 예전엔 여기서 순간이동시켰는데, 그게 화면에서 "벽을 뚫고 순간이동" 으로 보였다.
     * 다시 걸어서 가면 조금 느릴 뿐 벽은 넘지 않는다.
     */
    if (path[0] && !this.pf.hasLineOfSight(curX, curY, path[0].x, path[0].y)) {
      path = route(curX, curY);
    }
    this.setLeg(tagId, path, curX, curY);
  }

  /**
   * 이번 구간의 경로와 속도를 확정한다.
   *
   * 속도를 고정하지 않고 **다음 좌표가 올 때 정확히 도착하도록** 매번 다시 정하는 게 핵심이다.
   * 고정 보행 속도(= 사람이 걷는 속도)로 쫓아가면 따라잡을 여유가 0이라, 한 번 뒤처진
   * 화면은 사람이 멈출 때까지 영영 그만큼 뒤처진 채로 남는다.
   */
  private setLeg(
    tagId: string,
    path: Array<{ x: number; y: number }>,
    curX: number,
    curY: number,
  ): void {
    this.paths.set(tagId, path);
    this.pace.set(
      tagId,
      paceForPath(pathLengthPx({ x: curX, y: curY }, path), this.posClock.intervalMs),
    );
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
  update(time: number, delta: number): void {
    const eps = ARRIVE_EPS_PX * this.worldScale;

    for (const [tagId, avatar] of this.avatars) {
      const path = this.paths.get(tagId);
      if (!path || path.length === 0) continue;
      // 구간마다 다시 정해진 속도 (환자용 패널과 같은 계산 — walk-pacing.ts)
      const step = (this.pace.get(tagId) ?? 0) * this.worldScale * (delta / 1000);

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

    // 경고 ! 는 전부 같은 박자로 깜빡인다 — 제각각이면 오히려 눈에 안 띈다
    const blinkOn = Math.floor(time / BLINK_MS) % 2 === 0;
    for (const [tagId, bang] of this.alertBadges) {
      bang.setVisible(blinkOn && this.stuckTags.has(tagId));
    }

    this.spreadOverlappingAvatars();
    this.declutterAvatarLabels();
  }

  /**
   * 같은 자리에 겹친 아바타의 **점**을 작은 원으로 흩어 놓는다.
   *
   * 예전엔 "점은 실제 위치라 못 옮긴다" 며 이름표만 흩었는데, 그 판단이 틀렸다.
   * 대기공간에 손님이 모이면 좌표가 1px 차이까지 붙어서 **뒤에 있는 점이 완전히 가려진다**
   * — 화면에서는 비콘이 갑자기 사라진 것처럼 보인다(16개 중 2쌍이 그 상태였다).
   * 두 사람이 있는데 점 하나만 보이는 쪽이, 몇 픽셀 밀어서 둘 다 보이는 쪽보다 부정확하다.
   *
   * 배치는 tagId 정렬 기준이라 프레임마다 같은 결과가 나온다 (안 그러면 자리가 떨린다).
   */
  private spreadOverlappingAvatars(): void {
    const pts = [...this.avatars]
      .filter(([, a]) => a.visible)
      .map(([tagId, a]) => ({ tagId, x: a.x, y: a.y }));

    for (const p of pts) {
      const cur = this.clusterOffset.get(p.tagId);
      const engaged = !!cur && (cur.dx !== 0 || cur.dy !== 0);
      // 붙을 때와 떨어질 때의 문턱을 다르게 (같으면 경계에서 붙었다 떨어졌다 깜빡인다)
      const limit = engaged ? SPREAD_RELEASE_PX : SPREAD_TRIGGER_PX;
      const crowded = pts.some(
        (q) => q.tagId !== p.tagId && Math.hypot(p.x - q.x, p.y - q.y) < limit,
      );
      if (!crowded) {
        this.applyClusterOffset(p.tagId, 0, 0);
        continue;
      }

      /**
       * 미는 방향은 **태그마다 고정**이다 (tagId 해시).
       *
       * 처음엔 무리를 찾아 원둘레에 균등 배치했는데, 무리에 한 명이 들고 날 때마다
       * 전원의 각도가 다시 계산돼 **다 같이 튕겨 나갔다**(실제로 그렇게 보였다).
       * 각자 제 방향으로만 조금 비키면 배치가 완벽하진 않아도 절대 흔들리지 않는다 —
       * 여기서는 정확한 간격보다 안 흔들리는 게 훨씬 중요하다.
       */
      const angle = spreadAngleFor(p.tagId);
      let dx = Math.cos(angle) * SPREAD_DOT_R;
      let dy = Math.sin(angle) * SPREAD_DOT_R;
      // 밀어낸 자리가 벽 안이면 밀지 않는다 — 점이 벽에 박히는 게 겹치는 것보다 나쁘다
      const fx = (p.x + dx - this.offX) / this.worldScale;
      const fy = (p.y + dy - this.offY) / this.worldScale;
      if (!this.pf.isWalkable(fx, fy)) {
        dx = 0;
        dy = 0;
      }
      this.applyClusterOffset(p.tagId, dx, dy);
    }
  }

  /** 오프셋을 컨테이너 안의 그림들에만 반영 (컨테이너 자체는 논리 좌표 유지) */
  private applyClusterOffset(tagId: string, dx: number, dy: number): void {
    const prev = this.clusterOffset.get(tagId);
    if (prev && Math.abs(prev.dx - dx) < 0.5 && Math.abs(prev.dy - dy) < 0.5) return;
    this.clusterOffset.set(tagId, { dx, dy });
    const parts = this.avatarDots.get(tagId);
    if (parts) {
      parts.halo.setPosition(dx, dy);
      parts.dot.setPosition(dx, dy);
    }
    const bang = this.alertBadges.get(tagId);
    if (bang) {
      // 배지의 원래 높이를 한 번만 기억해 둔다 (매번 현재 y 를 읽으면 오프셋이 누적된다)
      const baseY = this.alertBadgeBaseY.get(tagId) ?? bang.y;
      this.alertBadgeBaseY.set(tagId, baseY);
      bang.setPosition(dx, baseY + dy);
    }
    const label = this.avatarLabels.get(tagId);
    if (label) label.x = dx; // y 는 이름표 겹침 해소(declutter)가 정한다
  }

  /**
   * 같은 자리에 겹친 아바타들의 **이름표**를 위아래로 흩어 놓는다.
   *
   * 점(좌표)은 실제 위치라 못 옮기지만 이름표는 주석이라 옮겨도 된다 — 안 그러면
   * 뒤에 깔린 사람 이름이 아예 안 보인다. 정렬을 고정해 매 프레임 같은 결과가 나오게
   * 하고(자리가 떨리지 않게), 실제로 옮길 때만 좌표를 건드린다.
   */
  private declutterAvatarLabels(): void {
    const entries: Array<{
      label: Phaser.GameObjects.Text;
      cx: number;
      top: number;
      originY: number;
    }> = [];
    for (const [tagId, label] of this.avatarLabels) {
      const avatar = this.avatars.get(tagId);
      if (!avatar || !label.visible) continue;
      // 겹침 해소로 점이 밀려났으면 이름표도 그 점을 기준으로 잡아야 한다
      const off = this.clusterOffset.get(tagId) ?? { dx: 0, dy: 0 };
      entries.push({
        label,
        cx: avatar.x + off.dx,
        top: avatar.y + off.dy + LABEL_BASE_Y,
        originY: avatar.y,
      });
    }
    // 위에서 아래로, 같은 높이면 왼쪽부터 — 순서가 고정돼야 결과가 안 흔들린다
    entries.sort((a, b) => a.top - b.top || a.cx - b.cx);

    const placed: Array<{ x0: number; x1: number; y0: number; y1: number }> = [];
    for (const e of entries) {
      const w = e.label.width;
      const h = e.label.height;
      let y = e.top;
      // 겹치면 한 줄씩 내려서 빈 자리를 찾는다 (몇 번 시도해도 안 되면 그대로 둔다)
      for (let tries = 0; tries < 8; tries++) {
        const rect = { x0: e.cx - w / 2, x1: e.cx + w / 2, y0: y, y1: y + h };
        const hit = placed.find(
          (p) => rect.x0 < p.x1 && p.x0 < rect.x1 && rect.y0 < p.y1 && p.y0 < rect.y1,
        );
        if (!hit) {
          placed.push(rect);
          break;
        }
        y = hit.y1 + 2;
      }
      // 이름표는 컨테이너의 자식이므로 컨테이너 원점(avatar.y) 기준 로컬 좌표로 되돌린다
      const localY = y - e.originY;
      if (Math.abs(e.label.y - localY) > 0.5) e.label.y = localY;
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
