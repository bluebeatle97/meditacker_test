import { getAssignedTagIds, type Db } from '../db/index.js';

/**
 * 지금 누군가에게 배정된 비콘 집합 — 화면에 나갈 대상의 단일 판단 기준.
 *
 * 화이트리스트(`KnownTagStore`)와 다르다:
 *   화이트리스트 — "우리 하드웨어인가". 창고에 있어도 참
 *   여기        — "지금 누가 들고 있나". 창고에 있으면 거짓
 *
 * 조회가 **스캔마다** 일어난다(초당 수백~수천 회). DB 를 때리면 안 되므로 Set 으로 들고
 * 있고, 배정·반납 때 `reload()` 한다. 앱 밖에서 DB 가 바뀌는 경우(수동 SQL, dev-seed)를
 * 대비해 호출부가 주기 재적재도 건다 — 화이트리스트와 같은 이유다.
 */
export class AssignedTagStore {
  private ids: Set<string>;

  constructor(private db: Db) {
    this.ids = new Set(getAssignedTagIds(db));
  }

  reload(): void {
    this.ids = new Set(getAssignedTagIds(this.db));
  }

  has(tagId: string): boolean {
    return this.ids.has(tagId);
  }

  size(): number {
    return this.ids.size;
  }
}
