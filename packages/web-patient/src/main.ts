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

/** ?token= 이 있으면 사용, 없으면 개발용 토큰 자동 발급 (Phase 2 로그인 화면에서 대체) */
async function resolveToken(): Promise<string> {
  const urlToken = new URLSearchParams(window.location.search).get('token');
  if (urlToken) return urlToken;
  const res = await fetch(`${SERVER_URL}/dev-token?type=patient`);
  return (await res.json()).token;
}

const CW = 800;
const CH = 1280;
const MAP_TOP = 170; // HUD 아래부터 맵
const MAP_BOTTOM = 1140; // 액션바 위까지
const PAD = 20;

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

class PatientScene extends Phaser.Scene {
  private socket!: Socket;
  private zones = new Map<string, Zone>();
  private hud!: Phaser.GameObjects.Text;
  private occupancyText!: Phaser.GameObjects.Text;
  private actionsBar!: Phaser.GameObjects.Container;
  private me!: Phaser.GameObjects.Container;
  private worldScale = 1;
  private minX = 0;
  private minY = 0;

  constructor() {
    super('patient');
  }

  private sx(x: number): number {
    return PAD + (x - this.minX) * this.worldScale;
  }
  private sy(y: number): number {
    return MAP_TOP + (y - this.minY) * this.worldScale;
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
    this.actionsBar = this.add.container(20, MAP_BOTTOM + 20);

    const zones: Zone[] = await fetch(`${SERVER_URL}/zones`).then((r) => r.json());
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const z of zones) {
      minX = Math.min(minX, z.rect.x);
      minY = Math.min(minY, z.rect.y);
      maxX = Math.max(maxX, z.rect.x + z.rect.w);
      maxY = Math.max(maxY, z.rect.y + z.rect.h);
    }
    this.minX = minX;
    this.minY = minY;
    this.worldScale = Math.min((CW - 2 * PAD) / (maxX - minX), (MAP_BOTTOM - MAP_TOP) / (maxY - minY));

    for (const zone of zones) {
      this.zones.set(zone.zoneId, zone);
      this.drawZone(zone);
    }

    // 본인 아바타 (강조 링)
    const ring = this.add.circle(0, 0, 17, 0x000000, 0).setStrokeStyle(3, 0xffd166, 1);
    const dot = this.add.circle(0, 0, 11, 0xffd166);
    const label = this.add.text(0, 24, '나', { color: '#ffd166', fontSize: '13px' }).setOrigin(0.5, 0);
    this.me = this.add.container(400, 640, [ring, dot, label]).setVisible(false);

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
      .text(x + w / 2, y + 2, zone.name, { color: '#cccccc', fontSize: '10px', align: 'center' })
      .setOrigin(0.5, 0);
  }

  private connect(token: string): void {
    this.socket = io(`${SERVER_URL}/patient`, { auth: { token } });

    this.socket.on(
      'presence:self',
      (p: { zone: string | null; waitingRank: number; estimatedWaitSec: number }) => {
        const zone = p.zone ? this.zones.get(p.zone) : null;
        this.hud.setText(
          `현재 위치: ${zone?.name ?? '추적 구역 밖'}\n대기 순번: ${p.waitingRank}번 · 예상 대기 ${Math.round(p.estimatedWaitSec / 60)}분`,
        );
        if (zone) {
          const tx = this.sx(zone.tilePosition.x);
          const ty = this.sy(zone.tilePosition.y);
          const dist = Phaser.Math.Distance.Between(this.me.x, this.me.y, tx, ty);
          this.me.setVisible(true);
          this.tweens.killTweensOf(this.me);
          this.tweens.add({
            targets: this.me,
            x: tx,
            y: ty,
            duration: Phaser.Math.Clamp(dist * 2.5, 800, 2500),
            ease: 'Sine.easeInOut',
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
  width: CW,
  height: CH,
  backgroundColor: '#16213e',
  scene: [PatientScene],
});
