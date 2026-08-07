import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Pathfinder, type WalkableGrid } from './pathfinder';

/**
 * 경로가 벽에 붙지 않는지 검사한다.
 *
 * **왜 있는가.** 균일 비용 A* 는 최단이기만 하면 어느 길이든 같은 값이라, 타이브레이크에
 * 따라 벽을 스치는 경로가 나온다. 아바타가 걸을 때는 티가 덜 나지만 **길안내 화살표를
 * 그 위에 깔면 벽에 붙어 어디로 가라는 건지 안 읽힌다**(실제로 그런 지적을 받았다).
 * 벽 근접 비용으로 가운데로 밀어 두었는데, 눈으로만 확인하면 다음에 조용히 돌아온다.
 */

const here = dirname(fileURLToPath(import.meta.url));
const CONFIG = join(here, '../../server/src/config');
const grid = JSON.parse(readFileSync(join(CONFIG, 'walkable.json'), 'utf8')) as WalkableGrid;
const zones = JSON.parse(readFileSync(join(CONFIG, 'zones.json'), 'utf8')) as Array<{
  zoneId: string;
  tilePosition: { x: number; y: number };
}>;

const pf = new Pathfinder(grid);
const at = (id: string): { x: number; y: number } => {
  const z = zones.find((v) => v.zoneId === id);
  if (!z) throw new Error(`모르는 존: ${id}`);
  return z.tilePosition;
};

const walkable = (gx: number, gy: number): boolean =>
  gx >= 0 &&
  gy >= 0 &&
  gx < grid.cols &&
  gy < grid.rows &&
  grid.grid[gy].charCodeAt(gx) === 49;

/** 이 지점에서 가장 가까운 벽까지 몇 칸인가 (12칸에서 끊는다 — 그 이상은 '넓다') */
function clearanceCells(px: number, py: number): number {
  const gx = Math.floor(px / grid.cell);
  const gy = Math.floor(py / grid.cell);
  for (let r = 1; r <= 12; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (!walkable(gx + dx, gy + dy)) return r;
      }
    }
  }
  return 12;
}

/** 이 지점에서 그 방향으로 벽까지 몇 px (56px 에서 끊는다 — 그 이상은 복도가 아니다) */
function freeDist(x: number, y: number, dx: number, dy: number): number {
  const step = grid.cell / 2;
  for (let d = step; d <= 56; d += step) {
    const gx = Math.floor((x + dx * d) / grid.cell);
    const gy = Math.floor((y + dy * d) / grid.cell);
    if (!walkable(gx, gy)) return d - step;
  }
  return 56;
}

/**
 * 이 구간이 복도 한가운데에서 얼마나 치우쳤나 (복도가 아니면 null).
 * 구간을 따라 여러 군데서 재고 가운데값을 쓴다 — 방문 앞을 한 번 스치는 것에 안 흔들리게.
 */
function centerOffset(
  a: { x: number; y: number },
  b: { x: number; y: number },
  horiz: boolean,
): number | null {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const steps = Math.min(60, Math.max(2, Math.round(len / (grid.cell * 2))));
  const off: number[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = a.x + (b.x - a.x) * t;
    const y = a.y + (b.y - a.y) * t;
    const lo = horiz ? freeDist(x, y, 0, -1) : freeDist(x, y, -1, 0);
    const hi = horiz ? freeDist(x, y, 0, 1) : freeDist(x, y, 1, 0);
    if (lo >= 56 && hi >= 56) continue; // 트인 곳엔 '가운데' 가 없다
    off.push((hi - lo) / 2);
  }
  if (off.length < 2) return null;
  off.sort((p, q) => p - q);
  return off[off.length >> 1];
}

/** 방을 가로질러 다니는 실제 안내 조합들 */
const ROUTES: Array<[string, string]> = [
  ['waiting_1', 'consult_1'],
  ['reception', 'recovery_1'],
  ['waiting_3', 'surgery_1'],
  ['consult_2', 'consult_1'],
  ['waiting_2', 'skincare'],
];

const staffArea = JSON.parse(
  readFileSync(join(CONFIG, 'staff-area.json'), 'utf8'),
) as WalkableGrid;

/** 이 지점이 직원 전용 구역 안인가 */
function inStaffArea(x: number, y: number): boolean {
  const gx = Math.floor(x / staffArea.cell);
  const gy = Math.floor(y / staffArea.cell);
  return (
    gx >= 0 &&
    gy >= 0 &&
    gx < staffArea.cols &&
    gy < staffArea.rows &&
    staffArea.grid[gy].charCodeAt(gx) === 49
  );
}

/** 꺾은선을 따라 촘촘히 훑으며 직원 구역을 밟는 비율 */
function staffShare(pts: Array<{ x: number; y: number }>): number {
  let n = 0;
  let hit = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const steps = Math.max(1, Math.round(Math.hypot(b.x - a.x, b.y - a.y) / staffArea.cell));
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      n++;
      if (inStaffArea(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)) hit++;
    }
  }
  return hit / n;
}

const staffCells = staffArea.grid.reduce((n, row) => n + (row.match(/1/g)?.length ?? 0), 0);

