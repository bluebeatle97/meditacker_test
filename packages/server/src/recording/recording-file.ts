import type { Gateway, ScanEvent } from '@meditracker/shared';
import type { ZoneEngineConfig } from '../zone-engine/zone-engine.js';

/**
 * 녹화 파일 포맷 (NDJSON — 한 줄에 객체 하나).
 *
 * 왜 NDJSON 인가: 30분 걸으면 게이트웨이 30대 × 초당 2회 = 10만 줄이 넘는다.
 * 통짜 JSON 배열이면 쓰는 도중 프로세스가 죽었을 때 파일 전체가 깨지지만,
 * NDJSON 은 마지막 줄만 버리면 나머지가 그대로 살아 있다. 현장에서 노트북 배터리가
 * 나가도 그때까지 걸은 데이터는 건진다.
 *
 * 키를 짧게 쓴 이유도 같다 — 10만 줄에서 `gatewayId` vs `gw` 는 파일 크기가 배로 갈린다.
 */

/** 첫 줄 — 재생할 때 필요한 모든 컨텍스트를 파일 안에 박아둔다 */
export interface RecordingHeader {
  t: 'meta';
  startedAt: number;
  /**
   * 녹화 시점의 게이트웨이→존 매핑. **현재 config 를 참조하지 않고 파일에 복사**한다 —
   * 나중에 게이트웨이를 옮기거나 존을 재배치해도 옛 녹화가 그대로 재생돼야 한다.
   */
  gateways: Array<{ gatewayId: string; zoneId: string; label?: string }>;
  /** 녹화 당시 파라미터 (비교 기준점) */
  config: ZoneEngineConfig;
  note?: string;
}

/** raw 스캔 한 건 */
export interface RecordingScan {
  t: 's';
  gw: string;
  tag: string;
  r: number; // rssi
  ts: number;
}

/**
 * 정답 마크 — 걸으면서 "지금 이 방에 들어왔다" 를 사람이 찍어준다.
 * 이게 없으면 재생은 되지만 **채점을 못 한다**. 판정이 바뀐 건 보이는데
 * 그게 좋아진 건지 나빠진 건지 알 수가 없다.
 */
export interface RecordingMark {
  t: 'mark';
  zone: string | null; // null = 추적구역 이탈
  ts: number;
  tag?: string; // 여러 태그를 동시에 녹화할 때 어느 태그의 정답인지
}

export type RecordingLine = RecordingHeader | RecordingScan | RecordingMark;

export function scanToLine(scan: ScanEvent): RecordingScan {
  return { t: 's', gw: scan.gatewayId, tag: scan.tagId, r: scan.rssi, ts: scan.timestamp };
}

export function lineToScan(line: RecordingScan): ScanEvent {
  return { gatewayId: line.gw, tagId: line.tag, rssi: line.r, timestamp: line.ts };
}

export function headerGateways(gateways: Gateway[]): RecordingHeader['gateways'] {
  return gateways.map((g) => ({ gatewayId: g.gatewayId, zoneId: g.zoneId, label: g.label }));
}

/** 파싱 — 깨진 줄(녹화 중 강제종료)은 조용히 건너뛴다 */
export function parseRecording(text: string): {
  header: RecordingHeader | null;
  scans: RecordingScan[];
  marks: RecordingMark[];
  skipped: number;
} {
  let header: RecordingHeader | null = null;
  const scans: RecordingScan[] = [];
  const marks: RecordingMark[] = [];
  let skipped = 0;

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let parsed: RecordingLine;
    try {
      parsed = JSON.parse(line) as RecordingLine;
    } catch {
      skipped++; // 마지막 줄이 잘렸을 때 — 나머지는 멀쩡하므로 계속 간다
      continue;
    }
    if (parsed.t === 'meta') header = parsed;
    else if (parsed.t === 's') scans.push(parsed);
    else if (parsed.t === 'mark') marks.push(parsed);
    else skipped++;
  }

  scans.sort((a, b) => a.ts - b.ts);
  marks.sort((a, b) => a.ts - b.ts);
  return { header, scans, marks, skipped };
}
