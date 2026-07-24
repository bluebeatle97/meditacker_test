import type { ScanEvent } from '@meditracker/shared';

/**
 * 게이트웨이 수신 어댑터 (설계서 6.1)
 *
 * 게이트웨이 벤더 종속 코드는 이 인터페이스 구현체 안에만 존재한다 (불변식 B-4).
 * gateway4 실제 페이로드 포맷 확정 시 새 어댑터만 추가하면 됨.
 */
export interface GatewayAdapter {
  /** MQTT 토픽 또는 HTTP 수신 raw payload → 표준 ScanEvent 배열 */
  parse(topic: string, rawPayload: Buffer | string): ScanEvent[];
}
