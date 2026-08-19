import type { ScanEvent } from '@meditracker/shared';

/**
 * 게이트웨이가 스캔과 **함께** 보내는 자기 상태.
 *
 * 스캔(비콘을 들었다)과 성격이 다르다 — 비콘이 하나도 없어도 이 값은 온다. 그래서
 * "조용한 것"과 "죽은 것"을 가르는 유일한 근거가 된다. 실장비(AB V4)만 싣고 오므로
 * 어댑터 인터페이스에서는 선택 사항이다.
 */
export interface GatewayHealthSample {
  gatewayId: string;
  /**
   * 부팅 후 경과 **초**. 값이 되감기면 그 사이에 재부팅한 것이다
   * (절대 시각이 아니라서 태그 간 비교에는 못 쓴다 — ab-gateway-v4.adapter 주석 참고).
   */
  uptimeSec: number | null;
  /** 메시지 일련번호. 건너뛰면 그만큼 전송 중에 유실됐다 */
  mid: number | null;
  /** 이 메시지에 담긴 비콘 수 (0이면 들은 게 없다는 뜻 — 죽은 것과 다르다) */
  devices: number;
  /** 수신 시각 */
  at: number;
}

/**
 * 게이트웨이 수신 어댑터 (설계서 6.1)
 *
 * 게이트웨이 벤더 종속 코드는 이 인터페이스 구현체 안에만 존재한다 (불변식 B-4).
 * gateway4 실제 페이로드 포맷 확정 시 새 어댑터만 추가하면 됨.
 */
export interface GatewayAdapter {
  /** MQTT 토픽 또는 HTTP 수신 raw payload → 표준 ScanEvent 배열 */
  parse(topic: string, rawPayload: Buffer | string): ScanEvent[];
  /**
   * 같은 페이로드에서 **게이트웨이 자신의 상태**를 꺼낸다 (선택 구현).
   *
   * `parse` 와 나눠 둔 이유: 스캔은 비콘이 있어야 나오지만 이 값은 항상 나온다.
   * 한 함수가 둘 다 반환하게 만들면 모든 어댑터와 호출부가 같이 바뀌는데,
   * 실장비 외에는 실어 보낼 값 자체가 없다.
   */
  parseHealth?(topic: string, rawPayload: Buffer | string): GatewayHealthSample | null;
}
