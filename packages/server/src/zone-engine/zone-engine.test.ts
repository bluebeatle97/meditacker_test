import { describe, expect, it } from 'vitest';
import type { ScanEvent } from '@meditracker/shared';
import { ZoneEngine, type ZoneChangeEvent, type ZoneEngineConfig } from './zone-engine.js';

const CONFIG: ZoneEngineConfig = {
  RSSI_WINDOW_MS: 3000,
  HYSTERESIS_DB: 8,
  CONFIRM_COUNT: 3,
  ABSENT_TIMEOUT_MS: 15000,
};

const GW_MAP = new Map([
  ['GW-WAIT', 'waiting_main'],
  ['GW-CON1', 'consult_1'],
  ['GW-CON2', 'consult_2'],
]);

/** 가짜 시계 + 엔진 + 이벤트 수집기 */
function setup() {
  let t = 1_000_000;
  const clock = { now: () => t, tick: (ms: number) => (t += ms) };
  const engine = new ZoneEngine(GW_MAP, CONFIG, clock.now);
  const changes: ZoneChangeEvent[] = [];
  engine.on('zoneChange', (e: ZoneChangeEvent) => changes.push(e));

  const scan = (gatewayId: string, tagId: string, rssi: number): ScanEvent => ({
    gatewayId,
    tagId,
    rssi,
    timestamp: clock.now(),
  });

  return { engine, clock, changes, scan };
}

