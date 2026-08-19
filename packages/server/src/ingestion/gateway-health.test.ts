import { beforeEach, describe, expect, it } from 'vitest';
import { GatewayHealthMonitor } from './gateway-health.js';

/**
 * 이 감시기의 존재 이유는 **아무도 안 볼 때 죽은 것을 나중에 알 수 있게** 하는 것이다.
 * 그래서 검사도 "기록이 남는가" 를 본다.
 */
describe('게이트웨이 생사 기록', () => {
  let clock: number;
  let logs: string[];
  let m: GatewayHealthMonitor;
  const GW = '28:56:2F:79:B4:20';

  const beat = (opts: { uptimeSec?: number | null; mid?: number | null; devices?: number } = {}) =>
    m.note({
      gatewayId: GW,
      uptimeSec: opts.uptimeSec ?? 100,
      mid: opts.mid ?? null,
      devices: opts.devices ?? 5,
      at: clock,
    });

  beforeEach(() => {
    clock = 1_000_000;
    logs = [];
    m = new GatewayHealthMonitor(
      () => [GW, 'AA:AA:AA:AA:AA:AA'],
      () => clock,
      (msg) => logs.push(msg),
    );
  });

  const kinds = (): string[] => m.snapshot().events.map((e) => e.kind);

  it('15초 넘게 상태 메시지가 없으면 끊김으로 기록한다', () => {
    beat();
    clock += 14_000;
    m.sweep();
    expect(kinds(), '14초는 아직 아니다').toEqual([]);

    clock += 2_000; // 16초
    m.sweep();
    expect(kinds()).toEqual(['died']);
    expect(logs.some((l) => l.includes('끊김'))).toBe(true);
    expect(m.snapshot().gateways.find((g) => g.gatewayId === GW)?.alive).toBe(false);
  });

  it('같은 끊김을 sweep 마다 다시 세지 않는다', () => {
    // 5초마다 도는 함수라, 한 번 죽은 걸 매번 세면 이력이 순식간에 쓰레기가 된다
    beat();
    clock += 20_000;
    m.sweep();
    clock += 20_000;
    m.sweep();
    clock += 20_000;
    m.sweep();
    expect(kinds()).toEqual(['died']);
    expect(m.snapshot().gateways.find((g) => g.gatewayId === GW)?.outages).toBe(1);
  });

  it('돌아오면 끊겨 있던 시간과 함께 복구를 남긴다', () => {
    beat();
    clock += 40_000;
    m.sweep();
    clock += 5_000;
    beat(); // 45초 만에 복귀
    const ev = m.snapshot().events;
    expect(ev.map((e) => e.kind)).toEqual(['back', 'died']); // 최신순
    expect(ev[0].value, '끊겨 있던 시간(초)').toBe(45);
    expect(logs.some((l) => l.includes('복구'))).toBe(true);
  });

  it('가동시간이 되감기면 재부팅으로 기록한다', () => {
    // 부팅 후 경과 초라서 되감김 = 그 사이에 껐다 켜진 것
    beat({ uptimeSec: 1500 });
    clock += 1_000;
    beat({ uptimeSec: 12 });
    const ev = m.snapshot().events;
    expect(ev[0].kind).toBe('reboot');
    expect(ev[0].value, '직전 가동시간(초)').toBe(1500);
    expect(m.snapshot().gateways.find((g) => g.gatewayId === GW)?.reboots).toBe(1);
  });

  it('끊김 없이 재부팅해도 잡힌다', () => {
    // 전원이 잠깐 흔들려 바로 복구되면 무신호 감시에는 안 걸린다 — 가동시간만이 근거다
    beat({ uptimeSec: 900 });
    clock += 2_000;
    beat({ uptimeSec: 3 });
    expect(kinds()).toEqual(['reboot']);
    expect(kinds()).not.toContain('died');
  });

  it('일련번호를 건너뛰면 유실로 센다', () => {
    beat({ mid: 10 });
    clock += 1_000;
    beat({ mid: 14 }); // 11,12,13 이 사라졌다
    const ev = m.snapshot().events;
    expect(ev[0].kind).toBe('loss');
    expect(ev[0].value).toBe(3);
    expect(m.snapshot().gateways.find((g) => g.gatewayId === GW)?.lostMsgs).toBe(3);
  });

  it('비콘을 0개 들은 메시지도 살아 있는 것으로 친다', () => {
    // 근처에 사람이 없을 뿐이다. 스캔 수로 판정하면 이걸 죽음으로 오해한다
    beat({ devices: 0 });
    clock += 10_000;
    beat({ devices: 0 });
    m.sweep();
    expect(kinds()).toEqual([]);
    expect(m.snapshot().gateways.find((g) => g.gatewayId === GW)?.alive).toBe(true);
  });

  it('등록만 되고 한 번도 안 온 게이트웨이도 목록에 낸다', () => {
    beat();
    const never = m.snapshot().gateways.find((g) => g.gatewayId === 'AA:AA:AA:AA:AA:AA');
    expect(never?.neverSeen).toBe(true);
    expect(never?.alive).toBe(false);
    expect(never?.silentSec).toBeNull();
  });
});
