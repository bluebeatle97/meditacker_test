import type { Gateway, PositionEstimate } from '@meditracker/shared';
import type { ZoneEngine } from '../zone-engine/zone-engine.js';

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
  ) {
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
      for (const r of readings) {
        const tile = this.gatewayTiles.get(r.gatewayId)!;
        // 신호 세기 → 선형 가중치. +100 오프셋 후 지수화 (-55dBm ≈ 178, -85dBm ≈ 5.6)
        const w = Math.pow(10, (r.rssi + 100) / 20);
        wSum += w;
        xSum += tile.x * w;
        ySum += tile.y * w;
      }
      if (wSum === 0) continue; // 유효 신호 없음 (자리비움)
      result.push({
        tagId: state.tagId,
        x: xSum / wSum,
        y: ySum / wSum,
        zone: state.currentZone,
        inTransit: state.inTransit,
      });
    }
    return result;
  }
}
