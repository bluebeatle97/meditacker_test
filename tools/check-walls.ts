/**
 * 벽 판정 검사 — "캐릭터 발이 벽에 들어가지 않는가".
 *
 *   npx tsx tools/check-walls.ts
 *
 * **왜 있는가.** 벽은 사람이 손으로 그리고(`config/wall.png`), 통행 격자는 거기서
 * 파생되고, 화면 캐릭터는 그 격자 위에서 경로를 만든다 — 사슬이 세 칸이라 어디
 * 한 곳만 어긋나도 발이 벽에 박힌다. 눈으로는 그 순간을 잡기 어렵다(실제로 여러 번
 * 놓쳤다). 도면을 바꿀 때마다 이걸 돌린다 (README 「도면이 바뀌면」 마지막 단계).
 *
 * **서버가 필요 없다.** 예전엔 서버에 붙어 실제 좌표를 받아 봤는데, 그러려면 팔찌를
 * 하나 점유해야 하고(진입 토큰) 사람이 지나간 곳만 검사된다. 대신 격자에서 뽑은
 * 지점들로 **화면과 똑같은 절차**를 재현한다 — 결정적이고, 훨씬 넓게 훑는다.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { Pathfinder, type WalkableGrid } from '../packages/web-patient/src/pathfinder';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = join(ROOT, 'packages/server/src/config');

/** 경로를 몇 개 뽑아 볼지 — 300개면 층 전체를 여러 번 가로지른다 */
const ROUTES = 300;
/**
 * 벽 안에 연속으로 머문 길이가 이보다 길면 실패.
 *
 * 1px 짜리는 벽 블록의 **모서리 픽셀을 스친 것**이다. 경로 직선화가 2px 간격으로
 * 훑기 때문에(pathfinder 의 hasLineOfSight) 그 사이로 꼭짓점 하나가 빠져나간다.
 * 화면 축척이 0.5 라 반 픽셀이고, 이걸 없애려면 직선화를 두 배 무겁게 해야 한다.
 * **벽을 가로지른 것(수십 px)과는 완전히 다른 사건**이라 여기서 갈라 놓는다.
 */
const GRAZE_PX = 2;

// ─── PNG (8비트 흑백, 비인터레이스) ─────────────────────────────────────────
// 마스크를 읽자고 이미지 라이브러리를 의존성에 넣을 일은 아니다. zlib 은 Node 에 있다.

function decodeGray8(file: string): { w: number; h: number; px: Uint8Array } {
  const buf = readFileSync(file);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error(`${file}: PNG 가 아님`);
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  const depth = buf[24];
  const color = buf[25];
  const interlace = buf[28];
  if (depth !== 8 || color !== 0 || interlace !== 0) {
    throw new Error(`${file}: 8비트 흑백·비인터레이스만 읽는다 (depth=${depth} color=${color})`);
  }
  const idat: Buffer[] = [];
  for (let o = 8; o + 8 <= buf.length; ) {
    const len = buf.readUInt32BE(o);
    if (buf.toString('ascii', o + 4, o + 8) === 'IDAT') idat.push(buf.subarray(o + 8, o + 8 + len));
    o += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const px = new Uint8Array(w * h);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const ft = raw[p++];
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const v = raw[p++];
      const a = x > 0 ? px[row + x - 1] : 0; // 왼쪽
      const b = y > 0 ? px[row - w + x] : 0; // 위
      const c = x > 0 && y > 0 ? px[row - w + x - 1] : 0; // 왼쪽 위
      let out: number;
      if (ft === 0) out = v;
      else if (ft === 1) out = v + a;
      else if (ft === 2) out = v + b;
      else if (ft === 3) out = v + ((a + b) >> 1);
      else if (ft === 4) {
        const q = a + b - c;
        const pa = Math.abs(q - a);
        const pb = Math.abs(q - b);
        const pc = Math.abs(q - c);
        out = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      } else throw new Error(`${file}: 알 수 없는 행 필터 ${ft}`);
      px[row + x] = out & 0xff;
    }
  }
  return { w, h, px };
}

