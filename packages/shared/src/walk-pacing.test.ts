import { describe, expect, it } from 'vitest';
import {
  MAX_CATCHUP_MULT,
  UpdateClock,
  WALK_PX_PER_SEC,
  paceForPath,
  pathLengthPx,
} from './walk-pacing.js';

/**
 * 두 패널(직원용·환자용)이 같은 브로드캐스트를 받아 각자 보간할 때
 * 화면상 같은 자리에 있는지를 시뮬레이션으로 검증한다.
 *
 * 이 테스트가 존재하는 이유: 예전에 두 화면이 어긋난 원인이 "보간 속도를 사람이 걷는
 * 속도로 고정" 한 것이었다. 목표가 도망가는 속도와 쫓는 속도가 같으면 따라잡을 여유가
 * 0이라, 한 번 벌어진 간격이 영원히 유지된다. 로직이 다시 그렇게 돌아가면 여기서 깨진다.
 */

const FRAME_MS = 16.7;

interface SimResult {
  /** 화면이 얼었다 녹은 뒤 두 패널이 벌어진 최대 간격 (px) */
  maxGapPx: number;
  /**
   * 그 간격이 10px(≈16cm) 아래로 줄어들기까지 걸린 시간(초).
   * 옛 방식은 **사람이 방에서 멈출 때까지** 못 좁힌다 — 걷는 동안엔 쫓아갈 여유가 0이라서.
   */
  recoverySec: number;
  /** 사람은 움직이는데 아바타는 제자리인 프레임 비율(%) — 화면에서 '멈칫멈칫' 으로 보이는 것 */
  stutterPct: number;
  /**
   * 아바타가 **실제 사람 위치보다** 얼마나 뒤처져 그려지는가 (걷는 중 평균, px).
   * 브로드캐스트 주기를 줄이면 이 값이 준다 — 패널 간 간격과는 다른 지표다.
   */
  meanLagPx: number;
}

/**
 * 실제 병원 동선을 흉내 낸다: **걷다가 방에서 한참 멈춰 있다가** 다시 걷는다.
 * (등속으로만 걷게 하면 고정 속도 보간이 우연히 딱 맞아떨어져 문제가 안 드러난다.)
 */
const WALK_PHASE_MS = 8_000;
const PAUSE_PHASE_MS = 12_000;
const CYCLE_MS = WALK_PHASE_MS + PAUSE_PHASE_MS;

function truthAt(t: number): { pos: number; moving: boolean } {
  const cycles = Math.floor(t / CYCLE_MS);
  const inCycle = t % CYCLE_MS;
  const walked = Math.min(inCycle, WALK_PHASE_MS);
  return {
    pos: (WALK_PX_PER_SEC * (cycles * WALK_PHASE_MS + walked)) / 1000,
    moving: inCycle < WALK_PHASE_MS,
  };
}

/**
 * 두 패널이 같은 브로드캐스트를 받는다. 도중에 패널 B 의 화면이 잠시 얼어붙는다
 * (탭 백그라운드 = rAF 정지). 그 뒤 둘이 다시 만나는지를 본다.
 */
function simulate(opts: {
  intervalMs: number;
  /** true 면 옛 방식(고정 보행 속도), false 면 구간마다 재계산 */
  fixedPace: boolean;
  freeze: { fromMs: number; toMs: number };
  seconds: number;
}): SimResult {
  const panels = [0, 1].map(() => ({ pos: 0, target: 0, pace: WALK_PX_PER_SEC }));
  let nextTick = opts.intervalMs;
  let maxGapPx = 0;
  let recoveredAt: number | null = null;
  let totalFrames = 0;
  let stutterFrames = 0;
  let lagSum = 0;
  let movingFrames = 0;

  for (let t = 0; t < opts.seconds * 1000; t += FRAME_MS) {
    const truth = truthAt(t);

    if (t >= nextTick) {
      nextTick += opts.intervalMs;
      for (const p of panels) {
        p.target = truth.pos;
        p.pace = opts.fixedPace
          ? WALK_PX_PER_SEC
          : paceForPath(Math.abs(p.target - p.pos), opts.intervalMs);
      }
    }

    for (const [i, p] of panels.entries()) {
      // 패널 B 만 이 구간 동안 프레임이 멈춘다 (화면이 얼어붙은 상태)
      if (i === 1 && t >= opts.freeze.fromMs && t < opts.freeze.toMs) continue;
      const step = (p.pace * FRAME_MS) / 1000;
      const d = p.target - p.pos;
      const move = Math.sign(d) * Math.min(Math.abs(d), step);
      if (i === 0 && truth.moving && Math.abs(move) < 1e-6) stutterFrames++;
      p.pos += move;
    }
    totalFrames++;
    if (truth.moving) {
      lagSum += Math.abs(truth.pos - panels[0].pos);
      movingFrames++;
    }

    // 얼어 있는 동안 벌어지는 건 당연하다 — 녹은 뒤에 좁혀지는지가 관심사
    if (t >= opts.freeze.toMs) {
      const gap = Math.abs(panels[0].pos - panels[1].pos);
      maxGapPx = Math.max(maxGapPx, gap);
      if (recoveredAt === null && gap < 10) recoveredAt = t;
    }
  }

  return {
    maxGapPx,
    recoverySec: ((recoveredAt ?? opts.seconds * 1000) - opts.freeze.toMs) / 1000,
    stutterPct: (stutterFrames / totalFrames) * 100,
    meanLagPx: movingFrames > 0 ? lagSum / movingFrames : 0,
  };
}

