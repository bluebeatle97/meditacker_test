/**
 * 개발용 MQTT 브로커 (Docker/Mosquitto 없이 로컬 실행)
 *
 *   npm run dev:broker -w @meditracker/server
 *
 * 운영(온프레미스)에서는 docker-compose 의 Mosquitto 사용.
 */
import { Aedes } from 'aedes';
import { createServer } from 'node:net';

const PORT = Number(process.env.MQTT_PORT ?? 1883);

const aedes = await Aedes.createBroker();
const server = createServer(aedes.handle);

server.listen(PORT, () => {
  console.log(`[dev-broker] MQTT listening on :${PORT}`);
});

/**
 * 접속/끊김을 **둘 다** 남긴다.
 *
 * 예전에는 접속만 찍었다. 게이트웨이가 반복해서 죽는 걸 쫓을 때 정작 필요한 건
 * "언제 끊겼나" 인데 그게 아무 데도 안 남아서, 매번 사람이 붙어 실시간으로 지켜봐야
 * 원인을 좁힐 수 있었다. 시각을 같이 찍어야 여러 대가 **동시에** 끊겼는지 알 수 있다
 * (동시에 끊기면 장비 고장이 아니라 공용 AP·전원 쪽이다).
 */
const stamp = (): string => new Date().toISOString().slice(11, 19);

aedes.on('client', (c) => console.log(`[dev-broker] ${stamp()} 접속: ${c.id}`));
aedes.on('clientDisconnect', (c) => console.warn(`[dev-broker] ${stamp()} 끊김: ${c.id}`));
aedes.on('clientError', (c, err) => console.warn(`[dev-broker] ${stamp()} 오류: ${c.id} — ${err.message}`));
aedes.on('connectionError', (_c, err) => console.warn(`[dev-broker] ${stamp()} 연결오류: ${err.message}`));