/** 벽까지의 거리 (2패스 chamfer, cap 에서 자름) — 얼마나 아슬아슬한지 보려고 */
function wallDistance(wall: Uint8Array, w: number, h: number, cap = 40): Uint8Array {
  const d = new Float64Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = wall[i] ? 0 : Infinity;
  const S = Math.SQRT2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let v = d[i];
      if (y > 0) {
        v = Math.min(v, d[i - w] + 1);
        if (x > 0) v = Math.min(v, d[i - w - 1] + S);
        if (x + 1 < w) v = Math.min(v, d[i - w + 1] + S);
      }
      if (x > 0) v = Math.min(v, d[i - 1] + 1);
      d[i] = v;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      let v = d[i];
      if (y + 1 < h) {
        v = Math.min(v, d[i + w] + 1);
        if (x > 0) v = Math.min(v, d[i + w - 1] + S);
        if (x + 1 < w) v = Math.min(v, d[i + w + 1] + S);
      }
      if (x + 1 < w) v = Math.min(v, d[i + 1] + 1);
      d[i] = v;
    }
  }
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = Math.min(cap, Math.round(d[i]));
  return out;
}

/** 씨앗 고정 난수 — 돌릴 때마다 같은 곳을 검사해야 "고쳤나" 를 비교할 수 있다 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── 준비 ───────────────────────────────────────────────────────────────────

const { w: W, h: H, px: gray } = decodeGray8(join(CONFIG, 'wall-mask.png'));
const wall = new Uint8Array(W * H);
for (let i = 0; i < wall.length; i++) wall[i] = gray[i] > 127 ? 1 : 0;

const grid = JSON.parse(readFileSync(join(CONFIG, 'walkable.json'), 'utf8')) as WalkableGrid;
const pf = new Pathfinder(grid);

if (grid.cols * grid.cell < W - grid.cell || grid.rows * grid.cell < H - grid.cell) {
  console.error(
    `⚠️  격자(${grid.cols}x${grid.rows} x${grid.cell}px)와 벽 마스크(${W}x${H})의 크기가 안 맞는다.\n` +
      `   build-wall-mask.py 와 build-walkable.py 를 같은 도면으로 다시 돌려야 한다.`,
  );
  process.exit(1);
}

/**
 * 이 지점의 픽셀이 벽인가.
 *
 * ⚠️ `floor` 여야 한다. 픽셀 n 이 덮는 구간은 `[n, n+1)` 이고, 격자 판정도
 * `floor(x / cell)` 로 칸을 고른다. `round` 를 쓰면 반 픽셀이 밀려서, 벽에 딱 붙어
 * 걷는 정상 경로가 "벽을 밟았다" 로 잡힌다 (그 착각으로 없는 버그를 쫓은 적이 있다).
 */
const isWall = (x: number, y: number): boolean => {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  if (ix < 0 || iy < 0 || ix >= W || iy >= H) return false;
  return wall[iy * W + ix] === 1;
};

console.log(`벽 마스크 ${W}x${H} · 격자 ${grid.cols}x${grid.rows} (칸 ${grid.cell}px)`);
console.log('');

let failed = false;

// ─── 1. 격자에 벽이 섞였나 ──────────────────────────────────────────────────
// 통행 가능이라고 표시된 칸은 벽 픽셀을 **한 톨도** 품으면 안 된다.
// 여기가 더러우면 아래 검사는 볼 것도 없다 — 원인이 전부 여기다.

const walkCells: Array<{ x: number; y: number }> = [];
let dirtyCells = 0;
let dirtyPixels = 0;
for (let gy = 0; gy < grid.rows; gy++) {
  const row = grid.grid[gy];
  for (let gx = 0; gx < grid.cols; gx++) {
    if (row.charCodeAt(gx) !== 49) continue;
    walkCells.push({ x: (gx + 0.5) * grid.cell, y: (gy + 0.5) * grid.cell });
    let n = 0;
    for (let y = gy * grid.cell; y < (gy + 1) * grid.cell && y < H; y++) {
      for (let x = gx * grid.cell; x < (gx + 1) * grid.cell && x < W; x++) {
        if (wall[y * W + x]) n++;
      }
    }
    if (n > 0) {
      dirtyCells++;
      dirtyPixels += n;
    }
  }
}
if (dirtyCells === 0) {
  console.log(`✅ 격자   통행 가능 ${walkCells.length}칸에 벽 픽셀 없음`);
} else {
  console.log(`❌ 격자   통행 가능 칸에 벽이 섞였다 — ${dirtyCells}칸 (${dirtyPixels}px)`);
  console.log(`          build-walkable.py 를 다시 돌려야 한다 (벽 마스크가 바뀐 뒤 안 돌렸을 것)`);
  failed = true;
}

