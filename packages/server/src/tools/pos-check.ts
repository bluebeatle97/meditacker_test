/**
 * 좌표 정확도 실측 — "여기 서 있는데 화면은 어디라고 하나".
 *
 *   npm run pos:check -w @meditracker/server -- --tag 배 --spot center
 *   npm run pos:check -w @meditracker/server -- --tag 배 --spot gw:창고 --sec 60
 *   npm run pos:check -w @meditracker/server -- --tag 배 --at 1204,600
 *   npm run pos:check -w @meditracker/server -- --spots        # 쓸 수 있는 지점 목록
 *
 * **왜 필요한가.** 배치를 바꿀 때마다 "좀 나아진 것 같다" 로는 못 정한다. 같은 절차로
 * 같은 값을 뽑아야 배치 A 와 B 를 비교할 수 있다. 특히 게이트웨이를 방마다 사각형으로
 * 놓고 간격을 좁혀 갈 때, 간격이 실제로 얼마나 이득인지는 숫자로만 보인다.
 *
 * **정답 좌표를 손으로 안 넣어도 되는 이유.** 도면 픽셀을 현장에서 읽을 방법이 없다.
 * 대신 이미 아는 지점을 쓴다 — 게이트웨이 설치 좌표(`--spot gw:이름`), 그 게이트웨이들의
 * 중심(`--spot center`), 두 게이트웨이의 중간(`--spot mid:창고,상담실 1`). 비콘을 그
 * 자리에 놓기만 하면 정답이 정해진다.
 *
 * 좌표는 서버가 화면에 보내는 그 값을 그대로 받는다(평활·존 리시 포함). 즉 **화면에서
 * 보는 것과 같은 값**을 재는 것이지, 이론값을 다시 계산하는 게 아니다.
 */
import { io } from 'socket.io-client';
import mqtt from 'mqtt';
import { decode } from '@msgpack/msgpack';
import { CM_PER_PX } from '@meditracker/shared';
import { SERVER_CONFIG, ZONE_ENGINE_CONFIG, loadGateways } from '../config/index.js';

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const SEC = Number(opt('sec') ?? 30);
const BASE = `http://localhost:${SERVER_CONFIG.httpPort}`;
const m = (px: number) => (px * CM_PER_PX) / 100;

const gateways = loadGateways().filter((g) => g.tile);
const short = (label: string) => label.replace(/ 게이트웨이| \(.*\)/, '');

if (args.includes('--spots')) {
  console.log('--spot 에 쓸 수 있는 값:\n');
  console.log('  center                       게이트웨이 전체의 중심');
  for (const g of gateways) console.log(`  gw:${short(g.label)}`.padEnd(30) + `(${g.tile!.x}, ${g.tile!.y})`);
  console.log('  mid:<이름>,<이름>             두 게이트웨이의 중간');
  console.log('  --at <x>,<y>                 도면 좌표로 직접');
  process.exit(0);
}

/** 정답 좌표를 정한다. 못 정하면 오차 없이 흔들림만 낸다. */
function truthOf(): { x: number; y: number; how: string } | null {
  const at = opt('at');
  if (at) {
    const [x, y] = at.split(',').map(Number);
    if (Number.isFinite(x) && Number.isFinite(y)) return { x, y, how: '직접 입력' };
  }
  const spot = opt('spot');
  if (!spot) return null;
  if (spot === 'center') {
    const x = gateways.reduce((a, g) => a + g.tile!.x, 0) / gateways.length;
    const y = gateways.reduce((a, g) => a + g.tile!.y, 0) / gateways.length;
    return { x, y, how: `게이트웨이 ${gateways.length}대의 중심` };
  }
  const find = (name: string) => gateways.find((g) => short(g.label).includes(name.trim()));
  if (spot.startsWith('gw:')) {
    const g = find(spot.slice(3));
    return g ? { x: g.tile!.x, y: g.tile!.y, how: `${short(g.label)} 설치 지점` } : null;
  }
  if (spot.startsWith('mid:')) {
    const [a, b] = spot.slice(4).split(',');
    const ga = find(a);
    const gb = find(b);
    if (!ga || !gb) return null;
    return {
      x: (ga.tile!.x + gb.tile!.x) / 2,
      y: (ga.tile!.y + gb.tile!.y) / 2,
      how: `${short(ga.label)} ↔ ${short(gb.label)} 중간`,
    };
  }
  return null;
}

const truth = truthOf();
const wantTag = opt('tag');

// ── 좌표: 서버가 화면에 보내는 값을 그대로 받는다 ──────────────────────────
const samples = new Map<string, Array<{ x: number; y: number }>>();
const zoneOf = new Map<string, string | null>();
let names: Record<string, { name?: string }> = {};

const res = await fetch(`${BASE}/tag-meta`).then((r) => r.json() as Promise<typeof names>).catch(() => ({}));
names = res;
const nameOf = (tagId: string) => names[tagId]?.name ?? tagId.slice(-5);

const { token } = (await fetch(`${BASE}/dev-token?type=staff`).then((r) => r.json())) as { token: string };
const sock = io(`${BASE}/staff`, { auth: { token }, transports: ['websocket'] });
sock.onAny((_e, payload) => {
  for (const x of Array.isArray(payload) ? payload : [payload]) {
    if (!x?.tagId) continue;
    if (x.currentZone !== undefined) zoneOf.set(x.tagId, x.currentZone);
    if (x.zone !== undefined) zoneOf.set(x.tagId, x.zone);
    if (typeof x.x === 'number') {
      if (!samples.has(x.tagId)) samples.set(x.tagId, []);
      samples.get(x.tagId)!.push({ x: x.x, y: x.y });
    }
  }
});

