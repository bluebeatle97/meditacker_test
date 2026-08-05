import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Zone } from '@meditracker/shared';
import { IN_ZONE_PX, poseFor, sittableAt } from './pose.js';

/**
 * 자세 규칙 검증. 브라우저(WebGL) 없이 확인할 수 있어야 해서 순수 함수로 뺐고,
 * 실제 zones.json 으로 돌려 "대기공간에서는 앉는다" 를 좌표로 확인한다.
 */

const here = dirname(fileURLToPath(import.meta.url));
const zones = JSON.parse(
  readFileSync(join(here, '../../server/src/config/zones.json'), 'utf-8'),
) as Zone[];

const at = (zoneId: string): { x: number; y: number } => {
  const z = zones.find((v) => v.zoneId === zoneId);
  if (!z) throw new Error(`없는 존: ${zoneId}`);
  return z.tilePosition;
};

describe('poseFor', () => {
  it('움직이는 동안은 무조건 걷기 — 앉을 수 있는 방 안이라도', () => {
    const p = at('waiting_1');
    expect(poseFor(zones, 'u1', true, p.x, p.y)).toBe('walk');
  });

  it('대기공간에 머무르면 앉거나 폰을 본다', () => {
    const p = at('waiting_1');
    const poses = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => poseFor(zones, id, false, p.x, p.y));
    expect(poses.every((x) => x === 'sit' || x === 'phone')).toBe(true);
  });

  it('전원이 같은 자세는 아니다 (인형처럼 보이지 않게)', () => {
    const p = at('waiting_2');
    const ids = Array.from({ length: 30 }, (_, i) => `u${i}`);
    const kinds = new Set(ids.map((id) => poseFor(zones, id, false, p.x, p.y)));
    expect(kinds.size).toBeGreaterThan(1);
  });

  it('같은 사람은 늘 같은 자세 (프레임마다 흔들리면 안 된다)', () => {
    const p = at('waiting_3');
    const once = poseFor(zones, 'guest-42', false, p.x, p.y);
    for (let i = 0; i < 20; i++) expect(poseFor(zones, 'guest-42', false, p.x, p.y)).toBe(once);
  });

  it('수술실·직원구역·접수에서는 서 있는다', () => {
    for (const zoneId of ['surgery_1', 'reception']) {
      const p = at(zoneId);
      expect(poseFor(zones, 'u1', false, p.x, p.y), zoneId).toBe('idle');
    }
  });

  it('상담실·회복실·피부관리실은 앉는 방이다', () => {
    for (const zoneId of ['consult_1', 'recovery_1', 'skincare']) {
      const p = at(zoneId);
      expect(sittableAt(zones, p.x, p.y), zoneId).toBe(true);
    }
  });

  it('방에서 멀리 떨어진 복도 한가운데서는 앉지 않는다', () => {
    const p = at('waiting_1');
    // 존 중심에서 문턱보다 더 멀리 — 어느 방에도 안 속한 지점
    expect(sittableAt(zones, p.x + IN_ZONE_PX * 3, p.y + IN_ZONE_PX * 3)).toBe(false);
  });
});
