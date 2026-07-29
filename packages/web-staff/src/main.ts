import Phaser from 'phaser';
import { io, type Socket } from 'socket.io-client';
import type {
  FloorplanMeta,
  PositionEstimate,
  PresenceState,
  TagMetaMap,
  Zone,
} from '@meditracker/shared';

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

// 도면이 거의 정사각형(26700×25700)이라 캔버스도 그 비율에 맞춤 (Scale.FIT 으로 창에 맞게 축소)
const CW = 1120;
const CH = 1120;
const TOP = 40; // 상단 제목 여백
const PAD = 6;

const AVATAR_COLORS = [0xffd166, 0xef476f, 0x06d6a0, 0x118ab2, 0xf78c6b, 0x9b5de5];

class StaffMapScene extends Phaser.Scene {
  private socket!: Socket;
  private zones = new Map<string, Zone>();
  private avatars = new Map<string, Phaser.GameObjects.Container>();
  private avatarLabels = new Map<string, Phaser.GameObjects.Text>();
  private lastPosAt = new Map<string, number>();
  private tagMeta: TagMetaMap = {};
  /** 아바타 목표 좌표(화면) — update() 에서 매 프레임 보간 이동 (tween 누적 방지) */
  private targets = new Map<string, { x: number; y: number }>();

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

    const [plan, zones, meta] = await Promise.all([
      fetch(`${SERVER_URL}/floorplan`).then((r) => r.json() as Promise<FloorplanMeta>),
      fetch(`${SERVER_URL}/zones`).then((r) => r.json() as Promise<Zone[]>),
      fetch(`${SERVER_URL}/tag-meta`).then((r) => r.json() as Promise<TagMetaMap>),
    ]);
    this.plan = plan;
    this.tagMeta = meta;
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

    // 자리비움 표시 (도면 밖 우상단)
    this.add
      .text(this.absentPt.x, this.absentPt.y - 16, '자리비움', { color: '#888888', fontSize: '11px' })
      .setOrigin(0.5, 1);

    this.connect(await resolveToken());
  }

  /**
   * 도면 이미지 등록. ⚠️ create() 안에서 this.load.start() 를 쓰면 씬이 LOADING 으로
   * 되돌아가 update() 가 멈춘다 → Phaser 로더 대신 직접 디코드해 텍스처로 등록.
   */
  private async loadPlanImage(file: string): Promise<void> {
    const img = new Image();
    img.src = `/${file}`;
    await img.decode();
    this.textures.addImage('plan', img);
  }

  private connect(token: string): void {
    this.socket = io(`${SERVER_URL}/staff`, { auth: { token } });

    this.socket.on('presence:update', (states: PresenceState[]) => {
      for (const state of states) this.upsertAvatar(state);
    });

    this.socket.on('presence:remove', ({ tagId }: { tagId: string }) => {
      this.lastPosAt.delete(tagId);
      const avatar = this.avatars.get(tagId);
      if (avatar) this.moveTo(tagId, null);
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
        this.targets.set(p.tagId, { x: this.sx(p.x), y: this.sy(p.y) });
      }
    });

    this.socket.on('tagmeta', (map: TagMetaMap) => {
      this.tagMeta = map;
      for (const [tagId, label] of this.avatarLabels) label.setText(this.labelFor(tagId));
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

  private editMeta(tagId: string): void {
    const cur = this.tagMeta[tagId] ?? {};
    const name = window.prompt(`태그 ${tagId}\n\n이름:`, cur.name ?? '');
    if (name === null) return;
    const memo = window.prompt('메모 (선택):', cur.memo ?? '');
    void fetch(`${SERVER_URL}/tag-meta`, {
      method: 'POST',
      body: JSON.stringify({ tagId, name, memo: memo ?? '' }),
    });
  }

  private upsertAvatar(state: PresenceState): void {
    let avatar = this.avatars.get(state.tagId);
    if (!avatar) {
      avatar = this.makeAvatar(state.tagId);
      this.avatars.set(state.tagId, avatar);
    }
    if (Date.now() - (this.lastPosAt.get(state.tagId) ?? 0) < 2000) return;
    this.moveTo(state.tagId, state.currentZone);
  }

  private makeAvatar(tagId: string): Phaser.GameObjects.Container {
    const color = AVATAR_COLORS[this.avatars.size % AVATAR_COLORS.length];
    const halo = this.add.circle(0, 0, 11, color, 0.25);
    const circle = this.add.circle(0, 0, 7, color).setStrokeStyle(2, 0xffffff, 0.95);
    circle.setInteractive({ useHandCursor: true });
    circle.on('pointerdown', () => this.editMeta(tagId));
    const label = this.add
      .text(0, 11, this.labelFor(tagId), {
        color: '#ffffff',
        fontSize: '10px',
        backgroundColor: '#000000aa',
        padding: { x: 3, y: 1 },
      })
      .setOrigin(0.5, 0);
    this.avatarLabels.set(tagId, label);
    return this.add.container(this.absentPt.x, this.absentPt.y, [halo, circle, label]);
  }

  /** 존 스냅 이동 (연속 위치 없을 때) — 존 라벨 위치를 목표로 */
  private moveTo(tagId: string, zoneId: string | null): void {
    if (zoneId === null) {
      this.targets.set(tagId, { x: this.absentPt.x, y: this.absentPt.y });
      return;
    }
    const zone = this.zones.get(zoneId);
    if (!zone) return;
    this.targets.set(tagId, { x: this.sx(zone.tilePosition.x), y: this.sy(zone.tilePosition.y) });
  }

  /** 매 프레임 목표 좌표로 지수 보간 — 부드럽게 따라가고 tween 이 쌓이지 않음 */
  update(_time: number, delta: number): void {
    const k = 1 - Math.exp(-delta / 160);
    for (const [tagId, avatar] of this.avatars) {
      const t = this.targets.get(tagId);
      if (!t) continue;
      avatar.x += (t.x - avatar.x) * k;
      avatar.y += (t.y - avatar.y) * k;
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
