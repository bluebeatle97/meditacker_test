import type { Guidance } from '@meditracker/shared';

/**
 * 진행 중인 방 안내 — "이 비콘을 든 사람을 이 방으로".
 *
 * **왜 DB 가 아닌가.** 안내는 몇 분짜리 지시다. 배정(assignments)처럼 남겨야 할
 * 기록이 아니라 지금 화면에 떠 있는 상태에 가깝다 — `idle-beacon-store` 와 같은 자리.
 * 서버를 재시작하면 안내가 사라진다. 그때는 직원이 다시 걸면 된다
 * (반대로 DB 에 두면 재시작 후 옛날 화살표가 되살아나는 쪽이 더 곤란하다).
 */
export class GuidanceStore {
  private byTag = new Map<string, Guidance>();
  private listeners: Array<(all: Guidance[]) => void> = [];

  /** 안내 시작 · 목적지 변경. 같은 방을 다시 걸면 시각을 새로 잡지 않는다 */
  set(tagId: string, zoneId: string, now: number): Guidance {
    const prev = this.byTag.get(tagId);
    const g: Guidance = { tagId, zoneId, since: prev?.zoneId === zoneId ? prev.since : now };
    this.byTag.set(tagId, g);
    this.notify();
    return g;
  }

  /** 안내 해제 — 직원이 끄거나 도착했을 때. 없던 것을 끄면 아무 일도 안 한다 */
  clear(tagId: string): boolean {
    if (!this.byTag.delete(tagId)) return false;
    this.notify();
    return true;
  }

  get(tagId: string): Guidance | undefined {
    return this.byTag.get(tagId);
  }

  all(): Guidance[] {
    return [...this.byTag.values()];
  }

  /**
   * 목적지에 도착한 안내를 골라낸다 (해제는 부르는 쪽이 한다).
   *
   * 도착 판정을 서버가 하는 이유: 존 판정이 서버 것이라 환자 화면 말을 믿을 이유가 없다.
   * 복도에서는 존이 비므로(inTransit) 자연히 걸리지 않는다 — 방에 실제로 들어와야 끝난다.
   */
  arrived(at: Array<{ tagId: string; zone: string | null }>): Guidance[] {
    return this.all().filter((g) => at.some((p) => p.tagId === g.tagId && p.zone === g.zoneId));
  }

  onChange(fn: (all: Guidance[]) => void): void {
    this.listeners.push(fn);
  }

  private notify(): void {
    const all = this.all();
    for (const fn of this.listeners) fn(all);
  }
}
