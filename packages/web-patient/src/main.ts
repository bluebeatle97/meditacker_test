import Phaser from 'phaser';
import { io, type Socket } from 'socket.io-client';
import type { Zone, ZoneAction } from '@meditracker/shared';

/**
 * 환자용 화면 (설계서 8) — 임시 시각화 버전
 * - 간이 평면도 + 본인 아바타 + 대기정보 HUD + 존 액션 버튼
 * - 타 환자 아바타 미표시 — 서버가 애초에 좌표를 안 보냄 (불변식 B-1)
 * - namespace: /patient
 *
 * ⚠️ 불변식 B-5: 브라우저 스토리지(localStorage 등) 사용 금지.
 */

const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? 'http://localhost:8080';
const token = new URLSearchParams(window.location.search).get('token') ?? '';

const TILE = 24; // 환자 화면은 축소 스케일
const ZONE_W = 92;
const ZONE_H = 68;
const MAP_OFFSET_Y = 170;

const ZONE_COLORS: Record<string, number> = {
  waiting: 0x2d6a4f,
  reception: 0x1d5d8f,
  consult: 0x7b4b94,
  surgery: 0x9d4444,
  recovery: 0xb07d3a,
  staff: 0x555b6e,
  etc: 0x444444,
};

class PatientScene extends Phaser.Scene {
  private socket!: Socket;
  private zones = new Map<string, Zone>();
  private hud!: Phaser.GameObjects.Text;
  private occupancyText!: Phaser.GameObjects.Text;
  private actionsBar!: Phaser.GameObjects.Container;
  private me!: Phaser.GameObjects.Container;

  constructor() {
    super('patient');
  }

  async create(): Promise<void> {
    this.add.text(20, 14, 'MediTracker — 대기 안내', {
      color: '#ffffff',
      fontSize: '22px',
      fontStyle: 'bold',
    });

    this.hud = this.add.text(20, 52, '대기 정보를 불러오는 중…', {
      color: '#a8dadc',
      fontSize: '17px',
      lineSpacing: 6,
    });
    this.occupancyText = this.add.text(20, 128, '', { color: '#888888', fontSize: '14px' });
    this.actionsBar = this.add.container(20, 1180);

    const zones: Zone[] = await fetch(`${SERVER_URL}/zones`).then((r) => r.json());
    for (const zone of zones) {
      this.zones.set(zone.zoneId, zone);
      this.drawZone(zone);
    }

    // 본인 아바타 (강조 링)
    const ring = this.add.circle(0, 0, 17, 0x000000, 0).setStrokeStyle(3, 0xffd166, 1);
    const dot = this.add.circle(0, 0, 11, 0xffd166);
    const label = this.add.text(0, 24, '나', { color: '#ffd166', fontSize: '13px' }).setOrigin(0.5, 0);
    this.me = this.add.container(400, 640, [ring, dot, label]).setVisible(false);

    this.connect();
  }

  private drawZone(zone: Zone): void {
    const x = zone.tilePosition.x * TILE;
    const y = zone.tilePosition.y * TILE + MAP_OFFSET_Y;
    const color = ZONE_COLORS[zone.type] ?? ZONE_COLORS.etc;
    this.add.rectangle(x, y, ZONE_W, ZONE_H, color, 0.35).setStrokeStyle(2, color, 1);
    this.add
      .text(x, y - ZONE_H / 2 + 5, zone.name, { color: '#cccccc', fontSize: '11px' })
      .setOrigin(0.5, 0);
  }

  private connect(): void {
    this.socket = io(`${SERVER_URL}/patient`, { auth: { token } });

    this.socket.on(
      'presence:self',
      (p: { zone: string | null; waitingRank: number; estimatedWaitSec: number }) => {
        const zone = p.zone ? this.zones.get(p.zone) : null;
        this.hud.setText(
          `현재 위치: ${zone?.name ?? '추적 구역 밖'}\n대기 순번: ${p.waitingRank}번 · 예상 대기 ${Math.round(p.estimatedWaitSec / 60)}분`,
        );
        if (zone) {
          this.me.setVisible(true);
          this.tweens.add({
            targets: this.me,
            x: zone.tilePosition.x * TILE,
            y: zone.tilePosition.y * TILE + MAP_OFFSET_Y + 8,
            duration: 600,
            ease: 'Cubic.easeInOut',
          });
        } else {
          this.me.setVisible(false);
        }
      },
    );

    this.socket.on('zone:occupancy', (p: { zoneId: string; anonymousCount: number }) => {
      const zone = this.zones.get(p.zoneId);
      this.occupancyText.setText(`${zone?.name ?? p.zoneId}에 ${p.anonymousCount}명 대기 중`);
    });

    this.socket.on('zone:actions', (actions: ZoneAction[]) => {
      this.actionsBar.removeAll(true);
      actions.forEach((action, i) => {
        const btn = this.add
          .text(i * 180, 0, ` ${action.label} `, {
            color: '#ffffff',
            fontSize: '15px',
            backgroundColor: '#2b4a6f',
            padding: { x: 12, y: 8 },
          })
          .setInteractive({ useHandCursor: true })
          .on('pointerdown', () => this.socket.emit('action:invoke', { actionId: action.actionId }));
        this.actionsBar.add(btn);
      });
    });

    this.socket.on('reaction', (p: { alias: string; emoji: string; ts: number }) => {
      // 같은 존 이모티콘 — 화면에 잠깐 띄우기
      const t = this.add
        .text(this.me.x, this.me.y - 40, `${p.alias} ${p.emoji}`, { fontSize: '18px', color: '#ffffff' })
        .setOrigin(0.5);
      this.tweens.add({ targets: t, y: t.y - 30, alpha: 0, duration: 1500, onComplete: () => t.destroy() });
    });

    this.socket.on('connect_error', (err) => {
      console.error('[ws] connect error:', err.message);
      this.hud.setText(`연결 실패: ${err.message} (?token= 확인)`);
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