// ─── 2. 벽에 놓인 좌표를 빼내는가 ───────────────────────────────────────────
// 위치 추정이 벽 안을 찍는 일은 늘 있다. 화면은 nearestWalkable 로 빼내는데,
// 못 빼내면 그 자리에 그대로 선다. 벽이 통행 가능과 맞닿은 칸이 그 무대다.

const seam: Array<{ x: number; y: number }> = [];
for (let gy = 0; gy < grid.rows; gy++) {
  for (let gx = 0; gx < grid.cols; gx++) {
    if (grid.grid[gy].charCodeAt(gx) === 49) continue;
    const near =
      (gx > 0 && grid.grid[gy].charCodeAt(gx - 1) === 49) ||
      (gx + 1 < grid.cols && grid.grid[gy].charCodeAt(gx + 1) === 49) ||
      (gy > 0 && grid.grid[gy - 1].charCodeAt(gx) === 49) ||
      (gy + 1 < grid.rows && grid.grid[gy + 1].charCodeAt(gx) === 49);
    if (near) seam.push({ x: (gx + 0.5) * grid.cell, y: (gy + 0.5) * grid.cell });
  }
}
let snapStuck = 0;
for (const p of seam) {
  const s = pf.nearestWalkable(p.x, p.y);
  if (isWall(s.x, s.y)) snapStuck++;
}
if (snapStuck === 0) {
  console.log(`✅ 스냅   벽/바닥 경계 ${seam.length}칸 전부 바닥으로 빠져나옴`);
} else {
  console.log(`❌ 스냅   ${seam.length}칸 중 ${snapStuck}칸이 벽에 갇혔다 (nearestWalkable 실패)`);
  failed = true;
}

// ─── 3. 존 앵커가 통행 가능한가 ─────────────────────────────────────────────
// 앵커가 벽에 박히면 그 방은 위치 판정도 길안내 목적지도 안 된다.

interface ZoneRow {
  zoneId: string;
  name: string;
  category?: string;
  tilePosition: { x: number; y: number };
}
const zonesRaw = JSON.parse(readFileSync(join(CONFIG, 'zones.json'), 'utf8')) as
  | ZoneRow[]
  | { zones: ZoneRow[] };
const zones: ZoneRow[] = Array.isArray(zonesRaw) ? zonesRaw : zonesRaw.zones;

const buried = zones.filter((z) => !pf.isWalkable(z.tilePosition.x, z.tilePosition.y));
if (buried.length === 0) {
  console.log(`✅ 앵커   존 ${zones.length}개 전부 통행 가능한 칸에 있다`);
} else {
  console.log(`❌ 앵커   ${zones.length}개 중 ${buried.length}개가 벽 안에 있다`);
  buried.forEach((z) =>
    console.log(`          ${z.name} (${z.zoneId}) @ ${z.tilePosition.x},${z.tilePosition.y}`),
  );
  failed = true;
}

// ─── 4. 층이 하나로 이어지는가 ──────────────────────────────────────────────
// 벽을 두껍게 그리면 문간이 봉해져 방이 통째로 갇힌다. 갇히면 A* 가 실패하고,
// 화면은 목적지로 **직선**을 긋는다 — 그게 벽을 뚫는 그림의 정체다.

const comp = new Int32Array(grid.cols * grid.rows).fill(-1);
const islands: Array<{ id: number; n: number; x0: number; y0: number; x1: number; y1: number }> = [];
for (let s = 0; s < comp.length; s++) {
  if (grid.grid[(s - (s % grid.cols)) / grid.cols].charCodeAt(s % grid.cols) !== 49) continue;
  if (comp[s] !== -1) continue;
  const id = islands.length;
  let n = 0;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -1;
  let y1 = -1;
  const stack = [s];
  comp[s] = id;
  while (stack.length) {
    const i = stack.pop()!;
    n++;
    const x = i % grid.cols;
    const y = (i - x) / grid.cols;
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
    const nb = [
      x > 0 ? i - 1 : -1,
      x + 1 < grid.cols ? i + 1 : -1,
      y > 0 ? i - grid.cols : -1,
      y + 1 < grid.rows ? i + grid.cols : -1,
    ];
    for (const j of nb) {
      if (j < 0 || comp[j] !== -1) continue;
      const jx = j % grid.cols;
      if (grid.grid[(j - jx) / grid.cols].charCodeAt(jx) !== 49) continue;
      comp[j] = id;
      stack.push(j);
    }
  }
  islands.push({ id, n, x0, y0, x1, y1 });
}
islands.sort((a, b) => b.n - a.n);
const MAIN = islands[0].id;

