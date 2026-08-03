import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DemoSim } from './demo-sim.js';
import { MOCK_TAGS, ROUTES } from './mock-tags.js';
import type { Zone } from './index.js';

/**
 * 브라우저 시연 모드(서버 없는 정적 배포)의 좌표 발생기 검증.
 *
 * 이 코드는 GitHub Pages 에만 올라가고 서버 테스트를 안 거치므로, 깨져도 배포된 화면을
 * 열어 보기 전까지 아무도 모른다. 특히 **경로에 적힌 존 id 가 zones.json 과 어긋나는
 * 경우**는 조용히 빈 화면이 되므로 여기서 잡는다.
 */

const here = dirname(fileURLToPath(import.meta.url));
const zones = JSON.parse(
  readFileSync(join(here, '../../server/src/config/zones.json'), 'utf-8'),
) as Zone[];

describe('DemoSim', () => {
  it('명단 전원의 좌표를 낸다', () => {
    const sim = new DemoSim(zones);
    const p = sim.positions();
    expect(p).toHaveLength(MOCK_TAGS.length);
    expect(new Set(p.map((x) => x.tagId)).size).toBe(MOCK_TAGS.length);
  });

  it('동선에 적힌 존이 모두 zones.json 에 있다', () => {
    const known = new Set(zones.map((z) => z.zoneId));
    for (const [name, stops] of Object.entries(ROUTES)) {
      for (const s of stops) {
        expect(known.has(s.zoneId), `경로 '${name}' 의 존 '${s.zoneId}'`).toBe(true);
      }
    }
  });

  it('시간이 흐르면 사람이 움직인 자리로 바뀐다', () => {
    const t0 = 1_700_000_000_000;
    const sim = new DemoSim(zones, { now: t0 });
    const a = sim.positions(t0);
    // 30초면 모두가 아니라도 몇 명은 걷고 있다 (나머지는 방에서 머무는 구간)
    const b = sim.positions(t0 + 30_000);
    const moved = a.filter((p, i) => Math.hypot(p.x - b[i].x, p.y - b[i].y) > 1);
    expect(moved.length).toBeGreaterThan(0);
  });

  it('한 바퀴를 돌면 처음 자리로 돌아온다 (동선이 순환한다)', () => {
    const t0 = 1_700_000_000_000;
    const sim = new DemoSim(zones, { now: t0 });
    // 어느 경로든 한 바퀴는 30분 안이다 — 그보다 훨씬 큰 값으로 여러 바퀴를 돌린다
    const a = sim.positions(t0);
    const b = sim.positions(t0 + 6 * 60 * 60 * 1000);
    expect(b).toHaveLength(a.length);
    for (const p of b) expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
  });

  it('좌표가 도면 안에 있고 존 판정이 실재하는 존이다', () => {
    const known = new Set(zones.map((z) => z.zoneId));
    const sim = new DemoSim(zones);
    for (let min = 0; min < 60; min += 3) {
      for (const p of sim.positions(Date.now() + min * 60_000)) {
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.y).toBeGreaterThanOrEqual(0);
        expect(p.x).toBeLessThan(2000); // 도면 1650px — 넉넉히 잡아도 벗어나면 안 된다
        expect(p.y).toBeLessThan(2000);
        expect(p.zone === null || known.has(p.zone)).toBe(true);
      }
    }
  });

  it('이름·그룹이 목 명단과 같다', () => {
    const meta = new DemoSim(zones).tagMeta();
    expect(Object.keys(meta)).toHaveLength(MOCK_TAGS.length);
    expect(meta['AA:BB:CC:00:00:01']).toMatchObject({ name: '손님 1', group: 'patient' });
    expect(meta['AA:BB:CC:00:00:50']).toMatchObject({ name: '김원장', group: 'doctor' });
  });

  it('환자 화면이 걸러 쓸 손님/직원 구분이 명단에 남아 있다 (불변식 B-1)', () => {
    // 환자 화면은 손님 비콘만 그린다. 직원 동선이 하나도 없으면 그 필터가 무의미해진다
    const meta = new DemoSim(zones).tagMeta();
    const groups = Object.values(meta).map((m) => m.group);
    expect(groups).toContain('patient');
    expect(groups.some((g) => g === 'doctor' || g === 'nurse')).toBe(true);
  });
});
