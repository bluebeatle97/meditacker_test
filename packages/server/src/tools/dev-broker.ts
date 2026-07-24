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

aedes.on('client', (client) => console.log(`[dev-broker] client connected: ${client.id}`));
