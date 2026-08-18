import { describe, expect, it } from 'vitest';
import { PinGate } from './staff-pin.js';

/**
 * 진입 핀 관문. 여기서 지키려는 것은 두 가지다.
 *
 * 1. 틀린 핀으로는 못 들어온다 (당연한 것)
 * 2. **막 던지지는 못한다** — 6자리는 100만 가지뿐이라 잠금이 없으면 한 겹이 아니다
 *
 * 시간은 손으로 돌린다. 실제로 60초를 기다리는 테스트는 아무도 안 돌린다.
 */
const setup = (pin = '000111') => {
  let t = 1_000_000;
  const gate = new PinGate(pin, () => t, 5, 60_000);
  return { gate, tick: (ms: number) => (t += ms) };
};

describe('PinGate', () => {
  it('맞는 핀은 통과', () => {
    const { gate } = setup();
    expect(gate.attempt('1.1.1.1', '000111')).toBe('ok');
  });

  it('틀린 핀은 거부', () => {
    const { gate } = setup();
    expect(gate.attempt('1.1.1.1', '000112')).toBe('bad');
  });

  it('앞뒤가 같아도 길이가 다르면 거부 (부분 일치로 통과하지 않는다)', () => {
    const { gate } = setup();
    expect(gate.attempt('1.1.1.1', '000')).toBe('bad');
    expect(gate.attempt('1.1.1.1', '0001110')).toBe('bad');
  });

  it('연속 5회 실패면 잠긴다', () => {
    const { gate } = setup();
    for (let i = 0; i < 4; i++) expect(gate.attempt('1.1.1.1', 'x')).toBe('bad');
    expect(gate.attempt('1.1.1.1', 'x')).toBe('locked');
  });

  it('잠긴 동안은 맞는 핀도 안 받는다 — 이게 없으면 잠금이 무의미하다', () => {
    const { gate } = setup();
    for (let i = 0; i < 5; i++) gate.attempt('1.1.1.1', 'x');
    expect(gate.attempt('1.1.1.1', '000111')).toBe('locked');
  });

  it('60초 지나면 다시 받아 준다', () => {
    const { gate, tick } = setup();
    for (let i = 0; i < 5; i++) gate.attempt('1.1.1.1', 'x');
    tick(60_001);
    expect(gate.attempt('1.1.1.1', '000111')).toBe('ok');
  });

  it('잠금이 풀린 뒤 한 번 틀린 것으로 바로 다시 잠기지 않는다', () => {
    const { gate, tick } = setup();
    for (let i = 0; i < 5; i++) gate.attempt('1.1.1.1', 'x');
    tick(60_001);
    expect(gate.attempt('1.1.1.1', 'x')).toBe('bad');
  });

  it('성공하면 실패 횟수가 초기화된다', () => {
    const { gate } = setup();
    for (let i = 0; i < 4; i++) gate.attempt('1.1.1.1', 'x');
    expect(gate.attempt('1.1.1.1', '000111')).toBe('ok');
    for (let i = 0; i < 4; i++) expect(gate.attempt('1.1.1.1', 'x')).toBe('bad');
  });

  it('한 쪽이 잠겨도 다른 쪽은 들어올 수 있다 (전원이 같이 잠기면 시연이 멈춘다)', () => {
    const { gate } = setup();
    for (let i = 0; i < 5; i++) gate.attempt('1.1.1.1', 'x');
    expect(gate.attempt('2.2.2.2', '000111')).toBe('ok');
  });

  it('남은 잠금 시간을 알려준다 (화면에 몇 초 뒤라고 띄우려면 필요하다)', () => {
    const { gate, tick } = setup();
    for (let i = 0; i < 5; i++) gate.attempt('1.1.1.1', 'x');
    tick(20_000);
    expect(gate.lockedForMs('1.1.1.1')).toBe(40_000);
    expect(gate.lockedForMs('2.2.2.2')).toBe(0);
  });
});
