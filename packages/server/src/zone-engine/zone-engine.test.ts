import { describe, expect, it } from 'vitest';
import type { ScanEvent } from '@meditracker/shared';
import { ZoneEngine, type ZoneChangeEvent, type ZoneEngineConfig } from './zone-engine.js';

const CONFIG: ZoneEngineConfig = {
  RSSI_WINDOW_MS: 3000,
  HYSTERESIS_DB: 8,
  CONFIRM_COUNT: 3,
  ABSENT_TIMEOUT_MS: 15000,
  EVICT_AFTER_MS: 600000,
  TRANSIT_NEAR_DB: 6,
  TRANSIT_MIN_ZONES: 3,
  TRANSIT_CONFIRM: 3,
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

    // ⚠️ 판정은 게이트웨이별 **창 중앙값**으로 한다 — 한 건만 약하게 넣으면 중앙값이
    //    안 내려가서 전환이 안 된다. 실제로 멀어지는 상황처럼 연속으로 약하게 들어온다.
    for (let i = 0; i < 4; i++) {
      clock.tick(100);
      engine.ingest(scan('GW-WAIT', 'tag1', -70));
    }
    // consult_1 이 12dB 더 셈 — 후보 등록부터 확정까지 CONFIRM_COUNT(3)회 필요
    clock.tick(100);
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

  it('EVICT_AFTER_MS 초과 무신호 태그는 메모리에서 완전히 삭제', () => {
    const { engine, clock, scan } = setup();
    engine.ingest(scan('GW-WAIT', 'tag1', -60));

    clock.tick(CONFIG.EVICT_AFTER_MS + 1000);
    const evicted = engine.sweepAbsent();

    expect(evicted).toBe(1);
    expect(engine.getState('tag1')).toBeUndefined();
    expect(engine.getAllStates()).toHaveLength(0);
    expect(engine.readingsOf('tag1')).toHaveLength(0); // 수신값 Map 도 같이 비워야 누수가 안 남
  });

  it('자리비움 상태여도 EVICT_AFTER_MS 전이면 상태를 유지 (잠깐 끊긴 사람이 사라지면 안 됨)', () => {
    const { engine, clock, scan } = setup();
    engine.ingest(scan('GW-WAIT', 'tag1', -60));

    clock.tick(CONFIG.ABSENT_TIMEOUT_MS + 1000);
    expect(engine.sweepAbsent()).toBe(0); // 자리비움은 됐지만 삭제는 아직
    expect(engine.getState('tag1')?.currentZone).toBeNull();

    engine.ingest(scan('GW-CON1', 'tag1', -70)); // 돌아오면 이어서 추적
    expect(engine.getState('tag1')?.currentZone).toBe('consult_1');
  });

  it('삭제된 태그가 다시 나타나면 새 상태로 최초 진입 처리', () => {
    const { engine, clock, changes, scan } = setup();
    engine.ingest(scan('GW-WAIT', 'tag1', -60));
    clock.tick(CONFIG.EVICT_AFTER_MS + 1000);
    engine.sweepAbsent();

    changes.length = 0;
    engine.ingest(scan('GW-CON1', 'tag1', -60));

    expect(engine.getState('tag1')?.currentZone).toBe('consult_1');
    expect(changes.at(-1)).toMatchObject({ fromZone: null, toZone: 'consult_1' });
  });

  it('한 방 튄 RSSI 는 판정을 흔들지 못한다 (게이트웨이별 창 중앙값)', () => {
    const { engine, clock, changes, scan } = setup();
    // 대기실에 안정적으로 머무는 중
    for (let i = 0; i < 5; i++) {
      engine.ingest(scan('GW-WAIT', 'tag1', -60));
      clock.tick(200);
    }
    expect(engine.getState('tag1')?.currentZone).toBe('waiting_main');
    changes.length = 0;

    // 상담실 게이트웨이가 반사·간섭으로 세 번 크게 튄다 (멀티패스). 중앙값이면 안 넘어간다.
    for (let i = 0; i < 3; i++) {
      engine.ingest(scan('GW-CON1', 'tag1', -85)); // 실제 세기
      engine.ingest(scan('GW-CON1', 'tag1', -40)); // 튄 값
      engine.ingest(scan('GW-CON1', 'tag1', -84));
      engine.ingest(scan('GW-WAIT', 'tag1', -60));
      clock.tick(200);
    }

    expect(engine.getState('tag1')?.currentZone).toBe('waiting_main');
    expect(changes).toHaveLength(0);
  });

  it('창 중앙값이라도 신호가 실제로 계속 세지면 전환은 된다 (둔감해지기만 하면 안 됨)', () => {
    const { engine, clock, scan } = setup();
    engine.ingest(scan('GW-WAIT', 'tag1', -75));
    for (let i = 0; i < 8; i++) {
      engine.ingest(scan('GW-CON1', 'tag1', -55));
      engine.ingest(scan('GW-WAIT', 'tag1', -75));
      clock.tick(200);
    }
    expect(engine.getState('tag1')?.currentZone).toBe('consult_1');
  });

  it('여러 방이 동시에 세게 들리면 복도(방 사이)로 표시한다', () => {
    const { engine, clock, scan } = setup();
    // 대기실 안 — 한 존만 세게 들린다 (나머지는 6dB 밖)
    for (let i = 0; i < 5; i++) {
      engine.ingest(scan('GW-WAIT', 'tag1', -55));
      engine.ingest(scan('GW-CON1', 'tag1', -80));
      clock.tick(200);
    }
    expect(engine.getState('tag1')?.inTransit).toBeFalsy();

    // ⚠️ 판정은 창 중앙값이라 앞 구간 값이 남으면 안 된다 — 창을 비우고 간다
    clock.tick(CONFIG.RSSI_WINDOW_MS + 100);
    // 복도로 나옴 — 세 방이 모두 6dB 안에 들어온다
    for (let i = 0; i < 5; i++) {
      engine.ingest(scan('GW-WAIT', 'tag1', -70));
      engine.ingest(scan('GW-CON1', 'tag1', -72));
      engine.ingest(scan('GW-CON2', 'tag1', -74));
      clock.tick(200);
    }
    expect(engine.getState('tag1')?.inTransit).toBe(true);
    // 방 이름 자체는 최선의 추측을 유지한다 (지도에 점은 찍어야 하므로)
    expect(engine.getState('tag1')?.currentZone).toBe('waiting_main');
  });

  it('두 방만 비슷하면 복도가 아니다 — 방 안 벽 근처와 구분되지 않으면 오검출이 된다', () => {
    const { engine, clock, scan } = setup();
    for (let i = 0; i < 6; i++) {
      engine.ingest(scan('GW-WAIT', 'tag1', -70));
      engine.ingest(scan('GW-CON1', 'tag1', -72)); // 옆방 하나만 가깝다 = 문간
      engine.ingest(scan('GW-CON2', 'tag1', -88)); // 멀다
      clock.tick(200);
    }
    expect(engine.getState('tag1')?.inTransit).toBeFalsy();
  });

  it('방 안으로 들어가면 복도 표시가 풀린다', () => {
    const { engine, clock, scan } = setup();
    for (let i = 0; i < 5; i++) {
      engine.ingest(scan('GW-WAIT', 'tag1', -70));
      engine.ingest(scan('GW-CON1', 'tag1', -72));
      engine.ingest(scan('GW-CON2', 'tag1', -74));
      clock.tick(200);
    }
    expect(engine.getState('tag1')?.inTransit).toBe(true);

    clock.tick(CONFIG.RSSI_WINDOW_MS + 100);
    for (let i = 0; i < 6; i++) {
      engine.ingest(scan('GW-WAIT', 'tag1', -52));
      engine.ingest(scan('GW-CON1', 'tag1', -84));
      clock.tick(200);
    }
    expect(engine.getState('tag1')?.inTransit).toBe(false);
  });

  it('한 존만 들리면 복도로 보지 않는다 (비교 대상이 없는 것뿐)', () => {
    const { engine, clock, scan } = setup();
    for (let i = 0; i < 5; i++) {
      engine.ingest(scan('GW-WAIT', 'tag1', -88)); // 약해도 유일한 신호
      clock.tick(200);
    }
    expect(engine.getState('tag1')?.inTransit).toBeFalsy();
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
