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

// 실제 환자 동선에 가까운 체류 시간 (환경변수 MOCK_SPEED 배속 — 예: 4 면 4배 빨리)
const SPEED = Number(process.env.MOCK_SPEED ?? 1);
// 게이트웨이 스캔 업로드 주기 (실물 gateway4 주기는 판매자 확인 필요 — 설계서 12장)
const SCAN_INTERVAL_MS = Number(process.env.SCAN_INTERVAL_MS ?? 500);
const DWELL = {
  waiting: 90, // 대기실 90초
  boundary: 8, // 경계 구간 (히스테리시스 검증)
  consult: 60, // 상담실 60초
  surgery: 60, // 시술실 60초
  recovery: 45, // 회복실 45초
  absent: 25, // 자리비움 (무신호)
};
const CYCLE = Object.values(DWELL).reduce((a, b) => a + b, 0); // 288초 ≈ 4.8분

/** tick 위치에 따라 (게이트웨이 신호 세트) 반환 */
function signalsAt(tick: number): Array<[string, number]> {
  let t = tick;
  if ((t -= DWELL.waiting) < 0) return [['GW-A1', -58], ['GW-C1', -82]];
  if ((t -= DWELL.boundary) < 0) return [['GW-A1', -70], ['GW-C1', -66]];
  if ((t -= DWELL.consult) < 0) return [['GW-A1', -85], ['GW-C1', -55]];
  if ((t -= DWELL.surgery) < 0) return [['GW-C1', -85], ['GW-D1', -54]];
  if ((t -= DWELL.recovery) < 0) return [['GW-D1', -84], ['GW-E1', -56]];
  return []; // 자리비움 — 무신호
}

client.on('connect', () => {
  console.log(
    `[mock-gw] connected: ${MQTT_URL} — 사이클 ${Math.round(CYCLE / SPEED)}초 무한 반복 (Ctrl+C 종료)`,
  );
  let elapsed = 0; // 초 (시나리오 시간)

  setInterval(() => {
    elapsed += (SCAN_INTERVAL_MS / 1000) * SPEED;
    TAGS.forEach((mac, i) => {
      // 태그마다 시차를 줘서 따로 움직이게 (동선 겹침 방지)
      const tick = (elapsed + i * Math.floor(CYCLE / TAGS.length)) % CYCLE;
      for (const [gw, rssi] of signalsAt(tick)) publish(gw, mac, rssi);
    });
  }, SCAN_INTERVAL_MS);
});
