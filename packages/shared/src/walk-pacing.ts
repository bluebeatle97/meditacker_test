/**
 * 아바타 보간 페이싱 — **직원용·환자용이 반드시 같은 값을 쓰도록** 여기 한 곳에 둔다.
 *
 * 서버는 몇 초에 한 번만 좌표를 준다. 그 사이를 각 화면이 "걸어서" 메우는데, 두 화면이
 * 조금이라도 다르게 걸으면 같은 사람이 다른 자리에 서 있는 것처럼 보인다.
 * (pathfinder.ts 는 앱이 갈라져 있어 복사본을 두지만, 이 로직은 절대 복사하지 말 것.)
 *
 * ## 왜 고정 속도를 쓰면 안 되는가
 *
 * 예전에는 양쪽 다 `86 도면px/초`(= 사람 걷는 속도) 고정이었다. 그런데 **목표가 도망가는
 * 속도와 쫓아가는 속도가 같으면 따라잡을 여유가 0**이다. 어떤 이유로든 한 화면이 80px
 * 뒤처지면 — 패널을 연 시각이 다르거나, 탭이 백그라운드로 내려가 rAF 가 멈췄거나,
 * 프레임을 한 번 늦게 받거나 — 그 80px 은 사람이 멈출 때까지 **영원히 유지된다**.
 *
 * 그래서 속도를 고정하지 않고 **"다음 좌표가 올 때 정확히 도착하도록"** 매 구간 다시 정한다.
 * 뒤처진 화면은 저절로 빨리 걷고, 앞선 화면은 느리게 걷는다. 둘이 같은 시각에 같은 점에
 * 도착하므로 그게 곧 동기화다.
 */

/** 사람 보행 속도 (도면 px/초). 도면 1px ≈ 1.62cm → 1.4 m/s */
export const WALK_PX_PER_SEC = 86;

/** 이 거리(도면 px) 안이면 도착으로 본다 — RSSI 노이즈로 제자리 떨림 방지 (12px ≈ 19cm) */
export const ARRIVE_EPS_PX = 12;

/**
 * 따라잡기 상한 (보행 속도의 몇 배까지).
 *
 * 처음엔 2.5배(≈3.5m/s)로 뒀다가 낮췄다. 서버 추정치가 두 지점 사이에서 진동할 때
 * 아바타가 그 사이를 **전력질주로 왕복**해서 순간이동처럼 보였다(녹화로 확인).
 * 진동 자체는 서버 속도 제한(SERVER_CONFIG.maxSpeedPxPerSec)에서 막고, 여기서는
 * "조금 빠른 걸음" 정도만 허용해 화면이 과장되지 않게 한다.
 */
export const MAX_CATCHUP_MULT = 1.5;

/** 좌표 브로드캐스트 주기를 아직 관측하지 못했을 때의 가정치 (서버 posBroadcastMs) */
export const DEFAULT_UPDATE_INTERVAL_MS = 1500;

/**
 * 구간을 "다음 좌표가 올 때보다 조금 더 걸리게" 잡는 여유 배수.
 *
 * 정확히 제때 도착하도록 잡으면 아바타가 **매 구간 끝에서 잠깐 멈춘다** — 도착해 놓고
 * 다음 좌표를 기다리는 시간이 생기고, 네트워크가 조금만 늦어도 그 멈춤이 길어진다.
 * 결과가 "가다 서다" 다(실제로 그렇게 보였다).
 *
 * 1.2 로 잡으면 다음 좌표가 올 때 경로의 약 83%까지만 와 있어 **항상 움직이는 중**이다.
 * 대가는 진실 좌표보다 한 구간의 20%쯤 뒤처지는 것인데, 두 패널이 **같은 만큼** 뒤처지므로
 * 서로 어긋나지는 않는다 — 우리가 맞추려는 건 절대 위치가 아니라 두 화면의 일치다.
 */
export const INTERPOLATION_OVERSHOOT = 1.2;

export interface Point {
  x: number;
  y: number;
}

/** 현재 위치에서 waypoint 들을 차례로 지날 때의 총 이동 거리 (도면 px) */
export function pathLengthPx(from: Point, path: readonly Point[]): number {
  let total = 0;
  let cur = from;
  for (const p of path) {
    total += Math.hypot(p.x - cur.x, p.y - cur.y);
    cur = p;
  }
  return total;
}

/**
 * 이 구간을 다음 좌표가 도착할 때까지 다 걸으려면 초당 몇 px 이어야 하는가.
 *
 * 하한을 두지 않는 게 중요하다 — 사람이 거의 안 움직였으면 아바타도 느리게 기어가야
 * 자연스럽다. 하한을 보행 속도로 잡으면 "쏜살같이 갔다가 멈춰서 기다리기" 가 되어
 * 오히려 튀어 보이고, 두 화면의 도착 시각도 어긋난다.
 */
export function paceForPath(pathLenPx: number, intervalMs: number): number {
  const seconds = (Math.max(intervalMs, 200) * INTERPOLATION_OVERSHOOT) / 1000;
  return Math.min(pathLenPx / seconds, WALK_PX_PER_SEC * MAX_CATCHUP_MULT);
}

/**
 * 좌표 브로드캐스트 주기를 **관측으로** 알아낸다.
 *
 * 서버 설정값을 프론트에 상수로 박으면 서버에서 주기를 바꾼 순간 두 화면의 보간이
 * 전부 어긋난다. 두 패널은 같은 브로드캐스트를 받으므로 관측값도 같은 곳으로 수렴한다.
 */
export class UpdateClock {
  private lastAt = 0;
  private observed: number;

  constructor(defaultMs = DEFAULT_UPDATE_INTERVAL_MS) {
    this.observed = defaultMs;
  }

  /** 브로드캐스트가 도착할 때마다 한 번 (배치 안의 태그마다가 아니라 배치당 한 번) */
  tick(now = Date.now()): void {
    if (this.lastAt > 0) {
      const gap = now - this.lastAt;
      // 탭 복귀·일시적 끊김 같은 이상치는 주기 추정에서 뺀다
      if (gap > 200 && gap < 20_000) this.observed += (gap - this.observed) * 0.3;
    }
    this.lastAt = now;
  }

  get intervalMs(): number {
    return this.observed;
  }
}
