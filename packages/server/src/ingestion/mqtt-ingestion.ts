import mqtt, { type MqttClient } from 'mqtt';
import type { ScanEvent } from '@meditracker/shared';
import type { GatewayAdapter } from './adapter.js';

/**
 * MQTT 구독 → 어댑터 파싱 → ScanEvent 스트림 (설계서 6.1)
 * HTTP 방식으로 확정되면 이 클래스 대신 Express 엔드포인트로 교체.
 */
export class MqttIngestion {
  private client: MqttClient | null = null;

  constructor(
    private url: string,
    private scanTopic: string, // e.g. "gw/+/scan"
    private adapter: GatewayAdapter,
    private onScan: (event: ScanEvent) => void,
  ) {}

  start(): void {
    this.client = mqtt.connect(this.url);

    this.client.on('connect', () => {
      console.log(`[ingestion] MQTT connected: ${this.url}`);
      this.client!.subscribe(this.scanTopic, (err) => {
        if (err) console.error('[ingestion] subscribe failed:', err.message);
        else console.log(`[ingestion] subscribed: ${this.scanTopic}`);
      });
    });

    this.client.on('message', (topic, payload) => {
      for (const event of this.adapter.parse(topic, payload)) {
        this.onScan(event);
      }
    });

    this.client.on('error', (err) => {
      console.error('[ingestion] MQTT error:', err.message);
    });
  }

  stop(): void {
    this.client?.end();
    this.client = null;
  }
}
