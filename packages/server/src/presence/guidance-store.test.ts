import { describe, expect, it } from 'vitest';
import { GuidanceStore } from './guidance-store.js';
import { isGuidableZone, type Zone } from '@meditracker/shared';
import { loadZones } from '../config/index.js';

describe('방 안내 저장소', () => {
  it('안내를 걸고 풀 수 있다', () => {
    const s = new GuidanceStore();
    s.set('tag-a', 'consult_1', 1000);
    expect(s.get('tag-a')?.zoneId).toBe('consult_1');
    expect(s.clear('tag-a')).toBe(true);
    expect(s.get('tag-a')).toBeUndefined();
    expect(s.clear('tag-a'), '없는 안내를 풀면 아무 일도 없어야 한다').toBe(false);
  });

  it('같은 방을 다시 걸면 시작 시각이 안 바뀐다', () => {
    // 직원이 같은 버튼을 두 번 눌렀다고 "방금 시작한 안내"가 되면 경과 시간이 리셋된다
    const s = new GuidanceStore();
    s.set('tag-a', 'consult_1', 1000);
    s.set('tag-a', 'consult_1', 5000);
    expect(s.get('tag-a')?.since).toBe(1000);
    s.set('tag-a', 'consult_2', 5000);
    expect(s.get('tag-a')?.since, '목적지가 바뀌면 새 안내다').toBe(5000);
  });

  describe('도착 판정', () => {
    const s = new GuidanceStore();
    s.set('tag-a', 'consult_1', 0);
    s.set('tag-b', 'recovery_1', 0);

    it('목적지 방에 있는 것만 도착이다', () => {
      const done = s.arrived([
        { tagId: 'tag-a', zone: 'consult_1' },
        { tagId: 'tag-b', zone: 'waiting_1' },
      ]);
      expect(done.map((g) => g.tagId)).toEqual(['tag-a']);
    });

    it('복도(존 없음)는 도착이 아니다', () => {
      // 복도엔 게이트웨이가 없어 존이 빈다. 여기서 도착으로 치면 방 앞을 지나가기만 해도 끝난다
      expect(s.arrived([{ tagId: 'tag-a', zone: null }])).toEqual([]);
    });

    it('좌표가 안 오는 태그는 도착이 아니다', () => {
      expect(s.arrived([])).toEqual([]);
    });
  });
});

describe('안내 목적지 규칙', () => {
  const zones: Zone[] = loadZones();
  const guidable = zones.filter(isGuidableZone);
  const name = (id: string): boolean => guidable.some((z) => z.zoneId === id);

  it('진료 관련 방·대기공간·접수데스크는 목적지다', () => {
    for (const id of ['consult_1', 'surgery_1', 'recovery_1', 'photo', 'waiting_1', 'reception']) {
      expect(name(id), `${id} 가 빠졌다`).toBe(true);
    }
  });

  it('직원 구역·화장실·체인징룸·ELEV.홀은 목적지가 아니다', () => {
    // 환자를 "직원실로 가세요" 라고 안내할 일은 없다. 서버도 이 규칙으로 거절한다
    for (const id of ['staff_room', 'sterilize', 'toilet_common', 'changing_m', 'elev_hall']) {
      expect(name(id), `${id} 가 목적지로 잡혔다`).toBe(false);
    }
  });

  it('목적지가 방 목록의 절반 이상이다 (규칙이 너무 좁아지지 않게)', () => {
    expect(guidable.length).toBeGreaterThan(zones.length / 2);
  });
});
