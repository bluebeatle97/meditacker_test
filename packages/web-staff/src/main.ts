import Phaser from 'phaser';
import { io, type Socket } from 'socket.io-client';
import type { PositionEstimate, PresenceState, TagMetaMap, Zone } from '@meditracker/shared';

/**
 * 직원용 화면 (설계서 8) — 도면 기반 평면도
 * - zones.json 의 rect(cm) 를 캔버스에 fit 해서 각 방을 실제 크기로 렌더
 * - 아바타(원) = 태그 소지자. pos:update(cm 좌표) 를 동일 변환으로 배치
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

const CW = 1280;
const CH = 800;
const PAD = 24;
const TOP = 52; // 제목 영역

const ZONE_COLORS: Record<string, number> = {
  waiting: 0x2d6a4f,
  reception: 0x1d5d8f,
  consult: 0x7b4b94,
  surgery: 0x9d4444,
  laser: 0xc75b39,
  recovery: 0xb07d3a,
  skincare: 0x2a8a8a,
  staff: 0x555b6e,
  etc: 0x444444,
};

const AVATAR_COLORS = [0xffd166, 0xef476f, 0x06d6a0, 0x118ab2, 0xf78c6b, 0x9b5de5];

class StaffMapScene extends Phaser.Scene {
  private socket!: Socket;
  private zones = new Map<string, Zone>();
  private avatars = new Map<string, Phaser.GameObjects.Container>();
  private avatarLabels = new Map<string, Phaser.GameObjects.Text>();
  private lastPosAt = new Map<string, number>();
  private tagMeta: TagMetaMap = {};

  // 월드(cm) → 화면 변환 (Phaser.Scene.scale 예약과 충돌 방지 위해 worldScale)
  private worldScale = 1;
  private minX = 0;
  private minY = 0;
  private absentPt = { x: CW - 90, y: CH - 60 };

  constructor() {
    super('staff-map');
  }

  private sx(x: number): number {
    return PAD + (x - this.minX) * this.worldScale;
  }
  private sy(y: number): number {
    return TOP + (y - this.minY) * this.worldScale;
  }

  async create(): Promise<void> {
    this.add.text(20, 14, 'MediTracker — 직원용 (도면 기반 전체 위치)', {
      color: '#ffffff',
      fontSize: '20px',
      fontStyle: 'bold',
    });

    const zones: Zone[] = await fetch(`${SERVER_URL}/zones`).then((r) => r.json());

    // 전체 rect 바운딩박스 → 캔버스에 fit
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const z of zones) {
      minX = Math.min(minX, z.rect.x);
      minY = Math.min(minY, z.rect.y);
      maxX = Math.max(maxX, z.rect.x + z.rect.w);
      maxY = Math.max(maxY, z.rect.y + z.rect.h);
    }
    this.minX = minX;
    this.minY = minY;
    this.worldScale = Math.min((CW - 2 * PAD) / (maxX - minX), (CH - TOP - PAD) / (maxY - minY));

    for (const zone of zones) {
      this.zones.set(zone.zoneId, zone);
      this.drawZone(zone);
    }

    // 자리비움 영역 (우하단)
    this.add
      .rectangle(this.absentPt.x, this.absentPt.y, 150, 70, 0x333333, 0.5)
      .setStrokeStyle(2, 0x777777, 1);
    this.add
      .text(this.absentPt.x, this.absentPt.y - 30, '자리비움', { color: '#999999', fontSize: '12px' })
      .setOrigin(0.5, 0);

    this.tagMeta = await fetch(`${SERVER_URL}/tag-meta`).then((r) => r.json());
    this.connect(await resolveToken());
  }

  private drawZone(zone: Zone): void {
    const x = this.sx(zone.rect.x);
    const y = this.sy(zone.rect.y);
    const w = zone.rect.w * this.worldScale;
    const h = zone.rect.h * this.worldScale;
    const color = ZONE_COLORS[zone.type] ?? ZONE_COLORS.etc;

    this.add.rectangle(x, y, w, h, color, 0.35).setOrigin(0, 0).setStrokeStyle(1.5, color, 1);
    this.add
      .text(x + w / 2, y + 3, zone.name, { color: '#e8e8e8', fontSize: '11px', align: 'center' })
      .setOrigin(0.5, 0);
  }

  private connect(token: string): void {
    this.socket = io(`${SERVER_URL}/staff`, { auth: { token } });

    this.socket.on('presence:update', (states: PresenceState[]) => {
      for (const state of states) this.upsertAvatar(state);
    });

    this.socket.on('presence:remove', ({ tagId }: { tagId: string }) => {
      this.lastPosAt.delete(tagId);
      const avatar = this.avatars.get(tagId);
      if (avatar) this.moveTo(avatar, null);
    });

    // RSSI 가중평균 연속 위치 (cm 좌표) → 동일 변환으로 부드럽게 이동
    this.socket.on('pos:update', (positions: PositionEstimate[]) => {
      for (const p of positions) {
        let avatar = this.avatars.get(p.tagId);
        if (!avatar) {
          avatar = this.makeAvatar(p.tagId);
          this.avatars.set(p.tagId, avatar);
        }
        this.lastPosAt.set(p.tagId, Date.now());
        this.tweens.killTweensOf(avatar);
        this.tweens.add({
          targets: avatar,
          x: this.sx(p.x),
          y: this.sy(p.y),
          duration: 480,
          ease: 'Linear',
        });
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
    // 연속 위치가 흐르는 동안은 존 스냅 생략 (tween 충돌 방지)
    if (Date.now() - (this.lastPosAt.get(state.tagId) ?? 0) < 2000) return;
    this.moveTo(avatar, state.currentZone);
  }

  private makeAvatar(tagId: string): Phaser.GameObjects.Container {
    const color = AVATAR_COLORS[this.avatars.size % AVATAR_COLORS.length];
    const circle = this.add.circle(0, 0, 9, color).setStrokeStyle(2, 0xffffff, 0.9);
    circle.setInteractive({ useHandCursor: true });
    circle.on('pointerdown', () => this.editMeta(tagId));
    const label = this.add
      .text(0, 12, this.labelFor(tagId), { color: '#ffffff', fontSize: '11px' })
      .setOrigin(0.5, 0);
    this.avatarLabels.set(tagId, label);
    return this.add.container(this.absentPt.x, this.absentPt.y, [circle, label]);
  }

  /** 존 스냅 이동 (연속 위치가 없을 때 fallback) — 존 중심으로 */
  private moveTo(avatar: Phaser.GameObjects.Container, zoneId: string | null): void {
    let tx: number, ty: number;
    if (zoneId === null) {
      tx = this.absentPt.x;
      ty = this.absentPt.y;
    } else {
      const zone = this.zones.get(zoneId);
      if (!zone) return;
      tx = this.sx(zone.tilePosition.x);
      ty = this.sy(zone.tilePosition.y);
    }
    const dist = Phaser.Math.Distance.Between(avatar.x, avatar.y, tx, ty);
    this.tweens.killTweensOf(avatar);
    this.tweens.add({
      targets: avatar,
      x: tx,
      y: ty,
      duration: Phaser.Math.Clamp(dist * 3, 400, 1600),
      ease: 'Sine.easeInOut',
    });
  }
}

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'app',
  width: CW,
  height: CH,
  backgroundColor: '#1a1a2e',
  scene: [StaffMapScene],
});
(window as unknown as Record<string, unknown>).__game = game;
