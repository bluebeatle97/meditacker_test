/**
 * 녹화 재생 + 파라미터 채점 (현장 튜닝의 본체)
 *
 *   npm run replay -w @meditracker/server -- <파일>
 *   npm run replay -w @meditracker/server -- walk-1 --grid
 *   npm run replay -w @meditracker/server -- walk-1 --hys 4,6,8 --confirm 2,3 --window 2000,3000
 *
 * **왜 이게 필요한가.** 파라미터 하나 바꾸려면 지금은 수정 → 빌드 → 재시작 → 비콘 들고
 * 복도 한 바퀴 → 눈으로 확인이다. 한 사이클 10분, 조합은 수십 가지. 게다가 매번 걷는
 * 속도·경로가 달라 **비교 자체가 신뢰할 수 없다**. 한 번 녹화해두면 완전히 같은 입력으로
 * 수십 가지를 몇 초에 돌린다.
 *
 * 재생은 서버와 **같은 방식**으로 돈다 — 수신값을 쌓고 zoneEvalIntervalMs 주기로 묶어
 * 평가하고, absentSweep 도 같은 주기로 돈다. 안 그러면 여기서 좋게 나온 값이 실제
 * 서버에서 다르게 동작한다.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadZones, SERVER_CONFIG, ZONE_ENGINE_CONFIG } from '../config/index.js';
import { ZoneEngine, type ZoneEngineConfig } from '../zone-engine/zone-engine.js';
import { RECORDINGS_DIR } from '../recording/scan-recorder.js';
import { lineToScan, parseRecording } from '../recording/recording-file.js';

// ── 인자 ────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
if (argv.length === 0 || argv[0].startsWith('--')) {
  console.error(
    '사용법: npm run replay -w @meditracker/server -- <녹화파일> [--grid] [--tag <id>]\n' +
      '        [--hys 4,6,8] [--confirm 2,3,4] [--window 2000,3000,5000] [--interval 200]',
  );
  process.exit(1);
}

function flag(name: string): string | null {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
}
function numList(name: string, fallback: number[]): number[] {
  const raw = flag(name);
  return raw ? raw.split(',').map(Number).filter(Number.isFinite) : fallback;
}

/** 파일명만 줘도 data/recordings/ 에서 찾아준다 (.ndjson 생략 가능) */
function resolveRecording(arg: string): string {
  for (const p of [arg, `${arg}.ndjson`, join(RECORDINGS_DIR, arg), join(RECORDINGS_DIR, `${arg}.ndjson`)]) {
    if (existsSync(p)) return p;
  }
  console.error(`녹화 파일을 못 찾음: ${arg}\n  찾아본 곳: ${RECORDINGS_DIR}`);
  process.exit(1);
}

const filePath = resolveRecording(argv[0]);
const gridMode = argv.includes('--grid');
const evalIntervalMs = Number(flag('interval') ?? SERVER_CONFIG.zoneEvalIntervalMs);

// ── 녹화 로드 ───────────────────────────────────────────────────────────────

const { header, scans, marks, skipped } = parseRecording(readFileSync(filePath, 'utf-8'));
if (scans.length === 0) {
  console.error('스캔이 하나도 없는 파일입니다.');
  process.exit(1);
}
if (!header) {
  console.error('헤더(t:meta)가 없는 파일입니다 — 게이트웨이→존 매핑을 알 수 없습니다.');
  process.exit(1);
}

/**
 * 게이트웨이→존 매핑은 **현재 config 가 아니라 파일 안의 것**을 쓴다.
 * 녹화 이후 게이트웨이를 옮기거나 존을 재배치해도 옛 녹화가 그대로 재생돼야 한다.
 */
const gwMap = new Map(header.gateways.map((g) => [g.gatewayId, g.zoneId]));
/** 표시용 한글 존 이름은 현재 zones.json 에서 (판정에는 안 쓰이므로 최신 걸 써도 안전) */
const zoneLabel = new Map(loadZones().map((z) => [z.zoneId, z.name]));

const spanSec = (scans[scans.length - 1].ts - scans[0].ts) / 1000;
const tagIds = [...new Set(scans.map((s) => s.tag))];

