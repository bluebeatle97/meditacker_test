import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Gateway, ScanEvent } from '@meditracker/shared';
import type { ZoneEngineConfig } from '../zone-engine/zone-engine.js';
import { headerGateways, scanToLine, type RecordingHeader } from './recording-file.js';

const here = dirname(fileURLToPath(import.meta.url));
export const RECORDINGS_DIR = resolve(here, '../../data/recordings');

/**
 * raw 스캔 녹화기 — 현장 튜닝의 핵심 도구.
 *
 * **왜 필요한가.** 지금 파라미터를 하나 바꾸려면: 수정 → 빌드 → 재시작 → 비콘 들고
 * 복도를 한 바퀴 → 관제 화면 보며 눈으로 확인. 한 사이클 10분이고, 조합은
 * `히스테리시스 4 × CONFIRM_COUNT 3 × 창 크기 3 = 36가지`. 6시간 동안 걷게 된다.
 * 게다가 매번 걷는 속도·경로가 달라서 **비교 자체가 신뢰할 수 없다**.
 *
 * 한 번 녹화해두면 같은 입력으로 36가지를 몇 초에 돌린다 (replay.ts). 그리고 그
 * 파일은 그대로 회귀 테스트가 된다 — 나중에 판정 로직을 고치고 "정확도 87%→94%" 를
 * 숫자로 보일 수 있다.
 */
export class ScanRecorder {
  private stream: WriteStream;
  private lines = 0;
  readonly path: string;

  constructor(name: string, gateways: Gateway[], config: ZoneEngineConfig) {
    mkdirSync(RECORDINGS_DIR, { recursive: true });
    this.path = join(RECORDINGS_DIR, `${safeName(name)}.ndjson`);
    this.stream = createWriteStream(this.path, { flags: 'a' });

    const header: RecordingHeader = {
      t: 'meta',
      startedAt: Date.now(),
      gateways: headerGateways(gateways),
      config,
    };
    this.write(header);
  }

  record(scan: ScanEvent): void {
    this.write(scanToLine(scan));
  }

  /** 관제 페이지에서 사람이 찍는 정답 (지금 어느 방에 있는지) */
  mark(zone: string | null, tag?: string): void {
    this.write({ t: 'mark', zone, ts: Date.now(), tag });
  }

  stats(): { path: string; lines: number } {
    return { path: this.path, lines: this.lines };
  }

  close(): void {
    this.stream.end();
  }

  private write(obj: unknown): void {
    this.stream.write(JSON.stringify(obj) + '\n');
    this.lines++;
  }
}

/**
 * 파일명 정리 + 값이 이름 구실을 못 하면 시각으로 대체.
 * `RECORD_SCANS=1` 처럼 대충 켜도 `rec-20260731-1830.ndjson` 으로 떨어지게.
 */
function safeName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+|-+$/g, '');
  if (cleaned.length >= 2) return cleaned;
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `rec-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}