// 도면에 자홍색으로 칠하기 전에는 마스크가 비어 있다 — 검사할 게 없다
describe.skipIf(staffCells === 0)('안내 경로는 직원 전용 구역을 피한다', () => {
  const pfAvoid = new Pathfinder(grid);
  pfAvoid.setAvoidMask(staffArea);

  it('마스크가 통행 격자와 같은 크기다', () => {
    expect([staffArea.cols, staffArea.rows, staffArea.cell]).toEqual([
      grid.cols,
      grid.rows,
      grid.cell,
    ]);
  });

  it('직원 구역을 밟는 비율이 크게 줄어든다', () => {
    let plain = 0;
    let dodged = 0;
    let n = 0;
    for (const [from, to] of ROUTES) {
      const a = at(from);
      const b = at(to);
      const r1 = pf.findPath(a.x, a.y, b.x, b.y);
      const r2 = pfAvoid.findPath(a.x, a.y, b.x, b.y, { avoidStaff: true });
      if (!r1 || !r2) continue;
      plain += staffShare([a, ...r1]);
      dodged += staffShare([a, ...r2]);
      n++;
    }
    expect(n).toBeGreaterThan(3);
    expect(dodged / n, `우회 후에도 ${((dodged / n) * 100).toFixed(1)}% 를 밟는다`).toBeLessThan(
      0.02,
    );
  });

  it('직원 구역이 목적지면 그래도 길을 찾는다', () => {
    // 막아 버리면 그 안이 목적지일 때 안내가 통째로 실패한다 — 비싸게만 해 둔 이유
    const a = at('waiting_1');
    const b = at('staff_room');
    const r = pfAvoid.findPath(a.x, a.y, b.x, b.y, { avoidStaff: true });
    expect(r, '직원실로 가는 길이 아예 안 나온다').not.toBeNull();
  });
});

describe('경로가 벽에 붙지 않는다', () => {
  const all: number[] = [];
  for (const [from, to] of ROUTES) {
    const a = at(from);
    const b = at(to);
    const route = pf.findPath(a.x, a.y, b.x, b.y);
    it(`${from} → ${to}: 경로가 나온다`, () => {
      expect(route, '길을 못 찾았다').not.toBeNull();
      expect(route!.length).toBeGreaterThan(2);
    });
    if (route) for (const p of route) all.push(clearanceCells(p.x, p.y));
  }

  it('경로 지점의 평균 벽 거리가 3칸(12px) 이상', () => {
    const avg = all.reduce((s, v) => s + v, 0) / all.length;
    expect(avg).toBeGreaterThanOrEqual(3);
  });

  it('가로·세로 직선으로만 꺾인다 (대각선 구간 없음)', () => {
    // 바닥에 깔리는 안내 화살표는 비스듬하면 지저분하고 방향이 덜 읽힌다.
    // 좁은 통로는 통째로 못 펴서 잘라 가며 펴는데, 지금 도면에서는 전부 펴진다.
    // (물리적으로 못 펴는 자리가 생기면 그 구간만 비스듬히 남는다 — 그때 여길 푼다)
    let total = 0;
    let diagonal = 0;
    for (const [from, to] of ROUTES) {
      const a = at(from);
      const b = at(to);
      const route = pf.findPath(a.x, a.y, b.x, b.y);
      if (!route) continue;
      const pts = pf.orthogonalize([a, ...route]);
      for (let i = 1; i < pts.length; i++) {
        const dx = Math.abs(pts[i].x - pts[i - 1].x);
        const dy = Math.abs(pts[i].y - pts[i - 1].y);
        total++;
        if (dx > 1 && dy > 1) diagonal++;
      }
    }
    expect(total).toBeGreaterThan(5);
    expect(diagonal, `대각선 구간 ${diagonal}/${total}`).toBe(0);
  });

  it('복도를 지나는 구간은 복도 한가운데다', () => {
    // 벽 근접 비용은 벽에서 떼어 놓을 뿐 가운데를 보장하지 않는다. 한쪽으로 치우친 채
    // 복도를 지나가면 "이 길로" 가 아니라 "벽 쪽으로 붙어 가라" 로 보인다.
    const off: number[] = [];
    for (const [from, to] of ROUTES) {
      const a = at(from);
      const b = at(to);
      const route = pf.findPath(a.x, a.y, b.x, b.y);
      if (!route) continue;
      const pts = pf.orthogonalize([a, ...route]);
      // 처음·마지막 구간은 캐릭터 자리와 방 안 도착점이라 옮기지 않는다
      for (let i = 1; i + 2 < pts.length; i++) {
        const horiz = Math.abs(pts[i].y - pts[i + 1].y) < 1;
        if (!horiz && Math.abs(pts[i].x - pts[i + 1].x) >= 1) continue;
        const d = centerOffset(pts[i], pts[i + 1], horiz);
        if (d !== null) off.push(Math.abs(d));
      }
    }
    expect(off.length, '복도를 지나는 구간이 없다').toBeGreaterThan(3);
    const avg = off.reduce((s, v) => s + v, 0) / off.length;
    expect(avg, `평균 ${avg.toFixed(1)}px 치우침`).toBeLessThan(4); // 격자 한 칸
    expect(Math.max(...off), '한 구간이 크게 치우쳤다').toBeLessThan(12);
  });

  it('편 경로도 벽을 뚫지 않는다', () => {
    for (const [from, to] of ROUTES) {
      const a = at(from);
      const b = at(to);
      const route = pf.findPath(a.x, a.y, b.x, b.y);
      if (!route) continue;
      const pts = pf.orthogonalize([a, ...route]);
      for (let i = 1; i < pts.length; i++) {
        expect(
          pf.hasLineOfSight(pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y),
          `${from}→${to} 의 ${i}번째 구간이 벽을 지난다`,
        ).toBe(true);
      }
    }
  });

  it('벽에 딱 붙은 지점이 5% 미만', () => {
    // 문틀처럼 좁은 데는 어쩔 수 없다 — 0 을 요구하면 문을 못 지난다
    const hugging = all.filter((c) => c <= 1).length;
    expect(hugging / all.length).toBeLessThan(0.05);
  });
});
