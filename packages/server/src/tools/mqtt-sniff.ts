/**
 * MQTT 스니퍼 — 실장비(gateway4) 페이로드 포맷 확인용 (Phase 1 첫 단계)
 *
 *   npm run sniff -w @meditracker/server
 *
 * 브로커의 모든 토픽(#)을 구독해 raw 토픽/페이로드를 그대로 출력한다.
 * 게이트웨이를 브로커에 연결시킨 뒤 이 출력 몇 줄을 보면
 * GatewayAdapter 실구현(ingestion/adapters/)을 바로 작성할 수 있다.
 */
import mqtt from 'mqtt';

const MQTT_URL = process.env.MQTT_URL ?? 'mqtt://localhost:1883';
const client = mqtt.connect(MQTT_URL);

client.on('connect', () => {
  console.log(`[sniff] connected: ${MQTT_URL} — 전체 토픽(#) 구독 중 (Ctrl+C 종료)\n`);
  client.subscribe('#');
});

client.on('message', (topic, payload) => {
  const text = payload.toString();
  const printable = /^[\x20-\x7E\s]*$/.test(text) ? text : `<hex> ${payload.toString('hex')}`;
  console.log(`─── ${new Date().toISOString()} ───`);
  console.log(`topic  : ${topic}`);
  console.log(`payload: ${printable.slice(0, 500)}\n`);
});