/** 채점 대상 태그 — 마크가 가리키는 태그 우선, 없으면 스캔이 가장 많은 태그 */
function pickTag(): string {
  const explicit = flag('tag');
  if (explicit) return explicit;
  const marked = [...new Set(marks.map((m) => m.tag).filter(Boolean))] as string[];
  if (marked.length === 1) return marked[0];
  const counts = new Map<string, number>();
  for (const s of scans) counts.set(s.tag, (counts.get(s.tag) ?? 0) + 1);
  const best = [...counts].sort((a, b) => b[1] - a[1])[0][0];
  if (tagIds.length > 1) console.log(`ℹ 태그 ${tagIds.length}개 중 스캔이 가장 많은 ${best} 로 채점 (--tag 로 지정 가능)`);
  return best;
}
const targetTag = pickTag();
const targetMarks = marks.filter((m) => !m.tag || m.tag === targetTag);

console.log(`\n녹화: ${filePath}`);
console.log(
  `  스캔 ${scans.length.toLocaleString()}건 · 태그 ${tagIds.length}개 · 길이 ${fmtDur(spanSec)}` +
    ` · 마크 ${targetMarks.length}개` +
    (skipped > 0 ? ` · 손상된 줄 ${skipped}개 건너뜀` : ''),
);
console.log(`  채점 대상: ${targetTag} · 판정 주기 ${evalIntervalMs}ms\n`);

// ── 재생 ────────────────────────────────────────────────────────────────────

interface Transition {
  at: number;
  zone: string | null;
}

/**
 * 녹화를 한 번 재생하고 대상 태그의 존 전환 시퀀스를 돌려준다.
 * 주입 시계를 쓰기 때문에 실시간이 아니라 **수백 배속**으로 돈다.
 */
function replay(config: ZoneEngineConfig): Transition[] {
  let now = scans[0].ts;
  const engine = new ZoneEngine(gwMap, config, () => now);
  const transitions: Transition[] = [];
  engine.on('zoneChange', (e: { tagId: string; toZone: string | null; at: number }) => {
    if (e.tagId === targetTag) transitions.push({ at: e.at, zone: e.toZone });
  });

  const end = scans[scans.length - 1].ts;
  const dirty = new Set<string>();
  let cursor = 0;
  let nextSweep = now + SERVER_CONFIG.absentSweepIntervalMs;

  // 서버와 같은 루프: 들어온 만큼 쌓고 → 주기마다 묶어서 평가 → 주기마다 자리비움 스윕
  for (; now <= end + config.ABSENT_TIMEOUT_MS; now += evalIntervalMs) {
    while (cursor < scans.length && scans[cursor].ts <= now) {
      engine.ingest(lineToScan(scans[cursor]), false);
      dirty.add(scans[cursor].tag);
      cursor++;
    }
    for (const t of dirty) engine.evaluate(t);
    dirty.clear();
    if (now >= nextSweep) {
      engine.sweepAbsent();
      nextSweep = now + SERVER_CONFIG.absentSweepIntervalMs;
    }
  }
  return transitions;
}

// ── 채점 ────────────────────────────────────────────────────────────────────

interface Score {
  /** 마크 구간 중 판정이 정답과 일치한 시간 비율 */
  accuracy: number;
  /** 방을 바꾼 뒤 판정이 따라오기까지 걸린 시간 (초, 중앙값) */
  medianLatencySec: number;
  /** 정답에 없는 존으로 튄 전환 횟수 */
  falseTransitions: number;
  /** 끝내 못 따라온 정답 전환 */
  missed: number;
  /** 전체 전환 횟수 (마크 없이도 볼 수 있는 안정성 지표) */
  totalTransitions: number;
}

/** 어떤 시각의 판정 존 */
function zoneAt(transitions: Transition[], t: number): string | null {
  let zone: string | null = null;
  for (const tr of transitions) {
    if (tr.at > t) break;
    zone = tr.zone;
  }
  return zone;
}

/** 어떤 시각의 정답 존 (마크가 만드는 계단 함수) */
function truthAt(t: number): string | null | undefined {
  if (targetMarks.length === 0) return undefined;
  if (t < targetMarks[0].ts) return undefined; // 첫 마크 이전은 정답을 모른다
  let zone: string | null = null;
  for (const m of targetMarks) {
    if (m.ts > t) break;
    zone = m.zone;
  }
  return zone;
}

const SAMPLE_MS = 500;
/**
 * 마크 앞뒤로 이만큼은 '맞춘 것' 으로 본다.
 *
 * 두 가지 오차가 겹치기 때문이다. (1) 정답 마크는 사람이 걸으면서 손으로 찍는다 —
 * 문턱을 넘는 순간과 버튼을 누르는 순간이 몇 초 어긋난다. (2) 신호는 문을 통과하기
 * **전부터** 옆방 쪽으로 기울기 시작한다. 그래서 판정이 마크보다 먼저 바뀌는 게 정상이고,
 * 이걸 '못 따라옴' 으로 세면 멀쩡한 설정이 전부 낙제한다 (실제로 그렇게 나왔다).
 *
 * 지연은 **부호 있는 값**으로 낸다 — 음수면 마크보다 먼저 바뀐 것.
 */
