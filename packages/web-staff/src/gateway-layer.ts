import Phaser from 'phaser';
import { RX_FLOOR, computeCoverage, type CoverageResult, type Gateway, type Zone } from '@meditracker/shared';
import type { Pathfinder } from './pathfinder';

/**
 * 게이트웨이 위치와 **커버리지 범위** 보기 (직원용 화면 오버레이).
 *
 * 존 판정은 "가장 센 게이트웨이가 설치된 방" 으로 정해진다(불변식 3). 그래서 어느 지점을
 * 어느 게이트웨이가 먹고 있는지를 눈으로 볼 수 있으면, 옆방 게이트웨이가 이 방을 먹는
 * 구간 — 즉 **오판이 나올 자리** — 를 도면 위에서 바로 짚을 수 있다. 채터링 신고를
 * 받았을 때 제일 먼저 볼 화면이다.
 *
 * ⚠️ **모델 예측이다.** `shared/rssi-model.ts` 의 경로손실 + 벽 관통 감쇠로 계산한
 *    값이고 가구·인체·안테나 지향성이 빠져 있다. 실제는 이보다 나쁘다. 화면에도
 *    그렇게 적어 둔다 — 이 그림을 실측으로 오해하면 배치를 잘못 정한다.
 *
 * 통제구역 오버레이와 같은 방식(캔버스 텍스처 → 도면 크기 이미지)이라 확대·이동이
 * 그대로 따라온다.
 */

export type GatewayMode = 'off' | 'owner' | 'signal';

/** 커버리지 격자 한 칸 = 벽 격자 몇 칸. 8 = 도면 32px ≈ 52cm */
const COVERAGE_STEP = 8;
/** 색을 고르게 흩는 각도 (황금각) — 옆 게이트웨이끼리 비슷한 색이 안 되게 */
const HUE_STEP = 137.508;
const OVERLAY_ALPHA = 0.42;
/** 이 배율 이상으로 확대하면 게이트웨이 라벨을 보여준다 (기본 배율에선 50개가 겹친다) */
const LABEL_ZOOM = 2.2;
/** 신호 색 구간 — 이보다 세면 진한 초록, RX_FLOOR 에 가까우면 빨강 */
const SIGNAL_STRONG = -45;
/**
 * 게이트웨이 마커 — 흰 도면에서도, 색칠된 커버리지 위에서도 튀어야 한다.
 * 빨강 + 흰 테두리 + 검은 외곽선 3중이라 어떤 배경색에서도 사라지지 않는다.
 */
const GW_DOT_COLOR = 0xe8102a;
const GW_DOT_R = 5.5;

export interface GatewayLayerDeps {
  scene: Phaser.Scene;
  pf: Pathfinder;
  gateways: Gateway[];
  zones: Map<string, Zone>;
  /** 도면 좌표 → 화면 좌표 */
  sx: (x: number) => number;
  sy: (y: number) => number;
  worldScale: number;
  plan: { width: number; height: number };
  /** 확대해도 안 커지는 UI 카메라가 이 오버레이를 무시하도록 */
  ignore: (obj: Phaser.GameObjects.GameObject) => void;
  /** 마커를 눌러 한 대만 보게 됐을 때 — 버튼 아래 설명을 다시 그리게 알린다 */
  onChange?: () => void;
}

export class GatewayLayer {
  private mode: GatewayMode = 'off';
  private isolated: number | null = null;
  private coverage?: CoverageResult;
  private overlay?: Phaser.GameObjects.Image;
  private markers?: Phaser.GameObjects.Container;
  private labels: Phaser.GameObjects.Text[] = [];
  /** 게이트웨이 마커 (빨간 점). 레이어를 켤 때만 보이므로 비콘 아바타와 헷갈리지 않는다 */
  private dots: Phaser.GameObjects.Arc[] = [];
  /** 마커 바깥 검은 테두리 — 밝은 커버리지 색 위에서 흰 테두리가 묻히는 것을 막는다 */
  private rims: Phaser.GameObjects.Arc[] = [];
  /** 텍스처 이름을 모드별로 나눠 두 번 계산하지 않는다 */
  private drawn = new Set<string>();

  constructor(private d: GatewayLayerDeps) {}

  get current(): GatewayMode {
    return this.mode;
  }

  get isolatedLabel(): string | null {
    if (this.isolated === null) return null;
    const g = this.d.gateways[this.isolated];
    return `${g.gatewayId} ${g.label}`;
  }

