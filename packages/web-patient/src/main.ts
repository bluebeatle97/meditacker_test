import Phaser from 'phaser';
import { io, type Socket } from 'socket.io-client';
import type { ZoneAction } from '@meditracker/shared';

/**
 * 환자용 화면 (설계서 8)
 * - 본인 아바타 + 대기정보 HUD + 존 이모티콘 + 존 액션 버튼
 * - 타 환자 아바타 미표시 — 서버가 애초에 좌표를 안 보냄 (불변식 B-1)
 * - namespace: /patient
 *
 * ⚠️ 불변식 B-5: 브라우저 스토리지(localStorage 등) 사용 금지.
 */

const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? 'http://localhost:8080';
const token = new URLSearchParams(window.location.search).get('token') ?? '';

class PatientScene extends Phaser.Scene {
  private socket!: Socket;
  private hud!: Phaser.GameObjects.Text;

  constructor() {
    super('patient');
  }

  create(): void {
    this.hud = this.add.text(20, 20, '대기 정보를 불러오는 중…', {
      color: '#ffffff',
      fontSize: '20px',
    });

    this.socket = io(`${SERVER_URL}/patient`, { auth: { token } });

    this.socket.on(
      'presence:self',
      (p: { zone: string | null; waitingRank: number; estimatedWaitSec: number }) => {
        const zoneLabel = p.zone ?? '추적 구역 밖';
        this.hud.setText(
          `현재 위치: ${zoneLabel}\n대기 순번: ${p.waitingRank}\n예상 대기: ${Math.round(p.estimatedWaitSec / 60)}분`,
        );
      },
    );

    this.socket.on('zone:occupancy', (p: { zoneId: string; anonymousCount: number }) => {
      console.log(`[occupancy] ${p.zoneId}: ${p.anonymousCount}명`);
    });

    this.socket.on('zone:actions', (actions: ZoneAction[]) => {
      // TODO Phase 4: 액션 버튼 렌더링 (대기순번보기 / 이모티콘 / FAQ / 체크인)
      console.log('[actions]', actions.map((a) => a.label).join(', '));
    });

    this.socket.on('reaction', (p: { alias: string; emoji: string; ts: number }) => {
      console.log(`[reaction] ${p.alias}: ${p.emoji}`);
    });

    this.socket.on('connect_error', (err) => {
      console.error('[ws] connect error:', err.message);
    });
  }
}

new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'app',
  width: 800,
  height: 1280,
  backgroundColor: '#16213e',
  scene: [PatientScene],
});