describe('paceForPath', () => {
  it('다음 좌표가 올 때쯤 도착하도록 속도를 정한다', () => {
    // 1.5초 뒤 도착해야 하는 150px → 대략 100px/초 (여유배수만큼 조금 느리게)
    const pace = paceForPath(150, 1500);
    expect(pace).toBeGreaterThan(60);
    expect(pace).toBeLessThan(100);
  });

  it('아무리 멀어도 상한을 넘지 않는다 (순간이동처럼 튀지 않게)', () => {
    expect(paceForPath(100_000, 1500)).toBe(WALK_PX_PER_SEC * MAX_CATCHUP_MULT);
  });

  it('거의 안 움직였으면 느리게 — 하한을 두면 "쏜살같이 갔다가 멈추기" 가 된다', () => {
    expect(paceForPath(5, 1500)).toBeLessThan(WALK_PX_PER_SEC / 4);
  });

  it('주기가 0이어도 폭주하지 않는다', () => {
    expect(Number.isFinite(paceForPath(300, 0))).toBe(true);
  });
});

describe('pathLengthPx', () => {
  it('waypoint 를 차례로 지나는 총 거리', () => {
    expect(pathLengthPx({ x: 0, y: 0 }, [{ x: 3, y: 4 }, { x: 3, y: 14 }])).toBeCloseTo(15);
  });

  it('경로가 비면 0', () => {
    expect(pathLengthPx({ x: 10, y: 10 }, [])).toBe(0);
  });
});

describe('UpdateClock', () => {
  it('관측한 브로드캐스트 주기로 수렴한다 (서버가 주기를 바꿔도 따라간다)', () => {
    const clock = new UpdateClock(3500);
    let t = 0;
    for (let i = 0; i < 30; i++) {
      t += 1500;
      clock.tick(t);
    }
    expect(clock.intervalMs).toBeGreaterThan(1400);
    expect(clock.intervalMs).toBeLessThan(1600);
  });

  it('탭 복귀 같은 이상치는 주기 추정을 오염시키지 않는다', () => {
    const clock = new UpdateClock(1500);
    let t = 0;
    for (let i = 0; i < 10; i++) clock.tick((t += 1500));
    clock.tick((t += 120_000)); // 2분간 백그라운드
    for (let i = 0; i < 3; i++) clock.tick((t += 1500));
    expect(clock.intervalMs).toBeLessThan(1700);
  });
});

describe('두 패널 동기화', () => {
  // 걷는 도중(0~8초가 보행 구간) 2초간 패널 B 화면이 얼어붙는다 → 그만큼 뒤처짐
  const FREEZE = { fromMs: 2_000, toMs: 4_000 };
  const SECONDS = 60;
  /** ⚠️ 페이싱 효과만 보려면 **주기를 같게 두고** 비교해야 한다 (주기 단축은 별개의 개선) */
  const fixed = (intervalMs: number) =>
    simulate({ intervalMs, fixedPace: true, freeze: FREEZE, seconds: SECONDS });
  const paced = (intervalMs: number) =>
    simulate({ intervalMs, fixedPace: false, freeze: FREEZE, seconds: SECONDS });

  it('옛 방식은 사람이 방에 멈춰 설 때까지 간격을 못 좁힌다 (걷는 동안 쫓아갈 여유가 0)', () => {
    // 보행 구간이 끝날 때까지 버티다 그제서야 회복 → 그동안 두 화면이 어긋난 채로 보인다
    expect(fixed(1500).recoverySec).toBeGreaterThan(3);
  });

  it('구간마다 속도를 다시 정하면 걷는 중에도 스스로 따라붙는다', () => {
    const r = paced(1500);
    expect(r.recoverySec).toBeLessThan(fixed(1500).recoverySec);
    expect(r.recoverySec).toBeLessThan(4); // 몇 주기 안에 붙는다
  });

  it('주기가 길어도(3.5초) 따라잡기 자체는 동작한다', () => {
    expect(paced(3500).recoverySec).toBeLessThan(fixed(3500).recoverySec);
  });

  it('주기를 줄이면 아바타가 실제 위치를 더 바짝 따라간다 (주기 단축의 효과는 이쪽)', () => {
    expect(paced(1500).meanLagPx).toBeLessThan(paced(3500).meanLagPx * 0.6);
  });

  it('고정 속도는 사람이 걷는 중에도 아바타가 멈춰 서는 구간이 더 많다 (가다 서다)', () => {
    expect(paced(1500).stutterPct).toBeLessThan(fixed(1500).stutterPct * 0.6);
    expect(paced(1500).stutterPct).toBeLessThan(4);
  });
});
