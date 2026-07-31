import { EventEmitter } from 'node:events';
import type { PresenceState, ScanEvent } from '@meditracker/shared';

export interface ZoneEngineConfig {
  RSSI_WINDOW_MS: number;
  HYSTERESIS_DB: number;
  CONFIRM_COUNT: number;
  ABSENT_TIMEOUT_MS: number;
  /** 이 시간 무신호면 상태를 메모리에서 완전히 삭제 (자리비움보다 훨씬 길게) */
  EVICT_AFTER_MS: number;
}

export interface ZoneChangeEvent {
  tagId: string;
  fromZone: string | null;
  toZone: string | null; // null = 자리비움
  at: number;
  /** 이전 존 체류 시간(초). 최초 진입이면 null */
  durationSec: number | null;
}

interface GatewayReading {
  rssi: number;
  timestamp: number;
}

/**
 * 존 판정 엔진 (설계서 6.2)
 *
 * - nearest-anchor: 가장 센 신호의 게이트웨이가 속한 존으로 판정
 * - 히스테리시스(HYSTERESIS_DB) + 연속 확인(CONFIRM_COUNT)으로 채터링 억제
 * - ABSENT_TIMEOUT_MS 동안 무신호면 자리비움(null) 처리 — sweepAbsent() 주기 호출 필요
 *
 * emit: 'zoneChange' (ZoneChangeEvent) — commit 시에만 발생 (채터링 없음)
 */
export class ZoneEngine extends EventEmitter {
  /** tagId → gatewayId → 최신 수신값 */
  private readings = new Map<string, Map<string, GatewayReading>>();
  private states = new Map<string, PresenceState>();

  constructor(
    private gatewayZoneMap: Map<string, string>,
    private config: ZoneEngineConfig,
    /** 테스트 주입용 시계 */
    private now: () => number = Date.now,
  ) {
    super();
  }

  /**
   * 원시 스캔 이벤트 유입 (Ingestion 어댑터가 호출).
   *
   * `evaluateNow=false` 로 넣으면 수신값만 쌓고 존 판정은 하지 않는다 —
   * 호출부가 `evaluate(tagId)` 를 주기로 묶어 부르는 용도.
   * 게이트웨이 50대 × 태그 수십 개면 수신값이 초당 1,000건을 넘는데,
   * 그때마다 판정을 다시 돌리면 서버가 CPU 한 코어를 다 쓴다(실측).
   * 판정을 주기로 묶으면 CONFIRM_COUNT 도 설계 의도대로 '스캔 주기 N회' 가 된다.
   */
  ingest(scan: ScanEvent, evaluateNow = true): void {
    if (!this.gatewayZoneMap.has(scan.gatewayId)) return; // 미등록 게이트웨이 무시

    let perGateway = this.readings.get(scan.tagId);
    if (!perGateway) {
      perGateway = new Map();
      this.readings.set(scan.tagId, perGateway);
    }
    const prev = perGateway.get(scan.gatewayId);
    if (!prev || scan.timestamp >= prev.timestamp) {
      perGateway.set(scan.gatewayId, { rssi: scan.rssi, timestamp: scan.timestamp });
    }

    if (evaluateNow) this.updatePresence(scan.tagId);
  }

  /** 쌓인 수신값으로 존 판정 1회 (ingest(scan, false) 와 짝) */
  evaluate(tagId: string): void {
    this.updatePresence(tagId);
  }

  getState(tagId: string): PresenceState | undefined {
    return this.states.get(tagId);
  }

  getAllStates(): PresenceState[] {
    return [...this.states.values()];
  }

  /** RSSI_WINDOW 내 게이트웨이별 최신 수신값 (연속 위치 추정 등 외부 활용) */
  readingsOf(tagId: string): Array<{ gatewayId: string; rssi: number }> {
    return this.freshReadings(tagId, this.now());
  }

