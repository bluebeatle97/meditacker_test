/**
 * 게이트웨이 배치 검토 — "몇 대까지 줄이면 버티나".
 *
 *   npm run gateway:plan -w @meditracker/server
 *   npm run gateway:plan -w @meditracker/server -- --step 4      # 더 촘촘히(느림)
 *   npm run gateway:plan -w @meditracker/server -- --wall 10     # 벽 감쇠 10dB 가정
 *
 * **왜 필요한가.** gateway4 는 PoE 가 아니라 5V USB 급전이라 설치 지점마다 배선이 붙는다
 * (설계서 12장). 30개소만 해도 별도 이슈인데 지금 계획은 50대다. 한 대를 줄이면 배선
 * 하나가 없어지므로, 어디를 줄일 수 있고 줄이면 무엇이 깨지는지를 숫자로 봐야 한다.
 *
 * **무엇을 재는가.** 단순 커버리지(신호가 닿나)가 아니라 **존 판정이 유지되나** 를 본다.
 * 존 판정은 "가장 센 게이트웨이가 있는 방" 으로 정해지므로(불변식 3), 어떤 방의
 * 게이트웨이를 빼면 그 방에 있는 사람은 **영구히 옆방으로 판정된다** — 신호가 아무리
 * 잘 닿아도 그렇다. 그래서 '뺐을 때 다른 존으로 넘어가는 칸 수' 를 비용으로 쓴다.
 *
 * ⚠️ 모델 예측이다 (`shared/rssi-model.ts`). 가구·인체 감쇠·안테나 지향성이 빠져 있어
 *    실제는 이보다 나쁘다. 최종 대수는 README "3. 현장 튜닝" 의 실측으로 정한다.
 */
import { loadGateways, loadZones } from '../config/index.js';
import { WalkableMap } from '../presence/walkable-map.js';
import { computeCoverage, coverageStats, type BlockedGrid, type CoverageGateway } from '@meditracker/shared';

const args = process.argv.slice(2);
const flag = (name: string, fallback: number): number => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : fallback;
};
const STEP = flag('step', 8);
const WALL_DB = flag('wall', Number.NaN);

const map = new WalkableMap();
const s = map.stats();
/** WalkableMap 을 shared 의 격자 인터페이스에 맞춘다 (내부 필드가 private 이라 stats 경유) */
const grid: BlockedGrid = {
  cell: s.cell,
  cols: s.cols,
  rows: s.rows,
  isWalkable: (px, py) => !map.isBlocked(px, py),
};

const zones = loadZones();
const zoneName = new Map(zones.map((z) => [z.zoneId, z.name]));
const all: CoverageGateway[] = loadGateways()
  .filter((g) => g.tile)
  .map((g) => ({ gatewayId: g.gatewayId, zoneId: g.zoneId, tile: g.tile! }));

const opts = { step: STEP, ...(Number.isFinite(WALL_DB) ? { wallLossDb: WALL_DB } : {}) };

function run(gws: CoverageGateway[]): ReturnType<typeof computeCoverage> {
  return computeCoverage(grid, gws, opts);
}

/** 각 칸이 어느 **존**으로 판정되는지 (가장 센 게이트웨이가 설치된 존) */
function zoneOf(cov: ReturnType<typeof computeCoverage>, gws: CoverageGateway[]): Array<string | null> {
  return cov.cells.map((c) => (c.bestIdx < 0 ? null : gws[c.bestIdx].zoneId));
}

console.log('='.repeat(78));
console.log('게이트웨이 배치 검토 (모델 예측 — 실측 아님)');
console.log('='.repeat(78));
console.log(
  `도면 격자 ${s.cols}x${s.rows} cell=${s.cell}px · 검토 해상도 ${STEP * s.cell}px` +
    ` · 벽 감쇠 ${Number.isFinite(WALL_DB) ? WALL_DB : 7}dB`,
);

// ── 1. 지금 배치의 성격 ────────────────────────────────────────────────────
const perZone = new Map<string, number>();
for (const g of all) perZone.set(g.zoneId, (perZone.get(g.zoneId) ?? 0) + 1);
const dist = new Map<number, number>();
for (const z of zones) {
  const n = perZone.get(z.zoneId) ?? 0;
  dist.set(n, (dist.get(n) ?? 0) + 1);
}
console.log(`\n[1] 지금 배치: 존 ${zones.length}개 · 게이트웨이 ${all.length}대`);
for (const [n, c] of [...dist].sort((a, b) => a[0] - b[0])) {
  console.log(`    ${n}대인 존: ${c}개`);
}
const doubles = [...perZone].filter(([, n]) => n > 1);
console.log(
  `    2대 이상인 존: ${doubles.map(([z, n]) => `${zoneName.get(z) ?? z} ${n}대`).join(', ') || '없음'}`,
);
console.log(
  `    → 대수는 전파 커버리지가 아니라 **존 개수**가 정한다. 존마다 1대가 하한이다.`,
);

