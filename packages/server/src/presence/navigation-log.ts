import type { NavigationLog, NavigationStatus } from '@meditracker/shared';
import {
  abortOpenNavLogs,
  closeNavLog,
  findOpenNavLog,
  findPersonByTag,
  listNavLogs,
  openNavLog,
  type Db,
} from '../db/index.js';

/**
 * 안내 이력의 상태 변화 하나.
 *
 * **이 store 는 사실만 알린다 — 무슨 문구를 보낼지는 정하지 않는다.** 알림톡 발송함이
 * 붙으면 그쪽이 정책을 갖는다(도착은 시술 관련 인원에게, 해제는 조용히, `aborted` 는
 * 알릴 사람이 없음). 여기서 문구를 정해 버리면 메신저 연동을 바꿀 때마다 이 파일을
 * 고치게 되고, 그러면 DB 이력과 발송 정책이 한 덩어리로 엉킨다.
 */
export interface NavEvent {
  /** `departed` = 새 안내 발행. 나머지는 종료 사유 그대로 */
  kind: 'departed' | Exclude<NavigationStatus, 'moving'>;
  log: NavigationLog;
}

/**
 * 방 안내 이력 (DB) — 발행·도착·해제를 여기서 확정한다.
 *
 * **살아 있는 화살표(GuidanceStore)와 역할이 갈린다.** 화살표는 지금 화면에 뜨는 상태라
 * 메모리가 맞고 재시작하면 사라져야 한다. 이 표는 그 반대편 — 알림톡이 외부로 나가는
 * 순간부터 "무슨 지시를 내렸고 어떻게 끝났나" 는 재시작을 넘어 남아야 한다.
 * 자세한 근거는 schema.sql 의 navigation_logs 주석에 있다.
 */
export class NavigationLogStore {
  private listeners: Array<(e: NavEvent) => void> = [];

  constructor(
    private db: Db,
    private now: () => number = () => Date.now(),
  ) {}

  /**
   * 안내 발행. 발행된 줄을 돌려준다.
   *
   * **같은 방을 다시 걸면 새 줄을 만들지 않는다** — GuidanceStore.set 이 같은 목적지에
   * `since` 를 새로 잡지 않는 것과 같은 규칙이다. 직원이 같은 버튼을 두 번 눌렀다고
   * 알림이 두 번 나가면 안 된다.
   *
   * 다른 방으로 바뀌면 먼저 열린 줄을 `superseded` 로 닫고 새 줄을 연다.
   */
  issue(tagId: string, toZone: string, fromZone: string | null): NavigationLog {
    const at = this.now();
    const open = findOpenNavLog(this.db, tagId);
    if (open?.toZone === toZone) return open;
    if (open) this.close(tagId, 'superseded', at);

    const person = findPersonByTag(this.db, tagId);
    const id = openNavLog(this.db, {
      tagId,
      personId: person?.personId ?? null,
      personName: person?.displayName ?? null,
      fromZone,
      toZone,
      issuedAt: at,
    });
    const log: NavigationLog = {
      id,
      tagId,
      personId: person?.personId ?? null,
      personName: person?.displayName ?? null,
      fromZone,
      toZone,
      issuedAt: at,
      arrivedAt: null,
      closedAt: null,
      status: 'moving',
      travelSec: null,
    };
    this.emit({ kind: 'departed', log });
    return log;
  }

  /** 목적지 방에 들어왔다 (판정은 서버 몫 — GuidanceStore.arrived 참고) */
  arrived(tagId: string): NavigationLog | undefined {
    return this.close(tagId, 'arrived', this.now());
  }

  /** 직원이 안내를 풀었다 */
  cancelled(tagId: string): NavigationLog | undefined {
    return this.close(tagId, 'cancelled', this.now());
  }

  /** 비콘 반납 등으로 끝을 볼 수 없게 됐다 */
  aborted(tagId: string): NavigationLog | undefined {
    return this.close(tagId, 'aborted', this.now());
  }

  /**
   * 서버가 뜰 때 한 번 — 재시작으로 화살표를 잃은 줄들을 끊는다.
   * 이벤트는 내지 않는다: 알릴 상대가 이미 없는 안내들이다.
   */
  reconcileOnBoot(): number {
    return abortOpenNavLogs(this.db, this.now());
  }

  open(tagId: string): NavigationLog | undefined {
    return findOpenNavLog(this.db, tagId);
  }

  list(opts: { limit?: number; personId?: string; tagId?: string } = {}): NavigationLog[] {
    return listNavLogs(this.db, opts);
  }

  onEvent(fn: (e: NavEvent) => void): void {
    this.listeners.push(fn);
  }

  private close(
    tagId: string,
    status: Exclude<NavigationStatus, 'moving'>,
    at: number,
  ): NavigationLog | undefined {
    const log = closeNavLog(this.db, tagId, status, at);
    // `superseded` 는 곧바로 새 줄이 열리므로 그 발행 이벤트가 대신 말해 준다
    if (log && status !== 'superseded') this.emit({ kind: status, log });
    return log;
  }

  private emit(e: NavEvent): void {
    for (const fn of this.listeners) fn(e);
  }
}
