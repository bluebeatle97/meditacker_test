/**
 * 구역 표시 안정화 (프론트 표시용).
 *
 * 존 판정 자체는 이미 히스테리시스·연속확인으로 안정화되어 있지만, 복도를 지나가며
 * 스치는 방까지 **글자로** 즉시 반영하면 이름이 계속 바뀌어 읽을 수가 없다.
 * 그래서 같은 구역이 `dwellMs` 이상 유지될 때만 표시값을 바꾼다.
 *
 * ⚠️ 관제 페이지(/monitor)에는 쓰지 않는다 — 거기서는 원본 그대로 튀는 걸 봐야
 *    현장 튜닝(채터링 확인)이 된다. 안정화는 직원·환자 화면에만 적용한다.
 *
 * 타이머를 쓰지 않고 시각만 비교하므로, 주기적으로 다시 그리는 화면에서
 * `update()` 를 다시 불러 주면 그때 확정된다.
 */
export class ZoneDwellFilter {
  /** key(태그·사람) → 지금 표시 중인 구역 */
  private shown = new Map<string, string | null>();
  /** key → 바뀔 후보 구역과 그 구역이 관측되기 시작한 시각 */
  private pending = new Map<string, { zone: string | null; since: number }>();

  constructor(
    private dwellMs: number,
    private now: () => number = () => Date.now(),
  ) {}

  /**
   * 새 관측을 넣고 **표시해야 할 구역**을 돌려준다.
   * 첫 관측은 기다리지 않고 바로 표시한다 (처음부터 비워 두면 안내가 안 뜬다).
   */
  update(key: string, zone: string | null): string | null {
    if (!this.shown.has(key)) {
      this.shown.set(key, zone);
      return zone;
    }
    const shown = this.shown.get(key) ?? null;
    if (zone === shown) {
      this.pending.delete(key); // 되돌아왔으면 후보 취소
      return shown;
    }
    const p = this.pending.get(key);
    if (!p || p.zone !== zone) {
      this.pending.set(key, { zone, since: this.now() });
      return shown;
    }
    if (this.now() - p.since >= this.dwellMs) {
      this.shown.set(key, zone);
      this.pending.delete(key);
      return zone;
    }
    return shown;
  }

  /** 관측 없이 현재 표시값만 (주기 갱신에서 재평가할 때) */
  peek(key: string): string | null | undefined {
    return this.shown.get(key);
  }

  forget(key: string): void {
    this.shown.delete(key);
    this.pending.delete(key);
  }
}

/** 이 시간 이상 머물러야 표시를 바꾼다 — 지나가며 스치는 방은 표시하지 않는다 */
export const ZONE_DWELL_MS = 4500;
