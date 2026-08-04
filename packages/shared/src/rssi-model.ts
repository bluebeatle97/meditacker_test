import { CM_PER_PX } from './mock-walk.js';

/**
 * 경로손실 모델 — 거리와 벽 개수로 예상 수신세기(dBm)를 낸다.
 *
 * 목 게이트웨이가 가짜 신호를 만들 때 쓰고, 직원용 화면의 게이트웨이 범위 보기가
 * 같은 식으로 커버리지를 그린다. **두 곳이 같은 물리를 써야** 화면에서 본 범위와
 * 시뮬레이션으로 검증한 동작이 어긋나지 않는다.
 *
 * ⚠️ 이건 **모델이지 실측이 아니다.** 가구·인체 감쇠·안테나 지향성·반사가 빠져 있어
 *    실제 현장은 이보다 나쁘다. 배치 계획의 출발점으로만 쓰고, 최종 판단은
 *    README "3. 현장 튜닝" 의 실측으로 한다.
 */

/** 1m 거리에서의 수신세기 */
export const TX_AT_1M = -45;
/** 실내 감쇠 지수 (자유공간 2.0, 실내 2.0~3.0) */
export const PATH_LOSS_N = 2.2;
/** 이보다 약하면 게이트웨이가 못 듣는다 */
export const RX_FLOOR = -92;
/**
 * 벽 1개 관통당 감쇠(dB). 실내 경량 칸막이·석고보드 기준 6~8.
 * 이 항이 없으면 옆방 게이트웨이가 실제보다 훨씬 세게 잡혀 위치 추정이 벽 사이에 생긴다.
 */
export const WALL_LOSS_DB = 7;

/**
 * 예상 수신세기. 못 듣는 세기면 `null`.
 *
 * @param distPx 도면 픽셀 거리
 * @param walls  경로가 지나는 벽 개수
 * @param extraLossDb 추가 감쇠 (주머니 속 단말의 인체 감쇠 등)
 * @param wallLossDb 벽당 감쇠 — 현장 튜닝으로 바꿔 볼 수 있게 열어 둔다
 */
export function rssiAt(
  distPx: number,
  walls: number,
  extraLossDb = 0,
  wallLossDb = WALL_LOSS_DB,
): number | null {
  // 0.3m 하한: 게이트웨이에 태그가 닿아 있어도 근거리 모델이 발산하지 않게
  const meters = Math.max((distPx * CM_PER_PX) / 100, 0.3);
  const rssi =
    TX_AT_1M - 10 * PATH_LOSS_N * Math.log10(meters) - wallLossDb * walls - extraLossDb;
  return rssi < RX_FLOOR ? null : rssi;
}

/**
 * 이 세기보다 위여야 위치 추정에 의미 있게 기여한다고 본다.
 * RX_FLOOR 근처 신호는 노이즈에 묻혀 가중평균을 흔들기만 한다.
 */
export const USABLE_RSSI = -85;
