import { RX_FLOOR, USABLE_RSSI, rssiAt } from './rssi-model.js';

/**
 * 게이트웨이 커버리지 계산 — "이 지점은 어느 게이트웨이가 가장 세게 듣나".
 *
 * 직원용 화면의 게이트웨이 범위 보기가 이걸로 오버레이를 그리고, 배치 검토 도구
 * (`npm run gateway:plan`)가 같은 함수로 대수를 줄여 본다. 화면과 계획이 같은 숫자를
 * 봐야 "화면에선 되던데" 가 안 생긴다.
 *
 * ⚠️ 모델 예측이다 (`rssi-model.ts` 주석 참고). 실측이 아니다.
 */

/** 벽 격자. 프론트 `Pathfinder` 와 서버 `WalkableMap` 둘 다 이 모양을 만족시킨다 */
export interface BlockedGrid {
  readonly cell: number;
  readonly cols: number;
  readonly rows: number;
  isWalkable(px: number, py: number): boolean;
}

export interface CoverageGateway {
  gatewayId: string;
  zoneId: string;
  tile: { x: number; y: number };
}

export interface CoverageCell {
  /** 도면 좌표 (셀 중심) */
  x: number;
  y: number;
  /** 가장 센 수신세기(dBm). 아무도 못 들으면 `RX_FLOOR` 미만을 뜻하는 -Infinity */
  best: number;
  /** 가장 센 게이트웨이의 인덱스 (-1 = 사각지대) */
  bestIdx: number;
  /** 두 번째로 센 게이트웨이 인덱스 — 1대를 빼면 누가 대신 먹는지 바로 알 수 있다 */
  secondIdx: number;
  /**
   * 이긴 게이트웨이와 **다른 존**에 설치된 것 중 가장 센 세기.
   *
   * `best - otherZoneBest` 가 이 지점의 **판정 여유**다. 이 값이 히스테리시스보다 작으면
   * 잡음 몇 dB 로 방이 뒤집힌다 — 채터링이 나는 자리는 커버리지가 아니라 여기서 보인다.
   * 벽이 얇을수록(가벽) 옆방 신호가 덜 깎여서 이 여유가 줄어든다.
   */
  otherZoneBest: number;
  otherZoneIdx: number;
  /** `USABLE_RSSI` 이상으로 듣는 게이트웨이 대수 (좌표 추정에 기여하는 수) */
  heard: number;
}

export interface CoverageResult {
  /** 몇 개의 벽 격자 셀을 한 칸으로 묶었나 */
  step: number;
  /** 한 칸의 도면 픽셀 크기 */
  cellPx: number;
  cells: CoverageCell[];
}

/** 두 점 사이를 지나는 벽 개수 (연속한 벽 셀은 1개로 센다) */
export function wallsBetween(
  grid: BlockedGrid,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / (grid.cell / 2)));
  let walls = 0;
  let inWall = false;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const blocked = !grid.isWalkable(x0 + dx * t, y0 + dy * t);
    if (blocked && !inWall) walls++;
    inWall = blocked;
  }
  return walls;
}

/**
 * 통행 가능한 지점을 `step` 칸마다 훑어 커버리지를 낸다.
 *
 * @param step 벽 격자 몇 칸을 한 칸으로 묶을지. 기본 8 = 도면 32px ≈ 52cm.
 *             1로 내리면 정확해지지만 셀이 64배 늘어 브라우저가 버벅인다.
 */
