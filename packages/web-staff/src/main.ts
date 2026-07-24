import Phaser from 'phaser';
import { io, type Socket } from 'socket.io-client';
import type { PresenceState } from '@meditracker/shared';

/**
 * 직원용 화면 (설계서 8)
 * - 전체(권한 내) 아바타 표시, 존 클릭 → 인원 리스트, 존 색상 = 상태
 * - namespace: /staff — 서버가 권한 필터링한 presence:update 만 수신
 *
 * ⚠️ 불변식 B-5: 브라우저 스토리지(localStorage 등) 사용 금지 — 상태는 서버·메모리로.
 */

const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? 'http://localhost:8080';

// TODO: 실제 로그인 화면에서 JWT 발급받아 주입 (Phase 2)
const token = new URLSearchParams(window.location.search).get('token') ?? '';

class StaffMapScene extends Phaser.Scene {
  private socket!: Socket;
  private avatars = new Map<string, Phaser.GameObjects.Container>(); // tagId → avatar

  constructor() {
    super('staff-map');
  }

  preload(): void {
    // TODO Phase 3: Tiled 타일맵 로드 — this.load.tilemapTiledJSON('floor6', '/maps/floor6.tmj')
  }

  create(): void {
    this.add
      .text(20, 20, 'MediTracker 직원용 — 맵 준비 중 (Tiled .tmj 대기)', { color: '#ffffff' })
      .setDepth(100);

    this.socket = io(`${SERVER_URL}/staff`, { auth: { token } });

    this.socket.on('presence:update', (states: PresenceState[]) => {
      for (const state of states) this.upsertAvatar(state);
    });

    this.socket.on('presence:remove', ({ tagId }: { tagId: string }) => {
      this.avatars.get(tagId)?.destroy();
      this.avatars.delete(tagId);
    });

    this.socket.on('connect_error', (err) => {
      console.error('[ws] connect error:', err.message);
    });
  }

  private upsertAvatar(state: PresenceState): void {
    // TODO Phase 3: Zone.tilePosition 매핑 후 tween 이동. 지금은 콘솔 확인용.
    console.log('[presence]', state.tagId, '→', state.currentZone);
  }
}

new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'app',
  width: 1280,
  height: 800,
  backgroundColor: '#1a1a2e',
  scene: [StaffMapScene],
});