describe('ZoneEngine', () => {
  it('최초 스캔 즉시 해당 존으로 진입 확정', () => {
    const { engine, changes, scan } = setup();
    engine.ingest(scan('GW-WAIT', 'tag1', -60));

    expect(engine.getState('tag1')?.currentZone).toBe('waiting_main');
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ tagId: 'tag1', fromZone: null, toZone: 'waiting_main' });
  });

  it('히스테리시스 미달이면 더 센 다른 존 신호가 와도 유지 (채터링 억제)', () => {
    const { engine, clock, changes, scan } = setup();
    engine.ingest(scan('GW-WAIT', 'tag1', -60));

    // consult_1 이 5dB 더 셈 — HYSTERESIS_DB(8) 미달 → 전환 안 함
    for (let i = 0; i < 10; i++) {
      clock.tick(500);
      engine.ingest(scan('GW-WAIT', 'tag1', -60));
      engine.ingest(scan('GW-CON1', 'tag1', -55));
    }

    expect(engine.getState('tag1')?.currentZone).toBe('waiting_main');
    expect(changes).toHaveLength(1); // 최초 진입 1회뿐
  });

  it('히스테리시스 초과 + CONFIRM_COUNT 연속 확인 후에만 존 전환', () => {
    const { engine, clock, changes, scan } = setup();
    engine.ingest(scan('GW-WAIT', 'tag1', -60));

    // consult_1 이 12dB 더 셈 — 후보 등록부터 확정까지 CONFIRM_COUNT(3)회 필요
    clock.tick(500);
    engine.ingest(scan('GW-WAIT', 'tag1', -70));
    engine.ingest(scan('GW-CON1', 'tag1', -58)); // count=1
    expect(engine.getState('tag1')?.currentZone).toBe('waiting_main');

    clock.tick(500);
    engine.ingest(scan('GW-CON1', 'tag1', -58)); // count=2
    expect(engine.getState('tag1')?.currentZone).toBe('waiting_main');

    clock.tick(500);
    engine.ingest(scan('GW-CON1', 'tag1', -58)); // count=3 → 확정
    expect(engine.getState('tag1')?.currentZone).toBe('consult_1');

    const transition = changes.at(-1)!;
    expect(transition.fromZone).toBe('waiting_main');
    expect(transition.toZone).toBe('consult_1');
    expect(transition.durationSec).toBeGreaterThanOrEqual(1);
  });

  it('후보존이 흔들리면 카운트 리셋 (A→B→A 깜빡임에 전환 안 됨)', () => {
    const { engine, clock, scan } = setup();
    engine.ingest(scan('GW-WAIT', 'tag1', -70));

    // RSSI_WINDOW 내 이전 수신값이 유지되므로, 후보가 흔들리려면 세기가 교차해야 함
    clock.tick(500);
    engine.ingest(scan('GW-CON1', 'tag1', -58)); // 최강 CON1 → 후보 consult_1, count=1
    clock.tick(500);
    engine.ingest(scan('GW-CON2', 'tag1', -54)); // 최강 CON2 → 후보 consult_2 로 교체, count=1
    clock.tick(500);
    engine.ingest(scan('GW-CON1', 'tag1', -50)); // 최강 CON1 → 다시 consult_1, count=1
    clock.tick(500);
    engine.ingest(scan('GW-CON1', 'tag1', -50)); // count=2 — CONFIRM_COUNT(3) 미달

    expect(engine.getState('tag1')?.currentZone).toBe('waiting_main');
  });

  it('현재 존과 같은 존이 최강이면 후보 리셋', () => {
    const { engine, clock, scan } = setup();
    engine.ingest(scan('GW-WAIT', 'tag1', -70));

    clock.tick(500);
    engine.ingest(scan('GW-CON1', 'tag1', -58)); // 후보 count=1
    clock.tick(500);
    engine.ingest(scan('GW-WAIT', 'tag1', -50)); // 원래 존이 다시 최강 → 후보 리셋
    clock.tick(500);
    engine.ingest(scan('GW-CON1', 'tag1', -58)); // 후보 다시 count=1부터
    clock.tick(500);
    engine.ingest(scan('GW-CON1', 'tag1', -58)); // count=2

    expect(engine.getState('tag1')?.currentZone).toBe('waiting_main');
  });

  it('RSSI_WINDOW 밖의 오래된 스캔은 판정에서 제외', () => {
    const { engine, clock, scan } = setup();
    engine.ingest(scan('GW-WAIT', 'tag1', -50)); // 진입

    // 대기실 신호가 끊기고 4초 경과 (window 3초 초과) → 대기실 스캔 무효
    clock.tick(4000);
    // consult_1 만 유효 — 현재 존 RSSI 는 -999 취급 → 히스테리시스 통과
    engine.ingest(scan('GW-CON1', 'tag1', -80)); // count=1
    clock.tick(200);
    engine.ingest(scan('GW-CON1', 'tag1', -80)); // count=2
    clock.tick(200);
    engine.ingest(scan('GW-CON1', 'tag1', -80)); // count=3 → 전환

    expect(engine.getState('tag1')?.currentZone).toBe('consult_1');
  });

  it('ABSENT_TIMEOUT 무신호 시 sweepAbsent 로 자리비움(null) 처리 + 체류시간 기록', () => {
    const { engine, clock, changes, scan } = setup();
    engine.ingest(scan('GW-WAIT', 'tag1', -60));

    clock.tick(16000); // ABSENT_TIMEOUT_MS(15s) 초과
    engine.sweepAbsent();

    expect(engine.getState('tag1')?.currentZone).toBeNull();
    const last = changes.at(-1)!;
    expect(last.toZone).toBeNull();
    expect(last.durationSec).toBe(16);
  });

  it('자리비움 후 신호 재수신 시 즉시 재진입', () => {
    const { engine, clock, scan } = setup();
    engine.ingest(scan('GW-WAIT', 'tag1', -60));
    clock.tick(16000);
    engine.sweepAbsent();
    expect(engine.getState('tag1')?.currentZone).toBeNull();

    engine.ingest(scan('GW-CON1', 'tag1', -70));
    expect(engine.getState('tag1')?.currentZone).toBe('consult_1');
  });

  it('미등록 게이트웨이 스캔은 무시', () => {
    const { engine, scan } = setup();
    engine.ingest(scan('GW-UNKNOWN', 'tag1', -40));
    expect(engine.getState('tag1')).toBeUndefined();
  });

  it('같은 존 게이트웨이 2대 중 어느 쪽이 최강이어도 전환으로 안 침', () => {
    const gwMap = new Map([
      ['GW-A1', 'waiting_main'],
      ['GW-A2', 'waiting_main'],
      ['GW-CON1', 'consult_1'],
    ]);
    let t = 0;
    const engine = new ZoneEngine(gwMap, CONFIG, () => t);
    const changes: ZoneChangeEvent[] = [];
    engine.on('zoneChange', (e: ZoneChangeEvent) => changes.push(e));

    engine.ingest({ gatewayId: 'GW-A1', tagId: 'tag1', rssi: -60, timestamp: t });
    for (let i = 0; i < 10; i++) {
      t += 500;
      // A1/A2 가 번갈아 최강 — 같은 존이므로 이벤트 없음
      engine.ingest({ gatewayId: 'GW-A1', tagId: 'tag1', rssi: i % 2 ? -55 : -65, timestamp: t });
      engine.ingest({ gatewayId: 'GW-A2', tagId: 'tag1', rssi: i % 2 ? -65 : -55, timestamp: t });
    }

    expect(changes).toHaveLength(1);
    expect(engine.getState('tag1')?.currentZone).toBe('waiting_main');
  });
});
