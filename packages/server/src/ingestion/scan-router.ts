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
/** 미등록 게이트웨이 발견 목록의 상한과 수명 — 설치 중 화면에서 찾는 용도라 짧게 */
const MAX_UNKNOWN_GATEWAYS = 50;
const UNKNOWN_GATEWAY_TTL_MS = 120_000;

interface UnknownGateway {
  gatewayId: string;
  lastSeen: number;
  scans: number;
  beacons: Set<string>;
}

export class ScanRouter {
  private acceptedScans = 0;
  /**
   * `gateways.json` 에 없는데 신호를 쏘고 있는 게이트웨이 (현장 설치 발견용).
   *
   * **비콘 화이트리스트보다 먼저** 센다. 나중에 세면 등록된 비콘을 들은 스캔만 보게
   * 되는데, 현장에서는 비콘도 아직 미등록이라 그 조합이 성립하지 않아 새로 단 게이트웨이가
   * 영원히 발견되지 않는다.
   */
  private unknownGateways = new Map<string, UnknownGateway>();

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
    /** 이 게이트웨이가 `gateways.json` 에 등록돼 있나 (등록 즉시 반영되도록 함수로 받는다) */
    private isKnownGateway: (gatewayId: string) => boolean = () => true,
  ) {}

  route(scan: ScanEvent): void {
    // 게이트웨이 발견은 비콘 필터보다 먼저 — 현장에서는 비콘도 미등록이다
    if (!this.isKnownGateway(scan.gatewayId)) this.noteUnknownGateway(scan);

    if (this.whitelistEnabled && !this.knownTags.has(scan.tagId)) {
      this.unknownTags.note(scan); // 등록 화면에만 보이고, 판정·좌표·로그에는 안 들어간다
      return;
    }
    this.acceptedScans++;
    this.onAccepted(scan);
  }

  private noteUnknownGateway(scan: ScanEvent): void {
    const prev = this.unknownGateways.get(scan.gatewayId);
    // 새 항목은 상한까지만 — 잘못된 피드가 무한히 늘리지 못하게 (비콘 버퍼와 같은 방어)
    if (!prev && this.unknownGateways.size >= MAX_UNKNOWN_GATEWAYS) return;
    const beacons = prev?.beacons ?? new Set<string>();
    if (beacons.size < 200) beacons.add(scan.tagId);
    this.unknownGateways.set(scan.gatewayId, {
      gatewayId: scan.gatewayId,
      lastSeen: scan.timestamp,
      scans: (prev?.scans ?? 0) + 1,
      beacons,
    });
  }

  /** 등록 안 된 채 신호를 쏘고 있는 게이트웨이 (최근 순) — 관제 "미등록 게이트웨이" 패널용 */
  unknownGatewayList(
    now = Date.now(),
  ): Array<{ gatewayId: string; lastSeen: number; scans: number; beacons: number }> {
    for (const [id, g] of this.unknownGateways) {
      if (now - g.lastSeen > UNKNOWN_GATEWAY_TTL_MS) this.unknownGateways.delete(id);
    }
    return [...this.unknownGateways.values()]
      .sort((a, b) => b.lastSeen - a.lastSeen)
      .map((g) => ({
        gatewayId: g.gatewayId,
        lastSeen: g.lastSeen,
        scans: g.scans,
        beacons: g.beacons.size,
      }));
  }

  /** 등록 직후 호출 — 방금 등록한 게이트웨이를 미등록 목록에서 뺀다 */
  forgetGateway(gatewayId: string): void {
    this.unknownGateways.delete(gatewayId);
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