  /**
   * 주기 호출 — 무신호 태그를 자리비움(null) 처리하고, 더 오래 조용한 태그는 아예 버린다.
   *
   * 자리비움과 삭제는 다른 사건이다. 자리비움은 "지금 안 보임" 이라 상태를 계속 들고
   * 있어야 하지만(돌아오면 이어서 추적), 반납된 태그·건물을 떠난 태그를 영원히 들고
   * 있으면 Map 이 단조 증가해 판정 주기마다 그만큼 CPU 를 더 쓴다.
   *
   * @returns 이번 스윕에서 삭제한 태그 수 (운영 지표용)
   */
  sweepAbsent(): number {
    const now = this.now();
    let evicted = 0;
    for (const state of [...this.states.values()]) {
      const idleMs = now - state.lastSeen;
      if (state.currentZone !== null && idleMs >= this.config.ABSENT_TIMEOUT_MS) {
        this.commitZone(state.tagId, null);
      }
      if (idleMs >= this.config.EVICT_AFTER_MS) {
        // commitZone(null) 은 위에서 이미 났다 (EVICT ≫ ABSENT) — 여기선 흔적만 지운다
        this.states.delete(state.tagId);
        this.readings.delete(state.tagId);
        evicted++;
      }
    }
    return evicted;
  }

  // ── 내부 ──────────────────────────────────────────────────────────────

  private updatePresence(tagId: string): void {
    const now = this.now();
    const perGateway = this.freshReadings(tagId, now);

    const state = this.ensureState(tagId, now);
    if (perGateway.length === 0) return; // 유효 스캔 없음 → sweepAbsent 가 처리

    state.lastSeen = now;

    // 가장 센 게이트웨이 → 그 게이트웨이의 존
    const strongest = perGateway.reduce((a, b) => (b.rssi > a.rssi ? b : a));
    const bestZone = this.gatewayZoneMap.get(strongest.gatewayId)!;

    // 최초 진입(또는 자리비움 복귀)
    if (state.currentZone === null) {
      this.commitZone(tagId, bestZone);
      return;
    }

    // 같은 존이면 유지
    if (bestZone === state.currentZone) {
      this.clearCandidate(state);
      return;
    }

    // 다른 존 후보 → 히스테리시스 검사 (상대 비교)
    const currentRssi =
      perGateway
        .filter((g) => this.gatewayZoneMap.get(g.gatewayId) === state.currentZone)
        .reduce<number | null>((max, g) => (max === null || g.rssi > max ? g.rssi : max), null) ??
      -999;

    if (strongest.rssi - currentRssi < this.config.HYSTERESIS_DB) {
      this.clearCandidate(state);
      return;
    }

    // N회 연속 확인
    if (state.candidateZone === bestZone) {
      state.candidateCount = (state.candidateCount ?? 0) + 1;
      if (state.candidateCount >= this.config.CONFIRM_COUNT) {
        this.commitZone(tagId, bestZone);
      }
    } else {
      state.candidateZone = bestZone;
      state.candidateCount = 1;
    }
  }

  /** RSSI_WINDOW 내 스캔만, 게이트웨이별 최신값 */
  private freshReadings(tagId: string, now: number): Array<{ gatewayId: string; rssi: number }> {
    const perGateway = this.readings.get(tagId);
    if (!perGateway) return [];
    const result: Array<{ gatewayId: string; rssi: number }> = [];
    for (const [gatewayId, r] of perGateway) {
      if (now - r.timestamp <= this.config.RSSI_WINDOW_MS) {
        result.push({ gatewayId, rssi: r.rssi });
      } else {
        perGateway.delete(gatewayId); // 만료 정리
      }
    }
    return result;
  }

  private ensureState(tagId: string, now: number): PresenceState {
    let state = this.states.get(tagId);
    if (!state) {
      state = { tagId, currentZone: null, lastSeen: now, enteredAt: now };
      this.states.set(tagId, state);
    }
    return state;
  }

  private clearCandidate(state: PresenceState): void {
    state.candidateZone = undefined;
    state.candidateCount = undefined;
  }

  private commitZone(tagId: string, toZone: string | null): void {
    const now = this.now();
    const state = this.ensureState(tagId, now);
    const fromZone = state.currentZone;
    const durationSec = fromZone !== null ? Math.round((now - state.enteredAt) / 1000) : null;

    state.currentZone = toZone;
    state.enteredAt = now;
    this.clearCandidate(state);

    const event: ZoneChangeEvent = { tagId, fromZone, toZone, at: now, durationSec };
    this.emit('zoneChange', event);
  }
}
