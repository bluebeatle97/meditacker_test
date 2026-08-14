/**
 * 태그별 수신 빈도 측정 — "이 비콘은 초당 몇 번 들리나".
 *
 * **왜 필요한가.** 평활 계수를 하나로 두면 잘 들리는 비콘까지 같이 느려진다. 실측에서
 * CP35 는 게이트웨이 하나당 1.6건/초인데 카드형(BP105N)은 0.4건/초였고, 가만히 둔 카드가
 * 1분에 28m 를 헤매는 동안 CP35 넷은 0.0m 였다. 떨리는 쪽만 세게 누르면 나머지는 빠르게
 * 따라올 수 있다.
 *
 * **왜 기종이나 그룹으로 안 나누나.** MAC 앞자리로 가르면 기종이 바뀔 때마다 코드를
 * 고쳐야 하고, 그룹(의사·환자)은 사람 분류라 하드웨어와 무관하다. 빈도는 원인 그 자체다 —
 * 표본이 적어서 흔들리는 것이므로, 표본 수를 그대로 기준으로 삼는 게 가장 곧다.
 *
 * 창을 굴리며 세지 않고 **구간마다 끊어서** 센다. 태그가 수백 개로 늘어도 메모리가
 * 태그 수에만 비례하고, 이 값은 평활 계수를 고르는 데만 쓰여서 그 정도 해상도면 된다.
 */
export class ScanRateMeter {
  private counting = new Map<string, number>();
  private rate = new Map<string, number>();
  private since = Date.now();

  constructor(private windowMs = 10_000) {}

  /** 관문을 통과한 스캔마다 부른다 */
  record(tagId: string): void {
    // 구간을 **먼저** 닫는다 — 이 스캔은 새 구간의 것이다. 닫기 전에 세면 구간을 닫는
    // 태그만 매번 한 건씩 더 얹혀서, 자주 오는 태그일수록 빈도가 부풀려진다.
    const elapsed = Date.now() - this.since;
    if (elapsed >= this.windowMs) {
      const sec = elapsed / 1000;
      this.rate = new Map();
      for (const [id, n] of this.counting) this.rate.set(id, n / sec);
      this.counting.clear();
      this.since = Date.now();
    }
    this.counting.set(tagId, (this.counting.get(tagId) ?? 0) + 1);
  }

  /**
   * 초당 수신 건수. 아직 한 구간도 안 지났으면 `null` —
   * **모르는 것을 "느리다" 로 취급하면 새 태그가 전부 굼뜨게 시작한다.**
   */
  rateOf(tagId: string): number | null {
    return this.rate.get(tagId) ?? null;
  }

  /** 목록에서 빠진 태그를 잊는다 (반납·이탈) */
  forget(tagId: string): void {
    this.counting.delete(tagId);
    this.rate.delete(tagId);
  }
}

/**
 * 이 태그에 쓸 EMA 계수. 느리게 들리는 태그만 더 세게 누른다.
 *
 * 빈도를 모르면(`null`) 기본값을 준다 — 굼뜨게 시작해서 "새 비콘은 원래 안 따라온다" 는
 * 인상을 남기느니, 한 구간 뒤에 조여지는 편이 낫다.
 */
export function smoothingFor(
  ratePerSec: number | null,
  opts: { normal: number; slow: number; slowBelow: number },
): number {
  if (ratePerSec === null) return opts.normal;
  return ratePerSec < opts.slowBelow ? opts.slow : opts.normal;
}
