import { describe, expect, it, vi } from 'vitest';
import { ScanRateMeter, smoothingFor } from './scan-rate.js';

const OPTS = { normal: 0.35, slow: 0.15, slowBelow: 1 };

describe('smoothingFor', () => {
  it('빈도를 모르면 기본값 — 새 태그가 굼뜨게 시작하지 않게', () => {
    expect(smoothingFor(null, OPTS)).toBe(0.35);
  });

  it('느린 태그만 세게 누른다', () => {
    expect(smoothingFor(0.4, OPTS)).toBe(0.15); // 카드형 실측
    expect(smoothingFor(1.6, OPTS)).toBe(0.35); // CP35 실측
  });

  it('경계값은 기본값 쪽 — 문턱에 걸친 태그가 계수를 오가지 않게', () => {
    expect(smoothingFor(1, OPTS)).toBe(0.35);
  });
});

describe('ScanRateMeter', () => {
  it('한 구간이 지나기 전에는 모른다고 답한다', () => {
    const m = new ScanRateMeter(10_000);
    for (let i = 0; i < 5; i++) m.record('A');
    expect(m.rateOf('A')).toBeNull();
  });

  it('구간이 지나면 초당 건수를 낸다', () => {
    vi.useFakeTimers();
    try {
      const m = new ScanRateMeter(10_000);
      for (let i = 0; i < 16; i++) m.record('빠름');
      for (let i = 0; i < 4; i++) m.record('느림');
      vi.advanceTimersByTime(10_000);
      m.record('빠름'); // 구간을 닫는 것은 다음 기록이다

      expect(m.rateOf('빠름')).toBeCloseTo(1.6, 1);
      expect(m.rateOf('느림')).toBeCloseTo(0.4, 1);
      expect(smoothingFor(m.rateOf('느림'), OPTS)).toBe(0.15);
      expect(smoothingFor(m.rateOf('빠름'), OPTS)).toBe(0.35);
    } finally {
      vi.useRealTimers();
    }
  });

  it('구간이 바뀌면 옛 건수를 안 끌고 간다', () => {
    vi.useFakeTimers();
    try {
      const m = new ScanRateMeter(10_000);
      for (let i = 0; i < 100; i++) m.record('A');
      vi.advanceTimersByTime(10_000);
      m.record('A');
      expect(m.rateOf('A')).toBeGreaterThan(9);

      // 다음 구간에는 거의 안 들어왔다
      vi.advanceTimersByTime(10_000);
      m.record('A');
      expect(m.rateOf('A')).toBeLessThan(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('잊은 태그는 빈도가 사라진다', () => {
    vi.useFakeTimers();
    try {
      const m = new ScanRateMeter(10_000);
      m.record('A');
      vi.advanceTimersByTime(10_000);
      m.record('A');
      expect(m.rateOf('A')).not.toBeNull();
      m.forget('A');
      expect(m.rateOf('A')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