// ── 게이트웨이별 수신 세기 (판정 여유를 같이 보려고) ────────────────────────
const hex = (b: Uint8Array) =>
  Array.from(b).map((v) => v.toString(16).padStart(2, '0')).join(':').toUpperCase();
const gwOf = new Map(gateways.map((g) => [g.gatewayId.replace(/:/g, ''), short(g.label)]));
const rssi = new Map<string, Map<string, { n: number; sum: number }>>();
const client = mqtt.connect(SERVER_CONFIG.mqttUrl);
client.on('connect', () => client.subscribe('#'));
client.on('message', (_t, p) => {
  let r: any;
  try {
    r = decode(p);
  } catch {
    return;
  }
  if (!r?.mac || !Array.isArray(r.devices) || !gwOf.has(r.mac)) return;
  for (const d of r.devices) {
    if (!(d instanceof Uint8Array) || d.length < 8) continue;
    const tag = hex(d.subarray(1, 7));
    if (!rssi.has(tag)) rssi.set(tag, new Map());
    const per = rssi.get(tag)!;
    const s = per.get(r.mac) ?? { n: 0, sum: 0 };
    s.n++;
    s.sum += d[7] - 256;
    per.set(r.mac, s);
  }
});

console.log(`${SEC}초 측정 중…  ${truth ? `정답: (${Math.round(truth.x)}, ${Math.round(truth.y)}) — ${truth.how}` : '정답 지점 없음 (흔들림만)'}`);
if (truth && !wantTag) {
  console.log('⚠️ --tag 를 안 줬다. 오차는 **그 자리에 실제로 둔 비콘**에만 의미가 있다.');
}

setTimeout(() => {
  const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  let printed = 0;

  for (const [tagId, pts] of samples) {
    const nm = nameOf(tagId);
    if (wantTag && !nm.includes(wantTag) && !tagId.includes(wantTag)) continue;
    printed++;
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const cx = avg(xs);
    const cy = avg(ys);
    const spreadX = Math.max(...xs) - Math.min(...xs);
    const spreadY = Math.max(...ys) - Math.min(...ys);
    // 평균에서 얼마나 떨어져 흩어지는가 (한 번의 관측이 평균에서 벗어나는 정도)
    const rms = Math.sqrt(avg(pts.map((p) => (p.x - cx) ** 2 + (p.y - cy) ** 2)));

    console.log(`\n■ ${nm}  (${pts.length}회 · 존 ${zoneOf.get(tagId) ?? '자리비움'})`);
    console.log(`   추정 평균  (${Math.round(cx)}, ${Math.round(cy)})`);
    if (truth) {
      console.log(`   오차       ${m(Math.hypot(cx - truth.x, cy - truth.y)).toFixed(2)}m`);
    }
    console.log(`   흔들림     ±${m(rms).toFixed(2)}m  (x ${m(spreadX).toFixed(1)}m × y ${m(spreadY).toFixed(1)}m)`);

    const per = rssi.get(tagId);
    if (per && per.size > 0) {
      const rows = [...per]
        .map(([g, s]) => ({ g, name: gwOf.get(g)!, a: s.sum / s.n, n: s.n }))
        .sort((a, b) => b.a - a.a);
      console.log(
        `   수신       ${rows.map((r) => `${r.name} ${Math.round(r.a)}(${r.n})`).join('  ')}`,
      );
      if (rows.length > 1) {
        const margin = rows[0].a - rows[1].a;
        console.log(
          `   1·2위 차이 ${margin.toFixed(1)}dB  (히스테리시스 ${ZONE_ENGINE_CONFIG.HYSTERESIS_DB}dB ${margin < ZONE_ENGINE_CONFIG.HYSTERESIS_DB ? '미만 — 이 자리는 존이 흔들린다' : '이상 — 안정'})`,
        );
        /**
         * 공식 예상치 — 잡음 δdB 가 1·2위 게이트웨이 사이에서 점을 얼마나 미는가.
         *
         * **중간 지점에서만 뜻이 있다.** 게이트웨이 바로 옆은 1등이 압도해서 잡음이 점을
         * 거의 못 민다(실측 0.16m). 그 자리에 이 값을 대면 "예상보다 훨씬 좋다" 는 착시가
         * 생기므로, 정답이 중간 계열일 때만 낸다.
         */
        const atMid = truth?.how.includes('중간') || truth?.how.includes('중심');
        if (atMid) {
          const g1 = gateways.find((g) => g.gatewayId.replace(/:/g, '') === rows[0].g)!;
          const g2 = gateways.find((g) => g.gatewayId.replace(/:/g, '') === rows[1].g)!;
          const L = Math.hypot(g1.tile!.x - g2.tile!.x, g1.tile!.y - g2.tile!.y);
          const NOISE_DB = 6; // 현장 실측(정지 상태)
          const r = Math.pow(10, NOISE_DB / ZONE_ENGINE_CONFIG.POS_WEIGHT_DIV);
          console.log(
            `   예상 오차  간격 ${m(L).toFixed(1)}m × ${(r / (1 + r) - 0.5).toFixed(2)} = ${m(L * (r / (1 + r) - 0.5)).toFixed(2)}m  (잡음 ${NOISE_DB}dB 가정)`,
          );
        }
      }
    }
  }
  if (printed === 0) console.log('\n해당하는 비콘의 좌표가 안 왔다 — 이름(--tag)과 신호를 확인할 것');
  process.exit(0);
}, SEC * 1000);