export function computeCoverage(
  grid: BlockedGrid,
  gateways: readonly CoverageGateway[],
  opts: { step?: number; wallLossDb?: number } = {},
): CoverageResult {
  const step = opts.step ?? 8;
  const cells: CoverageCell[] = [];

  for (let gy = 0; gy < grid.rows; gy += step) {
    for (let gx = 0; gx < grid.cols; gx += step) {
      const x = (gx + 0.5) * grid.cell;
      const y = (gy + 0.5) * grid.cell;
      if (!grid.isWalkable(x, y)) continue;

      let best = Number.NEGATIVE_INFINITY;
      let bestIdx = -1;
      let second = Number.NEGATIVE_INFINITY;
      let secondIdx = -1;
      let heard = 0;
      // 존별 최댓값을 들고 있다가 나중에 '이긴 존이 아닌 것 중 최댓값' 을 뽑는다.
      // 한 번 훑는 동안엔 누가 이길지 모르므로 존별로 모아 두는 수밖에 없다.
      const perZone = new Map<string, { rssi: number; idx: number }>();

      for (let i = 0; i < gateways.length; i++) {
        const g = gateways[i];
        const dist = Math.hypot(g.tile.x - x, g.tile.y - y);
        // 벽이 하나도 없다고 봐도 못 들리는 거리면 벽을 셀 필요가 없다.
        // 벽은 세기를 깎기만 하므로 이 건너뛰기는 결과를 바꾸지 않는다 (그냥 빠르다).
        if (rssiAt(dist, 0, 0, opts.wallLossDb) === null) continue;
        const walls = wallsBetween(grid, x, y, g.tile.x, g.tile.y);
        const rssi = rssiAt(dist, walls, 0, opts.wallLossDb);
        if (rssi === null) continue;
        if (rssi >= USABLE_RSSI) heard++;
        const prev = perZone.get(g.zoneId);
        if (!prev || rssi > prev.rssi) perZone.set(g.zoneId, { rssi, idx: i });
        if (rssi > best) {
          second = best;
          secondIdx = bestIdx;
          best = rssi;
          bestIdx = i;
        } else if (rssi > second) {
          second = rssi;
          secondIdx = i;
        }
      }

      let otherZoneBest = Number.NEGATIVE_INFINITY;
      let otherZoneIdx = -1;
      if (bestIdx >= 0) {
        const wonZone = gateways[bestIdx].zoneId;
        for (const [zoneId, v] of perZone) {
          if (zoneId === wonZone) continue;
          if (v.rssi > otherZoneBest) {
            otherZoneBest = v.rssi;
            otherZoneIdx = v.idx;
          }
        }
      }
      cells.push({ x, y, best, bestIdx, secondIdx, otherZoneBest, otherZoneIdx, heard });
    }
  }
  return { step, cellPx: grid.cell * step, cells };
}

export interface CoverageStats {
  cells: number;
  /** 아무 게이트웨이도 못 듣는 칸 — 여기 있는 비콘은 사라진 것으로 보인다 */
  dead: number;
  /** 1대만 듣는 칸 — 존 판정은 되지만 좌표 추정(가중평균)이 성립하지 않는다 */
  single: number;
  /** 3대 미만 — 좌표가 불안정해지는 구간 */
  under3: number;
  /** 가장 센 신호의 분위 (dBm) */
  worst: number;
  p10: number;
  median: number;
  /**
   * 판정 여유 = 이긴 게이트웨이 − 다른 존 중 가장 센 것 (dB).
   * 이 값이 작은 칸이 곧 채터링이 나는 자리다.
   */
  marginP10: number;
  marginMedian: number;
  /** 여유가 히스테리시스(dB)보다 작은 칸 — 잡음 몇 dB 로 방이 뒤집힌다 */
  fragile: (hysteresisDb: number) => number;
}

export function coverageStats(result: CoverageResult): CoverageStats {
  const best = result.cells.map((c) => c.best).filter((v) => Number.isFinite(v));
  best.sort((a, b) => a - b);
  const at = (p: number): number => (best.length === 0 ? RX_FLOOR : best[Math.floor(best.length * p)]);

  // 다른 존 후보가 아예 없는 칸(게이트웨이가 한 곳뿐)은 여유를 말할 수 없어 제외한다
  const margins = result.cells
    .filter((c) => c.bestIdx >= 0 && Number.isFinite(c.otherZoneBest))
    .map((c) => c.best - c.otherZoneBest)
    .sort((a, b) => a - b);
  const mAt = (p: number): number =>
    margins.length === 0 ? Number.POSITIVE_INFINITY : margins[Math.floor(margins.length * p)];

  return {
    cells: result.cells.length,
    dead: result.cells.filter((c) => c.bestIdx === -1).length,
    single: result.cells.filter((c) => c.heard === 1).length,
    under3: result.cells.filter((c) => c.heard < 3).length,
    worst: at(0),
    p10: at(0.1),
    median: at(0.5),
    marginP10: mAt(0.1),
    marginMedian: mAt(0.5),
    fragile: (hysteresisDb) => margins.filter((m) => m < hysteresisDb).length,
  };
}