const MATCH_TOLERANCE_MS = 5000;

/** i번째 마크에 대응하는 판정 전환 (없으면 null = 놓침) */
function matchFor(transitions: Transition[], i: number, endTs: number): Transition | null {
  const m = targetMarks[i];
  // 앞쪽 관용은 이전 마크를 넘지 않게 — 넘으면 한 전환이 두 마크에 중복 매칭된다
  const from = Math.max(m.ts - MATCH_TOLERANCE_MS, targetMarks[i - 1]?.ts ?? -Infinity);
  const to = targetMarks[i + 1]?.ts ?? endTs;
  return transitions.find((tr) => tr.at >= from && tr.at <= to && tr.zone === m.zone) ?? null;
}

function score(transitions: Transition[]): Score {
  const totalTransitions = transitions.length;
  if (targetMarks.length === 0) {
    return { accuracy: NaN, medianLatencySec: NaN, falseTransitions: NaN, missed: NaN, totalTransitions };
  }

  // 시간 가중 정확도 — 0.5초 간격으로 정답과 판정을 비교
  const from = targetMarks[0].ts;
  const to = targetMarks[targetMarks.length - 1].ts + 30_000; // 마지막 방에 30초 머문 것으로 본다
  let hit = 0;
  let total = 0;
  for (let t = from; t <= to; t += SAMPLE_MS) {
    const truth = truthAt(t);
    if (truth === undefined) continue;
    total++;
    if (zoneAt(transitions, t) === truth) hit++;
  }

  // 전환 지연 — 정답 전환 대비 판정이 그 존으로 바뀐 시각차 (음수 = 먼저 바뀜)
  const latencies: number[] = [];
  let missed = 0;
  for (const [i, m] of targetMarks.entries()) {
    const caught = matchFor(transitions, i, to);
    if (caught) latencies.push((caught.at - m.ts) / 1000);
    else missed++;
  }

  // 오탐 — 정답에 없는 존으로 튄 전환.
  // "곧 그 방이 될 예정" 인 선행 전환은 오탐이 아니다 (위 관용 범위와 같은 이유).
  let falseTransitions = 0;
  for (const tr of transitions) {
    const truth = truthAt(tr.at);
    if (truth === undefined) continue;
    const soon = truthAt(tr.at + MATCH_TOLERANCE_MS);
    if (tr.zone !== truth && tr.zone !== soon) falseTransitions++;
  }

  return {
    accuracy: total > 0 ? hit / total : NaN,
    medianLatencySec: median(latencies),
    falseTransitions,
    missed,
    totalTransitions,
  };
}

// ── 실행 ────────────────────────────────────────────────────────────────────

