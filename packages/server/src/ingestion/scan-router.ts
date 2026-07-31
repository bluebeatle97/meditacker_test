import type { ScanEvent } from '@meditracker/shared';
import type { KnownTagStore } from '../presence/known-tag-store.js';
import type { UnknownTagBuffer } from './unknown-tag-buffer.js';

/**
 * 모든 스캔이 지나가는 **단일 관문**.
 *
 * 어댑터가 정규화한 `ScanEvent` 를 받아 등록 태그만 아래로 흘려보내고, 미등록은
 * 등록 화면용 버퍼로 보낸 뒤 버린다. 전송 방식(MQTT / HTTP / 시리얼)이 뭐든
 * **여기 하나만 거치게** 해서, 새 전송 경로가 생겨도 필터를 우회할 수 없게 한다
 * (설계서에 HTTP 수신 전환 가능성이 열려 있다).
 *
 * ⚠️ 화이트리스트는 **정규화된 `ScanEvent.tagId` 기준**이라 게이트웨이 페이로드 포맷과
 *    무관하다. 실장비 포맷이 MAC 이든 iBeacon UUID+major+minor 든, 어댑터가 tagId
 *    문자열 하나만 정해주면 이 관문은 그대로 동작한다 (불변식 B-4 의 효용).
 */
export class ScanRouter {
  private acceptedScans = 0;

  constructor(
    private knownTags: KnownTagStore,
    private unknownTags: UnknownTagBuffer,
    /** 통과한 스캔의 처리 (엔진 주입·관제 피드·녹화) */
    private onAccepted: (scan: ScanEvent) => void,
    /**
     * 화이트리스트 적용 여부. **기본 on** —
     * "배포할 때 켜야지" 하는 설정은 반드시 잊어버린다. 끄려면 명시적으로 TAG_WHITELIST=0.
     */
    private whitelistEnabled: boolean,
  ) {}

  route(scan: ScanEvent): void {
    if (this.whitelistEnabled && !this.knownTags.has(scan.tagId)) {
      this.unknownTags.note(scan); // 등록 화면에만 보이고, 판정·좌표·로그에는 안 들어간다
      return;
    }
    this.acceptedScans++;
    this.onAccepted(scan);
  }

  stats(): {
    whitelistEnabled: boolean;
    knownTags: number;
    acceptedScans: number;
    uniqueUnknownIds: number;
    droppedScans: number;
  } {
    const u = this.unknownTags.stats();
    return {
      whitelistEnabled: this.whitelistEnabled,
      knownTags: this.knownTags.size(),
      acceptedScans: this.acceptedScans,
      uniqueUnknownIds: u.uniqueIds,
      droppedScans: u.droppedScans,
    };
  }
}