// 끊긴 곳이 직원 전용 구역이면 손님 화면에는 영향이 없다 — 나눠서 알린다
let staffMask: WalkableGrid | null = null;
try {
  staffMask = JSON.parse(readFileSync(join(CONFIG, 'staff-area.json'), 'utf8')) as WalkableGrid;
} catch {
  staffMask = null;
}
const isStaffOnly = (p: { x0: number; y0: number; x1: number; y1: number }): boolean => {
  if (!staffMask || staffMask.cols !== grid.cols) return false;
  for (let gy = p.y0; gy <= p.y1; gy++)
    for (let gx = p.x0; gx <= p.x1; gx++)
      if (comp[gy * grid.cols + gx] !== -1 && staffMask.grid[gy].charCodeAt(gx) !== 49) return false;
  return true;
};

if (islands.length === 1) {
  console.log(`✅ 연결   통행 가능 구역이 하나로 이어진다`);
} else {
  const cut = islands.slice(1);
  const guestSide = cut.filter((p) => !isStaffOnly(p));
  console.log(
    `${guestSide.length ? '❌' : '⚠️ '} 연결   본체(${islands[0].n}칸)에서 끊긴 곳 ${cut.length}군데`,
  );
  for (const p of cut) {
    console.log(
      `          ${p.n}칸 · 도면 x ${p.x0 * grid.cell}~${(p.x1 + 1) * grid.cell}, ` +
        `y ${p.y0 * grid.cell}~${(p.y1 + 1) * grid.cell}` +
        `${isStaffOnly(p) ? ' (직원 전용 — 손님 화면과 무관)' : ' ← 손님이 갈 수 있어야 하는 곳'}`,
    );
  }
  console.log(`          문간이 봉해진 것이다. config/wall.png 에서 그 자리의 회색을 지운다`);
  if (guestSide.length) failed = true;
}

// ─── 5. 실제로 걸어 보기 ────────────────────────────────────────────────────
// 화면과 같은 절차로 경로를 만들고(walkToPoint), 발이 지나간 자리를 1px 간격으로
// 전부 찍어 본다. 스프라이트 origin 이 (0.5, 0.85) 라 좌표가 곧 발끝이다.
//
// 서로 닿지 않는 덩어리끼리는 뽑지 않는다 — 거기서 나오는 직선 관통은 4번이 이미
// 짚은 것의 결과라, 같이 세면 원인 하나가 스무 번 보고된다.

const dist = wallDistance(wall, W, H);
const clearOf = (x: number, y: number): number => {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  if (ix < 0 || iy < 0 || ix >= W || iy >= H) return 40;
  return dist[iy * W + ix];
};

/**
 * 환자용 main.ts 의 walkToPoint 와 같은 절차.
 *
 * A* 가 실패하면 화면은 목적지로 **직선**을 긋는다 — 벽을 뚫는다. 이게 왜 일어났는지가
 * 중요해서(길이 없는 것인가, 탐색을 중간에 접은 것인가) 같이 돌려준다.
 */
const routeTo = (
  from: { x: number; y: number },
  raw: { x: number; y: number },
): { route: Array<{ x: number; y: number }>; astarFailed: boolean } => {
  const dest = pf.nearestWalkable(raw.x, raw.y);
  if (pf.hasLineOfSight(from.x, from.y, dest.x, dest.y)) return { route: [dest], astarFailed: false };
  const path = pf.findPath(from.x, from.y, dest.x, dest.y);
  return { route: path ?? [dest], astarFailed: path === null };
};

const rand = rng(20260810);
const mainCells = walkCells.filter(
  (c) => comp[Math.floor(c.y / grid.cell) * grid.cols + Math.floor(c.x / grid.cell)] === MAIN,
);
const pick = (): { x: number; y: number } => mainCells[Math.floor(rand() * mainCells.length)];

