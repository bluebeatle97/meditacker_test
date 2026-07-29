import Phaser from 'phaser';
import { io, type Socket } from 'socket.io-client';
import type { FloorplanMeta, Zone, ZoneAction } from '@meditracker/shared';

/**
 * 환자용 화면 (설계서 8) — 실제 도면 배경 방식
 * - 병원 도면(floorplan.png) 배경 + 본인 아바타 + 대기정보 HUD + 존 액션 버튼
 * - 타 환자 아바타 미표시 — 서버가 애초에 좌표를 안 보냄 (불변식 B-1)
 * - namespace: /patient
 *
 * ⚠️ 불변식 B-5: 브라우저 스토리지(localStorage 등) 사용 금지.
 */

const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? 'http://localhost:8080';

async function resolveToken(): Promise<string> {
  const urlToken = new URLSearchParams(window.location.search).get('token');
  if (urlToken) return urlToken;
  const res = await fetch(`${SERVER_URL}/dev-token?type=patient`);
  return (await res.json()).token;
}

const CW = 800;
const CH = 1280;
const MAP_TOP = 150;
const MAP_BOTTOM = 1150;
const PAD = 12;

class PatientScene extends Phaser.Scene {
  private socket!: Socket;
  private zones = new Map<string, Zone>();
  private hud!: Phaser.GameObjects.Text;
  private occupancyText!: Phaser.GameObjects.Text;
  private actionsBar!: Phaser.GameObjects.Container;
  private me!: Phaser.GameObjects.Container;

  private worldScale = 1;
  private offX = 0;
  private offY = 0;
  /** 본인 아바타 목표 좌표 — update() 에서 보간 이동 (tween 누적 방지) */
  private target: { x: number; y: number } | null = null;

  constructor() {
    super('patient');
  }

  private sx(x: number): number {
    return this.offX + x * this.worldScale;
  }
  private sy(y: number): number {
    return this.offY + y * this.worldScale;
  }

  async create(): Promise<void> {
    this.add.text(20, 14, 'MediTracker — 대기 안내', {
      color: '#ffffff',
      fontSize: '22px',
      fontStyle: 'bold',
    });
    this.hud = this.add.text(20, 50, '대기 정보를 불러오는 중…', {
      color: '#a8dadc',
      fontSize: '17px',
      lineSpacing: 6,
    });
    this.occupancyText = this.add.text(20, 118, '', { color: '#888888', fontSize: '14px' });
    this.actionsBar = this.add.container(20, MAP_BOTTOM + 24);

    const [plan, zones] = await Promise.all([
      fetch(`${SERVER_URL}/floorplan`).then((r) => r.json() as Promise<FloorplanMeta>),
      fetch(`${SERVER_URL}/zones`).then((r) => r.json() as Promise<Zone[]>),
    ]);
    for (const z of zones) this.zones.set(z.zoneId, z);

    this.worldScale = Math.min(
      (CW - 2 * PAD) / plan.width,
      (MAP_BOTTOM - MAP_TOP) / plan.height,
    );
    this.offX = (CW - plan.width * this.worldScale) / 2;
    this.offY = MAP_TOP;

    await this.loadPlanImage(plan.image);
    this.add
      .image(this.offX, this.offY, 'plan')
      .setOrigin(0, 0)
      .setDisplaySize(plan.width * this.worldScale, plan.height * this.worldScale);

    // 본인 아바타 (강조 링)
    const ring = this.add.circle(0, 0, 14, 0x000000, 0).setStrokeStyle(3, 0xffd166, 1);
    const dot = this.add.circle(0, 0, 8, 0xffd166);
    const label = this.add
      .text(0, 18, '나', { color: '#ffd166', fontSize: '13px' })
      .setOrigin(0.5, 0);
    this.me = this.add.container(CW / 2, (MAP_TOP + MAP_BOTTOM) / 2, [ring, dot, label]).setVisible(false);

    this.connect(await resolveToken());
  }

  /** ⚠️ create() 안에서 load.start() 는 씬을 LOADING 으로 되돌려 update() 를 멈춘다 */
  private async loadPlanImage(file: string): Promise<void> {
    const img = new Image();
    img.src = `/${file}`;
    await img.decode();
    this.textures.addImage('plan', img);
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
          this.me.setVisible(true);
          this.target = { x: this.sx(zone.tilePosition.x), y: this.sy(zone.tilePosition.y) };
        } else {
          this.me.setVisible(false);
          this.target = null;
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
      const t = this.add
        .text(this.me.x, this.me.y - 40, `${p.alias} ${p.emoji}`, { fontSize: '18px', color: '#ffffff' })
        .setOrigin(0.5);
      this.tweens.add({ targets: t, y: t.y - 30, alpha: 0, duration: 1500, onComplete: () => t.destroy() });
    });

    this.socket.on('connect_error', (err) => {
      console.error('[ws] connect error:', err.message);
      this.hud.setText(`연결 실패: ${err.message}`);
    });
  }

  /** 매 프레임 목표 좌표로 지수 보간 */
  update(_time: number, delta: number): void {
    if (!this.target) return;
    const k = 1 - Math.exp(-delta / 200);
    this.me.x += (this.target.x - this.me.x) * k;
    this.me.y += (this.target.y - this.me.y) * k;
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
