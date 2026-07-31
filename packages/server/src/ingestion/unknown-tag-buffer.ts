import type { ScanEvent } from '@meditracker/shared';

/** 등록 화면에 뜨는 미등록 신호 한 줄 */
export interface UnknownTagSighting {
  tagId: string;
  rssi: number; // 최근 수신 세기 — 비콘을 게이트웨이 코앞에 대면 이 값으로 맨 위에 올라온다
  gatewayId: string;
  count: number; // 관측 횟수 (스쳐 지나간 폰 vs 계속 잡히는 비콘 구분)
  firstSeen: number;
  lastSeen: number;
}

/** 동시에 들고 있을 미등록 ID 최대 개수 */
const MAX_ENTRIES = 200;
/** 이 시간 동안 안 잡히면 목록에서 버린다 */
const TTL_MS = 60_000;

/**
 * 미등록 ID 임시 보관함 — **등록 화면에만** 쓰인다.
 *
 * 화이트리스트가 미등록 태그를 ingest 에서 버리면 등록 화면이 볼 데이터도 같이
 * 사라진다. 그래서 버리되 여기에 잠깐 담아둔다. 담기는 값은 존 판정·좌표 추정·
 * presence 로그 어디에도 안 들어간다.
 *
 * ⚠️ 개수(MAX_ENTRIES)와 수명(TTL_MS)을 둘 다 제한하는 게 핵심이다. 이게 없으면
 *    "미등록 태그 무한 누적" 이라는 원래 문제를 이름만 바꿔서 그대로 갖고 있는 셈이 된다.
 */
export class UnknownTagBuffer {
  private seen = new Map<string, UnknownTagSighting>();
  /** 화이트리스트에서 걸러낸 누적 스캔 수 (관제 헤더 표시용) */
  private droppedScans = 0;

  note(scan: ScanEvent): void {
    this.droppedScans++;

    const existing = this.seen.get(scan.tagId);
    if (existing) {
      existing.rssi = scan.rssi;
      existing.gatewayId = scan.gatewayId;
      existing.count++;
      existing.lastSeen = scan.timestamp;
      return;
    }

    this.prune(scan.timestamp);
    // 가득 찼으면 **가장 오래 안 보인 것**을 밀어낸다. 신규를 거절하면
    // 등록하려고 코앞에 갖다 댄 비콘이 노이즈에 밀려 영영 안 뜰 수 있다.
    if (this.seen.size >= MAX_ENTRIES) this.evictOldest();

    this.seen.set(scan.tagId, {
      tagId: scan.tagId,
      rssi: scan.rssi,
      gatewayId: scan.gatewayId,
      count: 1,
      firstSeen: scan.timestamp,
      lastSeen: scan.timestamp,
    });
  }

  /** 등록 화면용 — 센 신호 순 (코앞에 댄 비콘이 맨 위) */
  list(now = Date.now()): UnknownTagSighting[] {
    this.prune(now);
    return [...this.seen.values()].sort((a, b) => b.rssi - a.rssi);
  }

  /** 등록되면 목록에서 즉시 뺀다 */
  forget(tagId: string): void {
    this.seen.delete(tagId);
  }

  stats(): { uniqueIds: number; droppedScans: number } {
    return { uniqueIds: this.seen.size, droppedScans: this.droppedScans };
  }

  private prune(now: number): void {
    for (const [tagId, s] of this.seen) {
      if (now - s.lastSeen > TTL_MS) this.seen.delete(tagId);
    }
  }

  private evictOldest(): void {
    let oldestId: string | null = null;
    let oldestAt = Infinity;
    for (const [tagId, s] of this.seen) {
      if (s.lastSeen < oldestAt) {
        oldestAt = s.lastSeen;
        oldestId = tagId;
      }
    }
    if (oldestId) this.seen.delete(oldestId);
  }
}
