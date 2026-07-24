import Phaser from 'phaser';
import { io, type Socket } from 'socket.io-client';
import type { PositionEstimate, PresenceState, Zone } from '@meditracker/shared';

/**
 * 직원용 화면 (설계서 8) — 임시 시각화 버전
 * - Tiled 타일맵(Phase 3) 전까지 존을 사각형으로 그린 간이 평면도
 * - 아바타(원) = 태그 소지자. 존 변경 시 tween 이동 (서버가 채터링 억제하므로 떨림 없음)
 * - namespace: /staff — 서버가 권한 필터링한 presence:update 만 수신
 *
 * ⚠️ 불변식 B-5: 브라우저 스토리지(localStorage 등) 사용 금지.
 */

const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? 'http://localhost:8080';

/** ?token= 이 있으면 사용, 없으면 개발용 토큰 자동 발급 (Phase 2 로그인 화면에서 대체) */
async function resolveToken(): Promise<string> {
  const urlToken = new URLSearchParams(window.location.search).get('token');
  if (urlToken) return urlToken;
  const res = await fetch(`${SERVER_URL}/dev-token?type=staff`);
  return (await res.json()).token;
}

// 관리자 모드 버튼 → 서버 관제 페이지. back= 로 이 화면 복귀 경로 전달.
const adminBtn = document.getElementById('admin-btn') as HTMLAnchorElement | null;
if (adminBtn) {
  adminBtn.href = `${SERVER_URL}/monitor?back=${encodeURIComponent(window.location.href)}`;
}

const TILE = 40;
const ZONE_W = 150;
const ZONE_H = 110;

const ZONE_COLORS: Record<string, number> = {
  waiting: 0x2d6a4f,
  reception: 0x1d5d8f,
  consult: 0x7b4b94,
  surgery: 0x9d4444,
  recovery: 0xb07d3a,
  staff: 0x555b6e,
  etc: 0x444444,
};

const AVATAR_COLORS = [0xffd166, 0xef476f, 0x06d6a0, 0x118ab2, 0xf78c6b, 0x9b5de5];

class StaffMapScene extends Phaser.Scene {
  private socket!: Socket;
  private zones = new Map<string, Zone>();
  private avatars = new Map<string, Phaser.GameObjects.Container>(); // tagId → avatar
  private zoneOccupants = new Map<string, string[]>(); // zoneId → tagIds (배치 오프셋용)
  private lastPosAt = new Map<string, number>(); // 연속 위치 수신 시각 (존 스냅과 충돌 방지)
  private absentArea = { x: 1100, y: 720 };

  constructor() {
    super('staff-map');
  }

  async create(): Promise<void> {
    this.add.text(20, 14, 'MediTracker — 직원용 (전체 위치)', {
      color: '#ffffff',
      fontSize: '22px',
      fontStyle: 'bold',
    });

    // 존 레이아웃 로드 → 간이 평면도
    const zones: Zone[] = await fetch(`${SERVER_URL}/zones`).then((r) => r.json());
    for (const zone of zones) {
      this.zones.set(zone.zoneId, zone);
      this.drawZone(zone);
    }

    // 자리비움 영역
    this.add
      .rectangle(this.absentArea.x, this.absentArea.y, ZONE_W, ZONE_H, 0x333333, 0.5)
      .setStrokeStyle(2, 0x777777, 1);
    this.add
      .text(this.absentArea.x, this.absentArea.y - ZONE_H / 2 + 12, '자리비움', {
        color: '#999999',
        fontSize: '14px',
      })
      .setOrigin(0.5, 0);

    this.connect(await resolveToken());
  }

  private drawZone(zone: Zone): void {
    const x = zone.tilePosition.x * TILE;
    const y = zone.tilePosition.y * TILE;
    const color = ZONE_COLORS[zone.type] ?? ZONE_COLORS.etc;

    this.add.rectangle(x, y, ZONE_W, ZONE_H, color, 0.35).setStrokeStyle(2, color, 1);
    this.add
      .text(x, y - ZONE_H / 2 + 8, zone.name, { color: '#dddddd', fontSize: '14px' })
      .setOrigin(0.5, 0);
  }

