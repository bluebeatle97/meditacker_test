import { CM_PER_PX, PATH_LOSS_N, TX_AT_1M } from '@meditracker/shared';

/**
 * RSSI → 거리 → 최소자승 다변측량 (무게중심 방식의 대안).
 *
 * 무게중심은 게이트웨이 좌표를 세기로 섞기만 해서 두 가지를 구조적으로 못 한다:
 * **다각형 바깥을 못 가리키고**, 가장자리에서는 안쪽으로 수축한다. 실제로 창고
 * 게이트웨이 바로 옆에 둔 비콘이 2~2.7m 안쪽으로 밀렸다.
 *
 * 여기서는 거리를 실제로 계산해 원들의 교점을 찾는다. 미지수가 둘(x, y)인데 게이트웨이가
 * 여럿이면 과결정이라, 흔들리는 관측 여러 개가 서로를 깎아 준다 — 무게중심에는 없는 성질이다.
 *
 * ⚠️ 만능이 아니다. 재료인 RSSI 자체가 현장에서 20dB 넘게 출렁이고(다중경로), 벽 하나가
 *    거리로 환산되면 몇 미터로 둔갑한다. 무게중심보다 **덜 틀릴 뿐** 정밀 측위가 아니다.
 */

/** 실내 경로손실 역산: RSSI → 도면 픽셀 거리 */
export function rssiToPx(rssi: number): number {
  const meters = Math.pow(10, (TX_AT_1M - rssi) / (10 * PATH_LOSS_N));
  return (meters * 100) / CM_PER_PX;
}

export interface Anchor {
  x: number;
  y: number;
  rssi: number;
}

/**
 * 가우스-뉴턴으로 `Σ w·(‖p−gᵢ‖ − dᵢ)²` 을 줄인다. 시작점은 호출자가 준다 —
 * 무게중심을 넣으면 이미 답 근처에서 출발하므로 몇 번만 돌면 수렴한다.
 *
 * 가중치는 센 신호일수록 크게 둔다. 약한 신호는 거리 환산 오차가 지수적으로 커져서
 * (−90dBm 근처에서는 몇 dB 차이가 몇 미터가 된다) 같은 무게로 두면 그쪽이 답을 끌고 간다.
 *
 * @returns 수렴한 좌표. 앵커가 3개 미만이면 `null` (평면을 정할 수 없다).
 */
export function trilaterate(
  anchors: Anchor[],
  start: { x: number; y: number },
  iterations = 12,
): { x: number; y: number } | null {
  if (anchors.length < 3) return null;

  const d = anchors.map((a) => rssiToPx(a.rssi));
  // 세기 → 가중치. 10dB 셀 때마다 10배 (거리 오차가 그만큼 작다는 뜻)
  const w = anchors.map((a) => Math.pow(10, (a.rssi + 100) / 10));

  let px = start.x;
  let py = start.y;

  for (let it = 0; it < iterations; it++) {
    // 정규방정식 (JᵀWJ)Δ = −JᵀWe 를 2×2 로 직접 푼다
    let a11 = 0;
    let a12 = 0;
    let a22 = 0;
    let b1 = 0;
    let b2 = 0;

    for (let i = 0; i < anchors.length; i++) {
      const dx = px - anchors[i].x;
      const dy = py - anchors[i].y;
      // 앵커 위에 정확히 올라가면 0으로 나눈다 — 1px 로 막는다
      const r = Math.max(Math.hypot(dx, dy), 1);
      const jx = dx / r;
      const jy = dy / r;
      const e = r - d[i];
      const wi = w[i];
      a11 += wi * jx * jx;
      a12 += wi * jx * jy;
      a22 += wi * jy * jy;
      b1 -= wi * jx * e;
      b2 -= wi * jy * e;
    }

    // 앵커가 한 직선 위에 몰리면 특이행렬이 된다 (그 방향은 결정되지 않는다)
    const det = a11 * a22 - a12 * a12;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-9) break;

    let sx = (a22 * b1 - a12 * b2) / det;
    let sy = (a11 * b2 - a12 * b1) / det;

    /**
     * 한 걸음의 크기를 막는다. 관측이 서로 모순되면(벽 때문에 흔한 일이다) 가우스-뉴턴이
     * 도면 밖으로 튀어 나가는데, 그러면 화면에서 아바타가 순간이동한 것처럼 보인다.
     */
    const step = Math.hypot(sx, sy);
    const MAX_STEP = 400; // 도면 px ≈ 6.5m
    if (step > MAX_STEP) {
      sx = (sx / step) * MAX_STEP;
      sy = (sy / step) * MAX_STEP;
    }

    px += sx;
    py += sy;
    if (Math.hypot(sx, sy) < 0.5) break; // 더 움직여 봐야 화면에서 같은 픽셀
  }

  if (!Number.isFinite(px) || !Number.isFinite(py)) return null;
  return { x: px, y: py };
}
