import mqtt, { type MqttClient } from 'mqtt';
import type { ScanEvent } from '@meditracker/shared';
import type { GatewayAdapter, GatewayHealthSample } from './adapter.js';

/**
 * MQTT 구독 → 어댑터 파싱 → ScanEvent 스트림 (설계서 6.1)
 * HTTP 방식으로 확정되면 이 클래스 대신 Express 엔드포인트로 교체.
 */
export class MqttIngestion {
  private client: MqttClient | null = null;

  constructor(
    private url: string,
    /** 구독할 토픽들. 목 게이트웨이와 실장비가 서로 다른 토픽을 쓰므로 배열이다 */
    private scanTopics: string[],
    private adapter: GatewayAdapter,
    private onScan: (event: ScanEvent) => void,
    /**
     * 게이트웨이 자신의 상태 (선택). 스캔과 따로 받는 이유는 **비콘을 하나도 못 들어도
     * 오기 때문**이다 — 조용한 것과 죽은 것을 가르는 유일한 근거다.
     */
    private onHealth?: (sample: GatewayHealthSample) => void,
  ) {}

  start(): void {
    this.client = mqtt.connect(this.url);

    this.client.on('connect', () => {
      console.log(`[ingestion] MQTT connected: ${this.url}`);
      this.client!.subscribe(this.scanTopics, (err) => {
        if (err) console.error('[ingestion] subscribe failed:', err.message);
        else console.log(`[ingestion] subscribed: ${this.scanTopics.join(', ')}`);
      });
    });

    this.client.on('message', (topic, payload) => {
      for (const event of this.adapter.parse(topic, payload)) {
        this.onScan(event);
      }
      if (this.onHealth && this.adapter.parseHealth) {
        const health = this.adapter.parseHealth(topic, payload);
        if (health) this.onHealth(health);
      }
    });

    this.client.on('error', (err) => {
      console.error('[ingestion] MQTT error:', err.message);
    });

    // 브로커와의 연결이 끊기는 순간도 남긴다 — 게이트웨이가 아니라 우리 쪽이 끊긴
    // 경우와 구분해야 "왜 다 같이 사라졌나" 를 되짚을 수 있다
    this.client.on('reconnect', () => console.warn('[ingestion] MQTT 재연결 시도'));
    this.client.on('close', () => console.warn('[ingestion] MQTT 연결 끊김'));
    this.client.on('offline', () => console.warn('[ingestion] MQTT 오프라인'));
  }

  stop(): void {
    this.client?.end();
    this.client = null;
  }
}
