import type { Gateway, PositionEstimate } from '@meditracker/shared';
import type { ZoneEngine } from '../zone-engine/zone-engine.js';
import { trilaterate, type Anchor } from './trilaterate.js';

/**
 * RSSI 가중평균 연속 위치 추정 (트래킹 시각화용 — 존 판정과 병행)
 *
 * 각 게이트웨이 설치 좌표를 신호 세기로 가중평균. 정밀 측위(삼변측량)가 아니라
 * "신호가 센 쪽으로 끌려가는" 근사치 — 존 내/존 간 이동 흐름을 눈으로 확인하는 용도.
 * 정식 화면은 존 단위가 기준 (설계서 1장: 위치 정밀도 = 존 단위).
 */
export class PositionEstimator {
  private gatewayTiles = new Map<string, { x: number; y: number }>();

  constructor(
    gateways: Gateway[],
    private engine: ZoneEngine,
    /**
     * 가중치의 가파르기 — `w = 10^((RSSI+100) / 이 값)`.
     *
     * 경로손실을 대입하면 `w ∝ 거리^(-10n/이 값)` 이 된다. 실내 감쇠지수 n≈2 기준으로
     * **20 이면 1/거리, 10 이면 1/거리²** 이다. 낮출수록 가장 센 게이트웨이 하나가
     * 무게를 독식해 점이 그 위로 바짝 붙고, 높일수록 여러 대 사이로 퍼진다.
     *
     * 왜 열어 뒀나 — 5대를 깔고 재 보니, 창고 게이트웨이 **바로 옆**에 둔 비콘 셋이
     * 하나같이 2.0~2.7m 북동쪽으로 밀렸다. 창고가 1등(-50)이어도 나머지 넷이 -64 언저리로
     * 다 듣는 탓에 그쪽 가중치 합이 44%나 되고, 그 넷의 무게중심이 북동쪽이라 그렇다.
     * 20 → 10 이면 같은 14dB 차이가 5배에서 25배로 벌어져 그 끌림이 줄어든다.
     *
     * 대가가 있다. 게이트웨이 **사이**에 있는 비콘의 보간이 뭉툭해진다 — 중간에 서 있어도
     * 가까운 쪽으로 붙는다. 어느 쪽이 나은지는 배치와 용도에 달렸으니 현장에서 고른다.
     */
    private weightDiv = 20,
    /**
     * `'trilateration'` 이면 무게중심을 **시작점**으로 삼아 거리 최소자승을 한 번 더 돌린다.
     *
     * 무게중심은 게이트웨이 다각형 바깥을 못 가리키고 가장자리에서 안쪽으로 수축한다.
     * 거리를 실제로 계산하면 그 두 가지가 사라진다. 게이트웨이가 3대 미만으로 들리면
     * 평면이 정해지지 않으므로 그 태그만 조용히 무게중심 값을 쓴다.
     */
    private mode: 'centroid' | 'trilateration' = 'centroid',
  ) {
    this.setGateways(gateways);
  }

  /** 게이트웨이 목록 교체 — 현장에서 한 대 등록할 때마다 서버를 재시작할 수 없다 */
  setGateways(gateways: Gateway[]): void {
    this.gatewayTiles = new Map();
    for (const gw of gateways) {
      if (gw.tile) this.gatewayTiles.set(gw.gatewayId, gw.tile);
    }
  }

  /** 현재 추적 중인 모든 태그의 추정 좌표 (신호 없으면 제외) */
  estimateAll(): PositionEstimate[] {
    const result: PositionEstimate[] = [];
    for (const state of this.engine.getAllStates()) {
      /**
       * 들리는 게이트웨이를 **전부** 쓴다.
       *
       * 한때 "가장 센 3대만" 으로 좁혔었다 — 멀고 약한 게이트웨이들이 수신 창을 들락거리며
       * 무게중심을 끌고 다닌다는 이유였는데, 실측하니 오히려 점프가 늘었다(브로드캐스트당
       * 106%→121%). 상위 N 을 자르면 3위와 4위가 자리를 바꿀 때마다 무게중심이 **계단처럼**
       * 튀기 때문이다. 전부 쓰면 가중치가 연속적으로 변해 그런 계단이 안 생긴다.
       */
      const readings = this.engine.readingsOf(state.tagId);

      let wSum = 0;
      let xSum = 0;
      let ySum = 0;
      const anchors: Anchor[] = [];
      for (const r of readings) {
        /**
         * 설치 좌표를 모르는 게이트웨이의 수신값은 건너뛴다.
         *
         * ⚠️ 예전엔 `!` 로 "있다" 고 단정했는데, **목록이 바뀌면 그 순간 터진다** —
         *    엔진에는 방금 뺀 게이트웨이의 수신값이 몇 초 더 남아 있기 때문이다
         *    (테스트 장비를 껐다 켜니 서버가 죽었다). 게이트웨이를 현장에서 빼는
         *    경우에도 같은 일이 난다.
         */
        const tile = this.gatewayTiles.get(r.gatewayId);
        if (!tile) continue;
        // 신호 세기 → 가중치. +100 오프셋 후 지수화 (기본 20 기준 -55dBm ≈ 178, -85dBm ≈ 5.6)
        const w = Math.pow(10, (r.rssi + 100) / this.weightDiv);
        wSum += w;
        xSum += tile.x * w;
        ySum += tile.y * w;
        anchors.push({ x: tile.x, y: tile.y, rssi: r.rssi });
      }
      if (wSum === 0) continue; // 유효 신호 없음 (자리비움)

      const centroid = { x: xSum / wSum, y: ySum / wSum };
      // 3대 미만이면 평면이 안 정해진다 — 그 태그만 무게중심으로 떨어진다
      const fixed =
        this.mode === 'trilateration' ? (trilaterate(anchors, centroid) ?? centroid) : centroid;

      result.push({
        tagId: state.tagId,
        x: fixed.x,
        y: fixed.y,
        zone: state.currentZone,
        inTransit: state.inTransit,
      });
    }
    return result;
  }
}
