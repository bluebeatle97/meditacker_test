import { timingSafeEqual } from 'node:crypto';

/**
 * 직원용 패널·관제 진입 핀 검사 + 무차별 대입 방어.
 *
 * **핀 값은 이 파일에 없다.** `STAFF_PIN` 환경변수 → `SERVER_CONFIG.staffPin` 한 곳에서만
 * 온다. 코드에 박으면 저장소를 읽을 수 있는 사람 전원이 아는 비밀이 되고, 배포처마다
 * 다른 값을 쓸 수도 없다.
 *
 * **왜 잠금이 필요한가.** 6자리 숫자는 100만 가지다. HTTPS 뒤에 있어도 초당 수백 번
 * 던지면 하루면 끝난다. 실패 지연 + 연속 실패 잠금이 있어야 '핀 한 겹' 이 의미를 갖는다.
 *
 * 시간을 주입받는 이유: 테스트가 실제로 60초를 기다릴 수는 없다.
 */
export type PinVerdict = 'ok' | 'bad' | 'locked';

/** 연속 실패 이 횟수면 잠근다 */
const MAX_FAILS = 5;
/** 잠금 지속 시간 */
const LOCK_MS = 60_000;
/** 실패 응답을 이만큼 늦춘다 — 스크립트로 빠르게 던지는 것을 막는 값싼 한 겹 */
export const FAIL_DELAY_MS = 400;
/** 기록이 이보다 많이 쌓이면 오래된 것을 버린다 (메모리 무한 증가 방지) */
const PRUNE_AT = 1000;

/**
 * 고정 시간 비교. 길이가 다르면 timingSafeEqual 이 던지므로 먼저 걸러낸다
 * (길이는 새지만 6자리 고정 핀에서는 의미 없는 정보다).
 */
function sameSecret(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

interface Attempts {
  /** 연속 실패 횟수 */
  n: number;
  /** 잠금 해제 시각 (0 = 잠긴 적 없음) */
  until: number;
  /** 마지막 시도 시각 — 청소 기준 */
  at: number;
}

export class PinGate {
  private fails = new Map<string, Attempts>();

  constructor(
    private pin: string,
    private now: () => number = Date.now,
    private maxFails = MAX_FAILS,
    private lockMs = LOCK_MS,
  ) {}

  /**
   * `key` 는 시도한 쪽을 구분하는 값(보통 클라이언트 IP).
   *
   * ⚠️ 잠금은 key 단위다. 프록시 뒤에서 전원이 한 key 로 묶이면 한 명이 틀려서 전 직원이
   *    잠기므로, 호출하는 쪽이 실제 클라이언트를 구분해 넘겨야 한다 (index.ts clientKey).
   */
  attempt(key: string, pin: string): PinVerdict {
    const t = this.now();
    this.prune(t);
    const rec = this.fails.get(key);
    if (rec && rec.until > t) return 'locked';
    if (sameSecret(this.pin, pin)) {
      this.fails.delete(key);
      return 'ok';
    }
    // 잠금이 한 번 풀렸으면 카운터도 처음부터. 풀린 직후 한 번 틀렸다고 또 잠그면
    // 손가락이 미끄러진 직원이 계속 못 들어온다.
    const n = (rec && rec.until > 0 ? 0 : rec?.n ?? 0) + 1;
    const locked = n >= this.maxFails;
    this.fails.set(key, { n, until: locked ? t + this.lockMs : 0, at: t });
    return locked ? 'locked' : 'bad';
  }

  /** 남은 잠금 시간(ms). 안 잠겨 있으면 0 */
  lockedForMs(key: string): number {
    const rec = this.fails.get(key);
    const left = rec ? rec.until - this.now() : 0;
    return left > 0 ? left : 0;
  }

  private prune(t: number): void {
    if (this.fails.size < PRUNE_AT) return;
    for (const [k, r] of this.fails) {
      if (r.until <= t && t - r.at > this.lockMs) this.fails.delete(k);
    }
  }
}