if (!gridMode) {
  const config = { ...ZONE_ENGINE_CONFIG };
  const transitions = replay(config);
  printConfig('현재 파라미터', config);
  printScore(score(transitions));
  printTimeline(transitions);
} else {
  const hysList = numList('hys', [4, 5, 6, 8, 10]);
  const confirmList = numList('confirm', [2, 3, 4]);
  const windowList = numList('window', [2000, 3000, 5000]);

  const rows: Array<{ config: ZoneEngineConfig; score: Score }> = [];
  for (const HYSTERESIS_DB of hysList) {
    for (const CONFIRM_COUNT of confirmList) {
      for (const RSSI_WINDOW_MS of windowList) {
        const config: ZoneEngineConfig = {
          ...ZONE_ENGINE_CONFIG,
          HYSTERESIS_DB,
          CONFIRM_COUNT,
          RSSI_WINDOW_MS,
        };
        rows.push({ config, score: score(replay(config)) });
      }
    }
  }

  const scored = targetMarks.length > 0;
  rows.sort((a, b) =>
    scored
      ? b.score.accuracy - a.score.accuracy || a.score.medianLatencySec - b.score.medianLatencySec
      : a.score.totalTransitions - b.score.totalTransitions,
  );

  console.log(`격자 탐색 ${rows.length}조합\n`);
  const head = scored
    ? ['히스테리시스', 'CONFIRM', '창(ms)', '정확도', '지연(s)', '오탐', '놓침', '전환']
    : ['히스테리시스', 'CONFIRM', '창(ms)', '전환'];
  console.log(head.map((h, i) => h.padStart(i === 0 ? 12 : 8)).join(' '));
  for (const r of rows.slice(0, 20)) {
    const cells = scored
      ? [
          String(r.config.HYSTERESIS_DB),
          String(r.config.CONFIRM_COUNT),
          String(r.config.RSSI_WINDOW_MS),
          pct(r.score.accuracy),
          fmtLatency(r.score.medianLatencySec),
          String(r.score.falseTransitions),
          String(r.score.missed),
          String(r.score.totalTransitions),
        ]
      : [
          String(r.config.HYSTERESIS_DB),
          String(r.config.CONFIRM_COUNT),
          String(r.config.RSSI_WINDOW_MS),
          String(r.score.totalTransitions),
        ];
    console.log(cells.map((c, i) => c.padStart(i === 0 ? 12 : 8)).join(' '));
  }

  const best = rows[0];
  console.log(
    `\n최적: 히스테리시스 ${best.config.HYSTERESIS_DB}dB · CONFIRM ${best.config.CONFIRM_COUNT} · 창 ${best.config.RSSI_WINDOW_MS}ms`,
  );
  if (!scored) {
    console.log(
      '\n⚠️ 정답 마크가 없어 **전환 횟수(안정성)로만** 정렬했습니다.\n' +
        '   전환이 적을수록 좋은 게 아닙니다 — 아예 전환하지 않는 설정이 1등으로 올라옵니다.\n' +
        '   관제 페이지에서 걸으면서 "지금 이 방" 마크를 찍은 녹화라야 정확도 채점이 됩니다.',
    );
  }
}

// ── 출력 유틸 ───────────────────────────────────────────────────────────────

function printConfig(title: string, c: ZoneEngineConfig): void {
  console.log(
    `${title}: 히스테리시스 ${c.HYSTERESIS_DB}dB · CONFIRM ${c.CONFIRM_COUNT} · 창 ${c.RSSI_WINDOW_MS}ms · 자리비움 ${c.ABSENT_TIMEOUT_MS / 1000}s`,
  );
}

function printScore(s: Score): void {
  if (Number.isNaN(s.accuracy)) {
    console.log(`  전환 ${s.totalTransitions}회 (정답 마크가 없어 정확도 채점 불가)\n`);
    return;
  }
  console.log(
    `  정확도 ${pct(s.accuracy)} · 전환지연 중앙값 ${fmtLatency(s.medianLatencySec)} · ` +
      `오탐 ${s.falseTransitions} · 놓침 ${s.missed} · 전환 ${s.totalTransitions}회\n`,
  );
}

/** 정답과 판정을 나란히 — 어디서 틀렸는지 눈으로 보려고 */
function printTimeline(transitions: Transition[]): void {
  if (targetMarks.length === 0) {
    console.log('전환 시퀀스:');
    for (const t of transitions.slice(0, 40)) {
      console.log(`  ${clock(t.at)}  → ${t.zone ?? '(자리비움)'}`);
    }
    if (transitions.length > 40) console.log(`  … 외 ${transitions.length - 40}건`);
    return;
  }
  console.log('정답 → 판정 (지연, 음수 = 마크보다 먼저 바뀜):');
  const endTs = targetMarks[targetMarks.length - 1].ts + 30_000;
  for (const [i, m] of targetMarks.entries()) {
    const caught = matchFor(transitions, i, endTs);
    const label = zoneLabel.get(m.zone ?? '') ?? m.zone ?? '(이탈)';
    const delta = caught ? (caught.at - m.ts) / 1000 : 0;
    console.log(
      `  ${clock(m.ts)}  ${label.padEnd(16)} ` +
        (caught ? `✓ ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}s` : '✗ 못 따라옴'),
    );
  }
}

function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
function pct(x: number): string {
  return Number.isNaN(x) ? '-' : (x * 100).toFixed(1) + '%';
}
/** 전부 놓쳐서 표본이 없으면 '-' (0.0s 로 보이면 잘 맞춘 걸로 오해한다) */
function fmtLatency(x: number): string {
  return Number.isNaN(x) ? '-' : `${x >= 0 ? '+' : ''}${x.toFixed(1)}s`;
}
function clock(ts: number): string {
  return new Date(ts).toTimeString().slice(0, 8);
}
function fmtDur(sec: number): string {
  const m = Math.floor(sec / 60);
  return m > 0 ? `${m}분 ${Math.round(sec % 60)}초` : `${Math.round(sec)}초`;
}