// ── 2. 전파 커버리지는 여유가 있나 ──────────────────────────────────────────
const base = run(all);
const bs = coverageStats(base);
console.log(`\n[2] 전파 커버리지 (${all.length}대, 검토 칸 ${bs.cells}개)`);
console.log(`    사각지대 ${bs.dead}칸 · 1대만 듣는 칸 ${bs.single} · 3대 미만 ${bs.under3}`);
console.log(
  `    가장 센 신호 dBm — 최악 ${bs.worst.toFixed(0)} / 하위10% ${bs.p10.toFixed(0)} / 중앙 ${bs.median.toFixed(0)}`,
);

// ── 3. 한 대씩 빼 보기: 존 판정이 바뀌는 칸 수 ──────────────────────────────
const baseZone = zoneOf(base, all);
type Impact = { g: CoverageGateway; owns: number; flips: number };
const impacts: Impact[] = all.map((g, idx) => {
  let owns = 0;
  let flips = 0;
  base.cells.forEach((c, i) => {
    if (c.bestIdx !== idx) return;
    owns++;
    // 그 게이트웨이가 없으면 2등이 먹는다. 2등이 다른 존이면 판정이 넘어간다.
    const next = c.secondIdx >= 0 ? all[c.secondIdx].zoneId : null;
    if (next !== baseZone[i]) flips++;
  });
  return { g, owns, flips };
});
impacts.sort((a, b) => a.flips - b.flips || a.owns - b.owns);

console.log(`\n[3] 한 대만 뺐을 때 — 존 판정이 다른 방으로 넘어가는 칸 수 (적은 순)`);
for (const im of impacts.slice(0, 8)) {
  const twin = (perZone.get(im.g.zoneId) ?? 0) > 1 ? ' [같은 존에 다른 대 있음]' : '';
  console.log(
    `    ${im.g.gatewayId.padEnd(6)} ${(zoneName.get(im.g.zoneId) ?? im.g.zoneId).padEnd(14)}` +
      ` 담당 ${String(im.owns).padStart(3)}칸 → 넘어감 ${String(im.flips).padStart(3)}칸${twin}`,
  );
}
const safe = impacts.filter((i) => i.flips === 0);
console.log(`    넘어가는 칸이 0인 게이트웨이: ${safe.length}대` +
  (safe.length ? ` (${safe.map((i) => i.g.gatewayId).join(', ')})` : ''));

// ── 4. 욕심껏 줄여 보기 ────────────────────────────────────────────────────
console.log(`\n[4] 줄여 보기 — 매번 '넘어가는 칸' 이 가장 적은 한 대를 빼고 다시 계산`);
console.log(`    대수  사각지대  1대만  3대미만  최악dBm  존판정이 처음과 다른 칸`);
let kept = [...all];
const report = (gws: CoverageGateway[], cov: ReturnType<typeof computeCoverage>): void => {
  const st = coverageStats(cov);
  const zn = zoneOf(cov, gws);
  const changed = zn.reduce((n, z, i) => n + (z !== baseZone[i] ? 1 : 0), 0);
  const pct = ((changed / baseZone.length) * 100).toFixed(1);
  console.log(
    `    ${String(gws.length).padStart(3)}   ${String(st.dead).padStart(7)}` +
      `  ${String(st.single).padStart(5)}  ${String(st.under3).padStart(6)}` +
      `  ${st.worst.toFixed(0).padStart(7)}  ${String(changed).padStart(5)}칸 (${pct}%)`,
  );
};
report(kept, base);

while (kept.length > 1) {
  const cov = run(kept);
  const zn = zoneOf(cov, kept);
  // 이번 라운드에서 뺄 후보: 빼도 판정이 가장 덜 바뀌는 한 대
  let bestPick = -1;
  let bestFlips = Number.POSITIVE_INFINITY;
  for (let idx = 0; idx < kept.length; idx++) {
    let flips = 0;
    cov.cells.forEach((c, i) => {
      if (c.bestIdx !== idx) return;
      const next = c.secondIdx >= 0 ? kept[c.secondIdx].zoneId : null;
      if (next !== zn[i]) flips++;
    });
    if (flips < bestFlips) {
      bestFlips = flips;
      bestPick = idx;
    }
  }
  const dropped = kept[bestPick];
  kept = kept.filter((_, i) => i !== bestPick);
  const after = run(kept);
  // 눈으로 볼 지점만 찍는다 (매 대수 다 찍으면 표가 50줄이 된다)
  if (kept.length % 5 === 0 || kept.length <= 3 || kept.length >= all.length - 5) {
    report(kept, after);
  }
  if (kept.length <= Math.max(2, Math.round(all.length * 0.3))) break;
  void dropped;
}

console.log(`\n[5] 읽는 법`);
console.log(`    · '존판정이 처음과 다른 칸' 이 곧 오판이다. 신호가 닿아도 방이 틀리면 쓸 수 없다.`);
console.log(`    · 사각지대 0 이 유지되더라도 이 값이 커지면 그 배치는 못 쓴다.`);
console.log(`    · 모델 예측이다 — 벽 감쇠를 --wall 10 처럼 올려 보수적으로도 확인할 것.`);
