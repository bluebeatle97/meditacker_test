import { describe, expect, it } from 'vitest';
import { isPrivateRoom, type Zone } from '@meditracker/shared';
import { loadZones } from '../config/index.js';
import { visibleToOtherPatients } from './patient-namespace.js';

/**
 * 환자용 화면에서 **다른 손님**이 보이는 범위.
 *
 * 손님끼리는 프라이버시가 있어서, 진료 관련 방에 들어간 사람은 다른 손님 화면에
 * 좌표가 나가지 않는다. 화면에서 감추는 게 아니라 **서버가 안 보낸다** — 화면에서만
 * 숨기면 개발자도구로 다 보인다.
 *
 * ⚠️ 직원용 패널·관제는 이 규칙과 무관하다. 직원은 전원을 봐야 환자를 찾는다.
 *    이 파일은 `/patient` 로 나가는 것만 다룬다.
 */

const zones = loadZones();
const byName = (name: string): Zone => {
  const z = zones.find((x) => x.name === name);
  if (!z) throw new Error(`존 '${name}' 이 zones.json 에 없다 — 도면이 바뀌었으면 이 테스트도 고친다`);
  return z;
};
const isPrivate = (zoneId: string): boolean =>
  zones.some((z) => z.zoneId === zoneId && isPrivateRoom(z));

describe('진료 관련 방 판정 (실제 zones.json 기준)', () => {
  // 이름을 박아 두는 이유: category 를 잘못 건드리면 조용히 통과한다.
  // "상담실이 숨겨지나" 는 사람이 읽고 판단할 수 있어야 한다.
  it.each(['상담실 1', '시술실 2', '수술실 1', '레이저실 1', 'VIP 회복실', '피부관리실', '탈의실', '촬영실'])(
    '%s 은 다른 손님에게 안 보인다',
    (name) => {
      expect(isPrivateRoom(byName(name))).toBe(true);
    },
  );

  it.each(['공용화장실', '여자화장실 1', '여자화장실 2', '여자 체인징룸 1', '남자 체인징룸'])(
    '%s 도 안 보인다 (분류는 common 이지만 프라이버시는 더 세다)',
    (name) => {
      expect(isPrivateRoom(byName(name))).toBe(true);
    },
  );

  it.each(['대기공간 1', '대기공간 2', '대기공간 3', '접수데스크'])(
    '%s 은 그대로 보인다 (여럿이 같이 쓰는 곳)',
    (name) => {
      expect(isPrivateRoom(byName(name))).toBe(false);
    },
  );

  it('ELEV.홀은 보인다 — 화장실과 같은 etc 로 묶여 있던 곳이라 못 박아 둔다', () => {
    // 화장실·체인징룸을 이름이나 옛 `etc` 종류로 걸렀다면 여기가 같이 걸려 넘어진다.
    // 통행 공간이라 숨기면 사람이 복도에서 사라졌다 나타나는 것으로 보인다.
    expect(isPrivateRoom(byName('ELEV.홀'))).toBe(false);
  });

  it('직원 화장실도 숨김 대상이다 — 손님 태그가 잘못 배정돼도 새지 않게', () => {
    // 직원 태그는 isGuest 에서 이미 걸러지므로 평소엔 여기까지 안 온다.
    // 다만 팔찌를 잘못 배정하는 일은 실제로 생기고, 그때 안전한 쪽으로 넘어져야 한다.
    expect(isPrivateRoom(byName('직원 화장실'))).toBe(true);
  });

  it('진료 관련 방이 하나도 안 잡히면 규칙이 죽은 것이다', () => {
    expect(zones.filter(isPrivateRoom).length).toBeGreaterThan(10);
  });
});

describe('좌표를 다른 손님에게 보낼까', () => {
  it('진료실 안 — 안 보낸다', () => {
    expect(visibleToOtherPatients({ zone: byName('상담실 1').zoneId }, isPrivate)).toBe(false);
  });

  it('대기공간 — 보낸다', () => {
    expect(visibleToOtherPatients({ zone: byName('대기공간 1').zoneId }, isPrivate)).toBe(true);
  });

  it('추적 구역 밖(zone 없음) — 보낸다', () => {
    expect(visibleToOtherPatients({ zone: null }, isPrivate)).toBe(true);
  });

  it('복도 이동 중이면 zone 이 진료실이라도 보낸다', () => {
    // 복도에는 게이트웨이가 없어 zone 이 '제일 가까운 방' 을 찍는다. 그걸 그대로 믿으면
    // 복도를 걷는 사람이 방 앞을 지날 때마다 깜빡깜빡 사라진다.
    const consult = byName('상담실 1').zoneId;
    expect(visibleToOtherPatients({ zone: consult, inTransit: true }, isPrivate)).toBe(true);
    expect(visibleToOtherPatients({ zone: consult, inTransit: false }, isPrivate)).toBe(false);
  });
});
