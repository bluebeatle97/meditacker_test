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

/** 방을 가로질러 다니는 실제 안내 조합들 */
const ROUTES: Array<[string, string]> = [
  ['waiting_1', 'consult_1'],
  ['reception', 'recovery_1'],
  ['waiting_3', 'surgery_1'],
  ['consult_2', 'consult_1'],
  ['waiting_2', 'skincare'],
];

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

  it('벽에 딱 붙은 지점이 5% 미만', () => {
    // 문틀처럼 좁은 데는 어쩔 수 없다 — 0 을 요구하면 문을 못 지난다
    const hugging = all.filter((c) => c <= 1).length;
    expect(hugging / all.length).toBeLessThan(0.05);
  });
});