  /**
   * 한가할 때 미리 계산해 둔다.
   *
   * 계산이 1.4초쯤 걸려서 버튼을 누른 순간에 하면 그동안 화면이 멈춘다(아바타도 굳는다).
   * 도면·게이트웨이는 안 바뀌니 부팅 뒤 한가한 틈에 해 두면 클릭은 즉시 반응한다.
   */
  warmUp(): void {
    const run = (): void => void this.ensureCoverage();
    const idle = (window as { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback;
    if (idle) idle(run);
    else setTimeout(run, 1500); // 지원 안 하는 브라우저는 첫 렌더가 끝난 뒤에
  }

  /** 커버리지는 처음 켤 때 한 번만 계산한다 (도면·게이트웨이가 안 바뀌므로) */
  private ensureCoverage(): CoverageResult {
    if (!this.coverage) {
      const gws = this.d.gateways
        .filter((g) => g.tile)
        .map((g) => ({ gatewayId: g.gatewayId, zoneId: g.zoneId, tile: g.tile! }));
      this.coverage = computeCoverage(this.d.pf, gws, { step: COVERAGE_STEP });
    }
    return this.coverage;
  }

  setMode(mode: GatewayMode): void {
    this.mode = mode;
    if (mode === 'off') {
      this.overlay?.setVisible(false);
      this.markers?.setVisible(false);
      return;
    }
    this.ensureMarkers().setVisible(true);
    this.paint();
  }

  /** 게이트웨이 하나만 보기 (마커 클릭). 같은 것을 다시 누르면 해제 */
  isolate(index: number | null): void {
    this.isolated = this.isolated === index ? null : index;
    for (const [i, dot] of this.dots.entries()) {
      const picked = this.isolated === i;
      // 한 대만 볼 때 나머지는 흐려서 뒤로 물러나 보이게 한다 (지우지는 않는다 —
      // 옆 게이트웨이가 어디 있는지 같이 봐야 배치 판단이 된다)
      const dim = this.isolated !== null && !picked;
      dot.setAlpha(dim ? 0.35 : 1);
      dot.setScale(picked ? 1.6 : 1);
      this.rims[i]?.setAlpha(dim ? 0.2 : 0.55).setScale(picked ? 1.6 : 1);
      this.labels[i]?.setAlpha(dim ? 0.4 : 1);
    }
    if (this.mode !== 'off') this.paint();
    this.d.onChange?.();
  }

  /** 확대 배율이 바뀔 때 — 겹쳐 읽을 수 없는 배율에서는 라벨을 숨긴다 */
  onZoom(zoom: number): void {
    const show = this.mode !== 'off' && zoom >= LABEL_ZOOM;
    for (const t of this.labels) t.setVisible(show);
  }

  private paint(): void {
    const key = `gwcov-${this.mode}-${this.isolated ?? 'all'}`;
    if (!this.drawn.has(key)) {
      this.d.scene.textures.addCanvas(key, this.render());
      this.drawn.add(key);
    }
    const img = this.ensureOverlay();
    img.setTexture(key);
    img.setVisible(true);
  }

  private ensureOverlay(): Phaser.GameObjects.Image {
    if (!this.overlay) {
      // 도면 위, 아바타 아래에 깔린다 (아바타는 나중에 만들어져 위로 온다)
      this.overlay = this.d.scene.add
        .image(this.d.sx(0), this.d.sy(0), '__MISSING')
        .setOrigin(0, 0)
        .setDisplaySize(this.d.plan.width * this.d.worldScale, this.d.plan.height * this.d.worldScale)
        .setAlpha(OVERLAY_ALPHA);
      this.d.ignore(this.overlay);
    }
    return this.overlay;
  }

  /** 커버리지를 도면 크기 캔버스에 칸칸이 칠한다 */
  private render(): HTMLCanvasElement {
    const cov = this.ensureCoverage();
    const c = document.createElement('canvas');
    c.width = this.d.plan.width;
    c.height = this.d.plan.height;
    const ctx = c.getContext('2d')!;
    const size = cov.cellPx;
    const half = size / 2;

    for (const cell of cov.cells) {
      const color = this.colorFor(cell.bestIdx, cell.best);
      if (!color) continue;
      ctx.fillStyle = color;
      ctx.fillRect(cell.x - half, cell.y - half, size, size);
    }
    return c;
  }

  private colorFor(bestIdx: number, best: number): string | null {
    if (bestIdx < 0) return null; // 사각지대 — 안 칠하고 도면을 그대로 보여준다
    if (this.isolated !== null) {
      // 그 한 대가 가장 센 구간만. 세기에 따라 진하게
      if (bestIdx !== this.isolated) return null;
      return this.signalColor(best);
    }
    if (this.mode === 'signal') return this.signalColor(best);
    // 담당 게이트웨이별 색
    return `hsl(${(bestIdx * HUE_STEP) % 360} 72% 55%)`;
  }

  /** 강함(초록) → 약함(빨강) */
  private signalColor(dbm: number): string {
    const t = Math.max(0, Math.min(1, (dbm - RX_FLOOR) / (SIGNAL_STRONG - RX_FLOOR)));
    return `hsl(${t * 120} 78% ${38 + t * 14}%)`;
  }

  private ensureMarkers(): Phaser.GameObjects.Container {
    if (this.markers) return this.markers;
    const layer = this.d.scene.add.container(0, 0);
    for (const [i, g] of this.d.gateways.entries()) {
      if (!g.tile) continue;
      const x = this.d.sx(g.tile.x);
      const y = this.d.sy(g.tile.y);
      // 빨간 점 + 흰 테두리 + 검은 외곽선. 커버리지를 칠한 위에서도 확실히 보인다
      const rim = this.d.scene.add.circle(x, y, GW_DOT_R + 2.5, 0x000000, 0.55);
      const dot = this.d.scene.add
        .circle(x, y, GW_DOT_R, GW_DOT_COLOR)
        .setStrokeStyle(2, 0xffffff, 1)
        .setInteractive({ useHandCursor: true });
      dot.on('pointerup', (p: Phaser.Input.Pointer) => {
        if (p.getDistance() < 8) this.isolate(i); // 도면을 끄는 중이면 선택이 아니다
      });
      const zone = this.d.zones.get(g.zoneId)?.name ?? g.zoneId;
      dot.setData('tip', `${g.gatewayId} · ${zone}`);
      const label = this.d.scene.add
        .text(x, y - 9, g.gatewayId, {
          fontFamily: 'sans-serif',
          fontSize: '9px',
          color: '#0d1520',
          backgroundColor: '#ffffffdd',
          padding: { x: 2, y: 0 },
        })
        .setOrigin(0.5, 1)
        .setVisible(false);
      this.rims.push(rim);
      this.dots.push(dot);
      this.labels.push(label);
      layer.add([rim, dot, label]);
    }
    this.d.ignore(layer);
    this.markers = layer;
    return layer;
  }
}
