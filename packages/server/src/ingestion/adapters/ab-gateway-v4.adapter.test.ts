import { describe, expect, it } from 'vitest';
import { AbGatewayV4Adapter } from './ab-gateway-v4.adapter.js';
import { AutoAdapter } from './auto.adapter.js';

/**
 * 실장비에서 받아낸 첫 페이로드 (2026-08-04, 강남 고트의원 6F, 펌웨어 1.5.22i).
 *
 * 원본은 `devices` 가 210개(게이트웨이의 유선 초당 상한)였고 스니퍼가 500자에서
 * 잘라 출력했다. 그래서 **배열 헤더만 `dc00d2`(210) → `94`(4)로 바꿨다** — 헤더
 * 6필드와 device 블록 4개는 수신 바이트 그대로다. 어댑터가 가정하는 구조가
 * 실물과 어긋나면 이 테스트가 깨진다.
 */
const HEADER =
  '86' + // fixmap 6
  'a176a7312e352e323269' + // v: "1.5.22i"
  'a36d6964ce0000002e' + // mid: 46
  'a474696d65cd0a03' + // time: 2563 (부팅 후 초 — 절대 시각 아님)
  'a26970ad3139322e3136382e312e323133' + // ip: "192.168.1.213"
  'a36d6163ac323835363246373942343230' + // mac: "28562F79B420"
  'a764657669636573'; // "devices"

const DEVICES = [
  'c41d0364f0ad17dbcaa9142b00a8015164119300cadb17adf0640307000000',
  'c42703099040545908af1eff0600010920222369a51c50e321de74557fc781fa6ad41b50f47e8c7e42',
  'c42303422b1d48ffe0a902011a17ff4c000908130dc0a82d0b1b58160800ff02b46e033975',
  'c4270315bff1cfc95cc51eff06000109202228f9163c10569655e3817c9be48623b0da1fceb1391ff7',
];

const REAL_PAYLOAD = Buffer.from(HEADER + '94' + DEVICES.join(''), 'hex');

describe('AbGatewayV4Adapter — 실장비 페이로드', () => {
  it('게이트웨이 MAC 을 본문에서 뽑아 콜론 표기로 정규화한다', () => {
    const events = new AbGatewayV4Adapter().parse('meditracker/scan', REAL_PAYLOAD);
    // 토픽에 게이트웨이 정보가 없어도 구분된다 — 50대가 한 토픽을 공유하는 근거
    expect(events.every((e) => e.gatewayId === '28:56:2F:79:B4:20')).toBe(true);
  });

  it('device 블록마다 MAC 과 RSSI 를 뽑는다 (RSSI = 원바이트 - 256)', () => {
    const events = new AbGatewayV4Adapter().parse('meditracker/scan', REAL_PAYLOAD);
    expect(events.map((e) => [e.tagId, e.rssi])).toEqual([
      ['64:F0:AD:17:DB:CA', -87],
      ['09:90:40:54:59:08', -81], // 광고 데이터상 Microsoft — 지나가는 윈도우 기기
      ['42:2B:1D:48:FF:E0', -87], // Apple — 아이폰
      ['15:BF:F1:CF:C9:5C', -59],
    ]);
  });

  it('timestamp 는 수신 시각이다 (본문 time 은 부팅 후 경과라 못 쓴다)', () => {
    const before = Date.now();
    const events = new AbGatewayV4Adapter().parse('meditracker/scan', REAL_PAYLOAD);
    expect(events[0].timestamp).toBeGreaterThanOrEqual(before);
  });

  it('reverseMac 을 켜면 MAC 바이트 순서를 뒤집는다', () => {
    const events = new AbGatewayV4Adapter({ reverseMac: true }).parse('x', REAL_PAYLOAD);
    expect(events[0].tagId).toBe('CA:DB:17:AD:F0:64');
  });

  it('잘린 프레임·빈 본문을 던지지 않고 버린다', () => {
    const adapter = new AbGatewayV4Adapter();
    // 스니퍼가 500자에서 자른 실제 상황: 배열 길이는 210인데 블록은 4개뿐
    const truncated = Buffer.from(HEADER + 'dc00d2' + DEVICES.join(''), 'hex');
    expect(adapter.parse('x', truncated)).toEqual([]);
    expect(adapter.parse('x', Buffer.alloc(0))).toEqual([]);
    expect(adapter.parse('x', Buffer.from('not msgpack'))).toEqual([]);
  });
});

describe('AutoAdapter — 실장비와 목 게이트웨이 동시 수용', () => {
  it('MessagePack 은 실장비 어댑터로 보낸다', () => {
    const events = new AutoAdapter().parse('meditracker/scan', REAL_PAYLOAD);
    expect(events).toHaveLength(4);
    expect(events[0].gatewayId).toBe('28:56:2F:79:B4:20');
  });

  it('JSON 은 목 게이트웨이 어댑터로 보낸다 (토픽에서 gatewayId)', () => {
    const mock = JSON.stringify([{ mac: 'aa:bb:cc:00:00:01', rssi: -63, ts: 1710000000000 }]);
    const events = new AutoAdapter().parse('gw/GW-01/scan', mock);
    expect(events).toEqual([
      { gatewayId: 'GW-01', tagId: 'AA:BB:CC:00:00:01', rssi: -63, timestamp: 1710000000000 },
    ]);
  });
});