let steps = 0; // 발이 지나간 자리
let inWall = 0; // 그중 벽 안
let run = 0; // 벽 안에 연속으로 머문 길이
let worstRun = 0;
let grazes = 0; // 모서리 스침 (GRAZE_PX 이하로 끝난 구간)
let minClear = 40;
const clearHist = new Array(41).fill(0);
const worst: Array<{ x: number; y: number; len: number }> = [];
let unreachable = 0;

const t0 = Date.now();
for (let r = 0; r < ROUTES; r++) {
  let cur = pick();
  const target = pick();
  const { route, astarFailed } = routeTo(cur, target);
  if (astarFailed) unreachable++;
  for (const wp of route) {
    const n = Math.max(1, Math.ceil(Math.hypot(wp.x - cur.x, wp.y - cur.y)));
    for (let i = 1; i <= n; i++) {
      const x = cur.x + ((wp.x - cur.x) * i) / n;
      const y = cur.y + ((wp.y - cur.y) * i) / n;
      steps++;
      const c = clearOf(x, y);
      clearHist[c]++;
      if (c < minClear) minClear = c;
      if (isWall(x, y)) {
        inWall++;
        run++;
      } else if (run > 0) {
        if (run > GRAZE_PX) worst.push({ x: Math.floor(x), y: Math.floor(y), len: run });
        else grazes++;
        worstRun = Math.max(worstRun, run);
        run = 0;
      }
    }
    cur = wp;
  }
  if (run > 0) {
    if (run > GRAZE_PX) worst.push({ x: Math.floor(cur.x), y: Math.floor(cur.y), len: run });
    else grazes++;
    worstRun = Math.max(worstRun, run);
    run = 0;
  }
}
const secs = ((Date.now() - t0) / 1000).toFixed(1);

if (worst.length === 0) {
  console.log(
    `✅ 통행   경로 ${ROUTES}개 · 발자국 ${steps.toLocaleString()}개 — 벽을 가로지른 곳 없음`,
  );
} else {
  console.log(`❌ 통행   벽을 가로질렀다 — ${worst.length}곳 (가장 긴 구간 ${worstRun}px)`);
  worst
    .sort((a, b) => b.len - a.len)
    .slice(0, 8)
    .forEach((h) => console.log(`          (${h.x}, ${h.y}) ${h.len}px`));
  failed = true;
}

console.log('');
const pct = (k: number): string =>
  ((clearHist.slice(0, k + 1).reduce((a, b) => a + b, 0) / (steps || 1)) * 100).toFixed(1);
console.log(`벽까지 거리   가장 가까웠던 값 ${minClear}px`);
console.log(`              4px 이내 ${pct(4)}% · 8px 이내 ${pct(8)}% · 16px 이내 ${pct(16)}%`);
if (grazes > 0) {
  console.log('');
  console.log(`ℹ️  모서리 스침 ${grazes}회 (${GRAZE_PX}px 이하) — 발자국 ${steps.toLocaleString()}개 중 ${inWall}개.`);
  console.log(`   경로 직선화가 ${grid.cell / 2}px 간격으로 훑어서 벽 꼭짓점 하나가 빠져나간 것이다.`);
  console.log(`   화면 축척이 0.5 라 반 픽셀 — 없애려면 pathfinder 의 hasLineOfSight 를 1px 로.`);
}
if (unreachable > 0) {
  // 같은 덩어리 안인데 A* 가 졌다 = 노드 상한(findPath 의 maxNodes)에 걸린 것
  console.log('');
  console.log(`❌ 같은 구역인데 A* 가 길을 못 찾은 쌍 ${unreachable}개 — findPath 의 maxNodes 부족`);
  failed = true;
}
console.log('');
console.log(`(${secs}초)`);

// 직원용은 같은 경로탐색기의 사본이다 — 갈라지면 두 화면이 다르게 걷는다
const a = readFileSync(join(ROOT, 'packages/web-patient/src/pathfinder.ts'), 'utf8');
const b = readFileSync(join(ROOT, 'packages/web-staff/src/pathfinder.ts'), 'utf8');
const strip = (s: string): string => s.replace(/^[\s\S]*?\*\/\s*/, '').trim();
if (strip(a) !== strip(b)) {
  console.log('');
  console.log('⚠️  web-patient 와 web-staff 의 pathfinder.ts 가 다르다 — 한쪽만 고쳤을 것이다.');
  console.log('   이 검사는 환자용만 본다. 직원용 경로는 검사되지 않았다.');
}

process.exit(failed ? 1 : 0);
