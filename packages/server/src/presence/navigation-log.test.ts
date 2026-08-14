import { beforeEach, describe, expect, it } from 'vitest';
import { NavigationLogStore, type NavEvent } from './navigation-log.js';
import { assignBeacon, openDb, releaseBeacon, type Db } from '../db/index.js';

/**
 * 이 테스트가 지키려는 것은 **"영원히 이동 중" 인 줄이 안 남는다** 는 것 하나다.
 * 안내가 메모리에만 있으면 못 지키는 성질이고, 알림톡이 붙는 순간 그게 곧
 * 끝나지 않는 알림이 된다 (schema.sql 의 navigation_logs 주석).
 */
describe('방 안내 이력', () => {
  let db: Db;
  let clock: number;
  let events: NavEvent[];
  let nav: NavigationLogStore;

  beforeEach(() => {
    db = openDb(':memory:');
    clock = 1_000_000;
    events = [];
    nav = new NavigationLogStore(db, () => clock);
    nav.onEvent((e) => events.push(e));
  });

  const kinds = (): string[] => events.map((e) => e.kind);

  it('발행하면 moving 으로 열리고 departed 가 한 번 나간다', () => {
    const log = nav.issue('tag-a', 'proc_1', 'waiting_1');
    expect(log.status).toBe('moving');
    expect(log.toZone).toBe('proc_1');
    expect(log.fromZone).toBe('waiting_1');
    expect(log.closedAt).toBeNull();
    expect(kinds()).toEqual(['departed']);
  });

  it('같은 방을 다시 걸면 새 줄도, 알림도 생기지 않는다', () => {
    // 직원이 같은 버튼을 두 번 눌렀다고 메신저가 두 번 울리면 안 된다
    const first = nav.issue('tag-a', 'proc_1', 'waiting_1');
    clock += 5_000;
    const again = nav.issue('tag-a', 'proc_1', 'waiting_1');
    expect(again.id).toBe(first.id);
    expect(again.issuedAt, '경과 시간이 리셋되면 안 된다').toBe(first.issuedAt);
    expect(kinds()).toEqual(['departed']);
    expect(nav.list()).toHaveLength(1);
  });

  it('도착하면 닫히고 소요 시간이 남는다', () => {
    nav.issue('tag-a', 'proc_1', 'waiting_1');
    clock += 42_000;
    const done = nav.arrived('tag-a');
    expect(done?.status).toBe('arrived');
    expect(done?.travelSec).toBe(42);
    expect(done?.arrivedAt).toBe(clock);
    expect(nav.open('tag-a'), '닫힌 뒤에는 진행 중인 줄이 없어야 한다').toBeUndefined();
    expect(kinds()).toEqual(['departed', 'arrived']);
  });

  it('해제·중단에는 소요 시간을 채우지 않는다', () => {
    // 채워 두면 평균 이동시간을 낼 때 걸러야 할 값이 섞인다
    nav.issue('tag-a', 'proc_1', null);
    clock += 9_000;
    expect(nav.cancelled('tag-a')?.travelSec).toBeNull();

    nav.issue('tag-b', 'proc_2', null);
    clock += 9_000;
    expect(nav.aborted('tag-b')?.travelSec).toBeNull();
    expect(kinds()).toEqual(['departed', 'cancelled', 'departed', 'aborted']);
  });

  it('목적지를 바꾸면 앞 줄은 superseded 로 닫히고 새 줄이 열린다', () => {
    const first = nav.issue('tag-a', 'proc_1', 'waiting_1');
    clock += 3_000;
    const second = nav.issue('tag-a', 'proc_2', 'waiting_1');

    expect(second.id).not.toBe(first.id);
    const all = nav.list({ tagId: 'tag-a' });
    expect(all).toHaveLength(2);
    expect(all.find((l) => l.id === first.id)?.status).toBe('superseded');
    expect(all.find((l) => l.id === second.id)?.status).toBe('moving');
    // superseded 자체는 알리지 않는다 — 곧바로 뒤따르는 departed 가 대신 말해 준다
    expect(kinds()).toEqual(['departed', 'departed']);
  });

  it('열린 줄이 없으면 닫아도 아무 일이 없다', () => {
    expect(nav.arrived('tag-a')).toBeUndefined();
    expect(nav.cancelled('tag-a')).toBeUndefined();
    expect(kinds()).toEqual([]);
  });

  it('두 번 도착 처리해도 두 번째는 무시된다', () => {
    // 도착 판정은 좌표 방송 루프에서 매 주기 돈다 — 같은 안내를 두 번 닫으면 알림이 겹친다
    nav.issue('tag-a', 'proc_1', null);
    clock += 1_000;
    expect(nav.arrived('tag-a')?.status).toBe('arrived');
    expect(nav.arrived('tag-a')).toBeUndefined();
    expect(kinds()).toEqual(['departed', 'arrived']);
  });

  it('재시작 정리는 진행 중인 줄만 끊고, 이벤트는 내지 않는다', () => {
    nav.issue('tag-a', 'proc_1', null);
    nav.issue('tag-b', 'proc_2', null);
    clock += 1_000;
    nav.arrived('tag-b'); // 이미 끝난 줄은 건드리면 안 된다
    events = [];

    expect(nav.reconcileOnBoot()).toBe(1);
    expect(nav.list({ tagId: 'tag-a' })[0].status).toBe('aborted');
    expect(nav.list({ tagId: 'tag-b' })[0].status, '도착한 줄은 그대로').toBe('arrived');
    expect(kinds(), '알릴 상대가 이미 없는 안내들이다').toEqual([]);
  });

  describe('사람 정보 스냅샷', () => {
    it('발행 시점의 배정된 사람과 이름을 박아 둔다', () => {
      assignBeacon(db, { tagId: 'tag-a', displayName: '사과', group: 'patient' });
      const log = nav.issue('tag-a', 'proc_1', null);
      expect(log.personName).toBe('사과');
      expect(log.personId).toMatch(/^patient-a\d+$/);
    });

    it('반납·재배정 뒤에도 옛 줄의 사람은 그대로 남는다', () => {
      // 비콘을 돌려쓰므로 tag_id 만 들고 있으면 오전 환자 기록에 오후 환자가 섞인다
      assignBeacon(db, { tagId: 'tag-a', displayName: '사과', group: 'patient' });
      const first = nav.issue('tag-a', 'proc_1', null);
      clock += 1_000;
      nav.arrived('tag-a');
      releaseBeacon(db, 'tag-a');

      assignBeacon(db, { tagId: 'tag-a', displayName: '딸기', group: 'patient' });
      clock += 1_000;
      const second = nav.issue('tag-a', 'proc_2', null);

      expect(second.personName).toBe('딸기');
      expect(second.personId).not.toBe(first.personId);
      const kept = nav.list({ tagId: 'tag-a' }).find((l) => l.id === first.id);
      expect(kept?.personName).toBe('사과');
      expect(kept?.personId).toBe(first.personId);
    });

    it('창고 비콘(배정 없음)에 걸면 사람 없이 기록된다', () => {
      const log = nav.issue('tag-x', 'proc_1', null);
      expect(log.personId).toBeNull();
      expect(log.personName).toBeNull();
    });
  });
});
