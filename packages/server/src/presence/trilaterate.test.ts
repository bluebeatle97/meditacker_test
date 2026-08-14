import { describe, expect, it } from 'vitest';
import { CM_PER_PX, PATH_LOSS_N, TX_AT_1M } from '@meditracker/shared';
import { rssiToPx, trilaterate, type Anchor } from './trilaterate.js';

/** 정방향 모델 — 참 거리에서 게이트웨이가 읽었을 세기 */
function rssiAtPx(distPx: number): number {
  const meters = Math.max((distPx * CM_PER_PX) / 100, 0.3);
  return TX_AT_1M - 10 * PATH_LOSS_N * Math.log10(meters);
}

function anchorsFor(truth: { x: number; y: number }, gws: Array<[number, number]>): Anchor[] {
  return gws.map(([x, y]) => ({ x, y, rssi: rssiAtPx(Math.hypot(truth.x - x, truth.y - y)) }));
}

/** 무게중심 — 비교 기준 (`PositionEstimator` 과 같은 식) */
function centroid(anchors: Anchor[], div = 20): { x: number; y: number } {
  let w = 0;
  let x = 0;
  let y = 0;
  for (const a of anchors) {
    const wi = Math.pow(10, (a.rssi + 100) / div);
    w += wi;
    x += a.x * wi;
    y += a.y * wi;
  }
  return { x: x / w, y: y / w };
}

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y);

describe('rssiToPx', () => {
  it('정방향 모델과 왕복이 맞는다', () => {
    for (const px of [50, 200, 600]) {
      expect(rssiToPx(rssiAtPx(px))).toBeCloseTo(px, 0);
    }
  });
});

describe('trilaterate', () => {
  const SQUARE: Array<[number, number]> = [
    [0, 0],
    [600, 0],
    [0, 600],
    [600, 600],
  ];

  it('앵커 안쪽 지점을 잡아낸다', () => {
    const truth = { x: 180, y: 420 };
    const anchors = anchorsFor(truth, SQUARE);
    const got = trilaterate(anchors, centroid(anchors))!;
    expect(dist(got, truth)).toBeLessThan(5); // 도면 5px ≈ 8cm
  });

  /**
   * 무게중심으로는 **원리적으로 불가능한** 경우다. 답이 앵커들의 볼록껍질 밖에 있으면
   * 좌표를 아무리 섞어도 그 밖으로 못 나간다 — 현장에서 가장자리 게이트웨이 옆 비콘이
   * 안쪽으로 2~2.7m 밀렸던 게 이 현상이었다.
   */
  it('앵커 다각형 바깥도 가리킨다 — 무게중심은 못 하는 것', () => {
    const truth = { x: -250, y: 300 };
    const anchors = anchorsFor(truth, SQUARE);

    const mid = centroid(anchors);
    expect(mid.x).toBeGreaterThanOrEqual(0); // 껍질 밖으로 못 나간다

    const got = trilaterate(anchors, mid)!;
    expect(got.x).toBeLessThan(0);
    expect(dist(got, truth)).toBeLessThan(dist(mid, truth) / 2);
  });

  it('앵커가 3개 미만이면 포기한다 (평면이 안 정해진다)', () => {
    const truth = { x: 200, y: 200 };
    expect(trilaterate(anchorsFor(truth, SQUARE.slice(0, 2)), truth)).toBeNull();
  });

  it('한 직선 위에만 있으면 시작점을 크게 벗어나지 않는다', () => {
    const line: Array<[number, number]> = [
      [0, 0],
      [300, 0],
      [600, 0],
    ];
    const truth = { x: 300, y: 250 };
    const start = centroid(anchorsFor(truth, line));
    const got = trilaterate(anchorsFor(truth, line), start)!;
    expect(Number.isFinite(got.x) && Number.isFinite(got.y)).toBe(true);
    expect(dist(got, start)).toBeLessThan(700); // 발산해서 도면 밖으로 튀지 않는다
  });

  it('한 앵커가 크게 틀려도 나머지가 끌어당긴다', () => {
    const truth = { x: 300, y: 300 };
    const anchors = anchorsFor(truth, SQUARE);
    anchors[0].rssi -= 25; // 벽 하나가 낀 것처럼 — 그 원만 훨씬 크게 잡힌다
    const got = trilaterate(anchors, centroid(anchors))!;
    expect(dist(got, truth)).toBeLessThan(200); // 도면 200px ≈ 3.2m
  });
});
