import type { Server, Namespace } from 'socket.io';
import type { Gateway, ScanEvent, Zone } from '@meditracker/shared';
import type { ZoneEngine } from '../zone-engine/zone-engine.js';
import type { PositionEstimator } from '../presence/position-estimator.js';
import type { TagMetaStore } from '../presence/tag-meta-store.js';
import type { UnknownTagSighting } from '../ingestion/unknown-tag-buffer.js';

export interface MonitorZoneChange {
  tagId: string;
  fromZone: string | null;
  toZone: string | null;
  at: number;
}

/**
 * 모니터링 허브 (`/monitor` namespace) — 하드웨어 디버깅/현장 튜닝용 실시간 관제.
 *
 * ⚠️ 개발/운영자 전용. 태그 위치 전부를 노출하므로 환자 화면 불변식(B-1)과 무관한
 *    별도 관리 채널이다. 환자망에 노출되지 않도록 배포 시 인증/네트워크 분리 필요.
 *
 * 대용량 대비: raw 스캔은 300ms 배치로 묶어 전송, 상태 스냅샷은 1초 주기.
 */
/** 관제 헤더에 띄울 수집 통계 (화이트리스트가 얼마나 걸러내고 있는지) */
export interface IngestStats {
  whitelistEnabled: boolean;
  knownTags: number;
  acceptedScans: number;
  uniqueUnknownIds: number;
  droppedScans: number;
}

export class MonitorHub {
  private ns: Namespace;
  private scanBatch: ScanEvent[] = [];
  private recentScans: ScanEvent[] = []; // 늦게 접속한 클라이언트용 링버퍼
  private recentZoneChanges: MonitorZoneChange[] = [];
  private gwCounts = new Map<string, number>();
  private gwLastSeen = new Map<string, number>();
  private startedAt = Date.now();

  constructor(
    io: Server,
    private engine: ZoneEngine,
    private estimator: PositionEstimator,
    private gateways: Gateway[],
    private zones: Zone[],
    private tagMeta: TagMetaStore,
    /** 수집 관문 현황 — 화이트리스트 통계 + 미등록 신호 목록 + 녹화 상태 */
    private ingest: () => {
      stats: IngestStats;
      unknown: UnknownTagSighting[];
      recording: { path: string; lines: number } | null;
    },
    private now: () => number = Date.now,
  ) {
    this.ns = io.of('/monitor');

    this.ns.on('connection', (socket) => {
      socket.emit('init', {
        gateways: this.gateways,
        zones: this.zones,
        startedAt: this.startedAt,
        recentScans: this.recentScans,
        recentZoneChanges: this.recentZoneChanges,
        tagMeta: this.tagMeta.all(),
      });
    });

    setInterval(() => this.flushScans(), 300);
    setInterval(() => this.ns.emit('state', this.snapshot()), 1000);
  }

  /** ingestion 콜백에서 매 스캔마다 호출 */
  recordScan(scan: ScanEvent): void {
    this.scanBatch.push(scan);
    this.recentScans.push(scan);
    if (this.recentScans.length > 200) this.recentScans.shift();
    this.gwCounts.set(scan.gatewayId, (this.gwCounts.get(scan.gatewayId) ?? 0) + 1);
    this.gwLastSeen.set(scan.gatewayId, this.now());
  }

  /** presence.onChange 에서 호출 */
  recordZoneChange(c: MonitorZoneChange): void {
    this.recentZoneChanges.unshift(c);
    if (this.recentZoneChanges.length > 50) this.recentZoneChanges.pop();
    this.ns.emit('zone', c);
  }

  private flushScans(): void {
    if (this.scanBatch.length === 0) return;
    this.ns.emit('scans', this.scanBatch);
    this.scanBatch = [];
  }

  private snapshot() {
    const now = this.now();
    const tags = this.engine.getAllStates().map((st) => ({
      tagId: st.tagId,
      zone: st.currentZone,
      lastSeen: st.lastSeen,
      ageMs: now - st.lastSeen,
      // 게이트웨이별 최신 RSSI (존 판정의 원재료) — 센 순 정렬
      readings: this.engine.readingsOf(st.tagId).sort((a, b) => b.rssi - a.rssi),
    }));
    const gateways = this.gateways.map((g) => ({
      gatewayId: g.gatewayId,
      label: g.label,
      zoneId: g.zoneId,
      count: this.gwCounts.get(g.gatewayId) ?? 0,
      lastSeenMs: this.gwLastSeen.has(g.gatewayId) ? now - this.gwLastSeen.get(g.gatewayId)! : null,
    }));
    const ingest = this.ingest();
    return {
      at: now,
      tags,
      positions: this.estimator.estimateAll(),
      gateways,
      ingest: ingest.stats,
      unknown: ingest.unknown,
      recording: ingest.recording,
    };
  }
}
