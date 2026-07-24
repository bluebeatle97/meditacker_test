/**
 * 목 게이트웨이 (Phase 0 — 하드웨어 도착 전 E2E 검증용)
 *
 * 가상 태그 2개가 대기실 → 상담실1 로 이동하는 시나리오를
 * MQTT 로 publish 한다. 서버를 켠 상태에서 실행:
 *
 *   npm run mock:gw -w @meditracker/server
 */
import mqtt from 'mqtt';

const MQTT_URL = process.env.MQTT_URL ?? 'mqtt://localhost:1883';
const client = mqtt.connect(MQTT_URL);

const TAGS = ['AA:BB:CC:00:00:01', 'AA:BB:CC:00:00:02'];

function publish(gatewayId: string, mac: string, rssi: number): void {
  const payload = JSON.stringify([{ mac, rssi: rssi + jitter(), ts: Date.now() }]);
  client.publish(`gw/${gatewayId}/scan`, payload);
}

function jitter(): number {
  return Math.round((Math.random() - 0.5) * 4); // ±2dB 노이즈
}

const CYCLE = 65; // 초 — 시나리오 1바퀴 후 반복

client.on('connect', () => {
  console.log(`[mock-gw] connected: ${MQTT_URL} — 시나리오 무한 반복 (Ctrl+C 종료)`);
  let elapsed = 0;

  setInterval(() => {
    elapsed++;
    const tick = elapsed % CYCLE;
    for (const mac of TAGS) {
      if (tick < 15) {
        // 0~15초: 대기실 체류 (상담실 신호도 약하게 샘)
        publish('GW-A1', mac, -58);
        publish('GW-C1', mac, -82);
      } else if (tick < 20) {
        // 15~20초: 경계 구간 — 히스테리시스가 채터링을 막아야 함
        publish('GW-A1', mac, -70);
        publish('GW-C1', mac, -66);
      } else if (tick < 30) {
        // 20~30초: 상담실1 진입 (명확히 셈 → CONFIRM_COUNT 후 전환)
        publish('GW-A1', mac, -85);
        publish('GW-C1', mac, -55);
      } else if (tick < 40) {
        // 30~40초: 시술실1 이동
        publish('GW-C1', mac, -85);
        publish('GW-D1', mac, -54);
      } else if (tick < 48) {
        // 40~48초: 회복실1 이동
        publish('GW-D1', mac, -84);
        publish('GW-E1', mac, -56);
      }
      // 48~65초: 무신호 → ABSENT_TIMEOUT 후 자리비움 → 다시 대기실부터
    }
    if (tick === 0) console.log('[mock-gw] 사이클 재시작 — 대기실부터');
  }, 1000);
});
