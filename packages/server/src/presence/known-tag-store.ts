import { getRegisteredTagIds, type Db } from '../db/index.js';

/**
 * 등록 태그 화이트리스트 — `tags` 테이블(active=1)의 인메모리 캐시.
 *
 * **왜 필요한가.** 게이트웨이는 주변 BLE 광고를 가리지 않고 올린다. 우리 비콘뿐 아니라
 * 환자·보호자 스마트폰, 이어버드, 스마트워치, 옆 층 사람까지 전부 섞여 들어온다.
 * 게다가 iOS·Android 는 프라이버시 때문에 BLE MAC 을 15분마다 바꾼다 — 폰 한 대가
 * 하루에 서로 다른 식별자를 100개 가까이 만든다. 거르지 않으면
 *
 *   1. ZoneEngine 의 states/readings Map 이 며칠 만에 수천 개로 불어나 서버가 죽고
 *   2. 직원 화면이 회색 '미지정' 유령 아바타로 덮여 정작 우리 비콘이 안 보이고
 *   3. **동의하지 않은 사람의 단말 식별자와 이동경로를 수집**하게 된다 (법적 리스크).
 *
 * 조회가 스캔마다(초당 수백~수천 회) 일어나므로 DB 를 때리지 않고 Set 으로 들고 있는다.
 * 태그 등록/반납 시 `reload()` 로 갱신한다.
 *
 * ⚠️ 게이트웨이 자체 MAC 필터가 있어도 이 화이트리스트는 필요하다. 게이트웨이 필터는
 *    30대 각각의 설정이라 한 대가 교체·초기화되면 그 한 대만 조용히 구멍이 되는데,
 *    서버 필터는 한 군데고 항상 켜져 있다. (게이트웨이 필터 = 대역폭 절약,
 *    서버 필터 = 보안 경계. 역할이 다르므로 둘 다 켠다.)
 */
export class KnownTagStore {
  private ids: Set<string>;

  constructor(private db: Db) {
    this.ids = new Set(getRegisteredTagIds(db));
  }

  /** 태그 지급·반납·등록 후 호출 */
  reload(): void {
    this.ids = new Set(getRegisteredTagIds(this.db));
  }

  has(tagId: string): boolean {
    return this.ids.has(tagId);
  }

  size(): number {
    return this.ids.size;
  }
}