  private connect(token: string): void {
    this.socket = io(`${SERVER_URL}/staff`, { auth: { token } });

    this.socket.on('presence:update', (states: PresenceState[]) => {
      for (const state of states) this.upsertAvatar(state);
    });

    this.socket.on('presence:remove', ({ tagId }: { tagId: string }) => {
      const avatar = this.avatars.get(tagId);
      this.lastPosAt.delete(tagId);
      if (avatar) this.moveTo(avatar, tagId, null);
    });

    // RSSI 가중평균 연속 위치 (0.5초 주기) — 존 스냅 대신 부드러운 실시간 이동
    this.socket.on('pos:update', (positions: PositionEstimate[]) => {
      for (const p of positions) {
        let avatar = this.avatars.get(p.tagId);
        if (!avatar) {
          avatar = this.makeAvatar(p.tagId);
          this.avatars.set(p.tagId, avatar);
        }
        this.lastPosAt.set(p.tagId, Date.now());
        this.tweens.killTweensOf(avatar); // 이전 tween 정리 (누적 방지)
        this.tweens.add({
          targets: avatar,
          x: p.x * TILE,
          y: p.y * TILE,
          duration: 480, // 서버 주기(500ms)에 맞춰 끊김 없이 미끄러지게
          ease: 'Linear',
        });
      }
    });

    this.socket.on('connect_error', (err) => {
      console.error('[ws] connect error:', err.message);
      this.add.text(20, 50, `연결 실패: ${err.message} (?token= 확인)`, { color: '#ff6b6b' });
    });
  }

  private upsertAvatar(state: PresenceState): void {
    console.log('[presence]', state.tagId, '→', state.currentZone);
    let avatar = this.avatars.get(state.tagId);
    if (!avatar) {
      avatar = this.makeAvatar(state.tagId);
      this.avatars.set(state.tagId, avatar);
    }
    // 연속 위치(pos:update)가 흐르는 동안은 존 스냅 이동 생략 (tween 충돌 방지)
    const last = this.lastPosAt.get(state.tagId) ?? 0;
    if (Date.now() - last < 2000) return;
    this.moveTo(avatar, state.tagId, state.currentZone);
  }

  private makeAvatar(tagId: string): Phaser.GameObjects.Container {
    const color = AVATAR_COLORS[this.avatars.size % AVATAR_COLORS.length];
    const circle = this.add.circle(0, 0, 14, color).setStrokeStyle(2, 0xffffff, 0.9);
    const label = this.add
      .text(0, 22, tagId.slice(-5), { color: '#ffffff', fontSize: '11px' })
      .setOrigin(0.5, 0);
    return this.add.container(this.absentArea.x, this.absentArea.y, [circle, label]);
  }

  /** 존 중심 + 점유 순번별 오프셋으로 tween 이동 */
  private moveTo(avatar: Phaser.GameObjects.Container, tagId: string, zoneId: string | null): void {
    // 이전 존 점유 목록에서 제거
    for (const [zid, tags] of this.zoneOccupants) {
      const i = tags.indexOf(tagId);
      if (i >= 0) {
        tags.splice(i, 1);
        if (tags.length === 0) this.zoneOccupants.delete(zid);
      }
    }

    let target: { x: number; y: number };
    if (zoneId === null) {
      target = this.absentArea;
    } else {
      const zone = this.zones.get(zoneId);
      if (!zone) return;
      const occupants = this.zoneOccupants.get(zoneId) ?? [];
      occupants.push(tagId);
      this.zoneOccupants.set(zoneId, occupants);
      const idx = occupants.length - 1;
      target = {
        x: zone.tilePosition.x * TILE - 40 + (idx % 3) * 40,
        y: zone.tilePosition.y * TILE - 4 + Math.floor(idx / 3) * 36,
      };
    }

    // 거리 비례 이동 시간 (0.8초~2.5초) — 순간이동처럼 안 보이게
    const dist = Phaser.Math.Distance.Between(avatar.x, avatar.y, target.x, target.y);
    this.tweens.killTweensOf(avatar);
    this.tweens.add({
      targets: avatar,
      x: target.x,
      y: target.y,
      duration: Phaser.Math.Clamp(dist * 2.5, 800, 2500),
      ease: 'Sine.easeInOut',
    });
  }
}

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'app',
  width: 1280,
  height: 800,
  backgroundColor: '#1a1a2e',
  scene: [StaffMapScene],
});
// 디버깅용 (콘솔에서 씬 상태 확인)
(window as unknown as Record<string, unknown>).__game = game;
