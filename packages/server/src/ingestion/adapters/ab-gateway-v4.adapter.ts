import { decode } from '@msgpack/msgpack';
import type { ScanEvent } from '@meditracker/shared';
import type { GatewayAdapter, GatewayHealthSample } from '../adapter.js';

/**
 * April Brother **AB BLE Gateway V4** (설계서 2.1 의 "gateway4") 실장비 어댑터.
 *
 * 실측 페이로드 (2026-08-04, 펌웨어 1.5.22i):
 *
 *   토픽: 설정에서 정한 임의 문자열 (예 `meditracker/scan`)
 *   본문: **MessagePack 바이너리** — JSON 아님
 *     { v: "1.5.22i", mid: 46, time: 2563, ip: "192.168.1.213",
 *       mac: "28562F79B420", devices: [<bin>, <bin>, ...] }
 *
 * `devices` 각 원소는 광고 1건의 raw 바이트다:
 *
 *   [0]     광고 타입 코드 (0~4)
 *   [1..6]  비콘 MAC 6바이트
 *   [7]     RSSI — **부호 없는 1바이트**. 실제 dBm = 값 - 256
 *   [8..]   raw 광고 데이터 (iBeacon UUID·제조사 데이터 등)
 *
 * 설계 결정 두 가지:
 *
 * 1. **gatewayId 는 토픽이 아니라 본문 `mac` 에서 뽑는다.** 게이트웨이 50대가 전부
 *    같은 토픽으로 쏴도 구분된다 → 50대에 설정 한 벌을 그대로 복사할 수 있다.
 *    (`GenericJsonAdapter` 는 토픽에서 뽑으므로 게이트웨이마다 토픽이 달라야 했다.)
 * 2. **timestamp 는 수신 시각을 쓴다.** 본문 `time` 은 절대 시각이 아니라 게이트웨이
 *    부팅 후 경과 시간이라(실측 2563 = 약 43분) 태그 간 비교에 쓸 수 없다.
 */

const MAC_BYTES = 6;
/** [타입 1] + [MAC 6] + [RSSI 1]. 이보다 짧은 블록은 광고 데이터가 아니다 */
const DEVICE_HEADER_LEN = 1 + MAC_BYTES + 1;

/** BLE RSSI 로 성립하는 범위. 벗어나면 파싱이 어긋난 것이므로 버린다 */
const RSSI_MIN = -127;
const RSSI_MAX = 0;

function formatMac(bytes: Uint8Array, reverse: boolean): string {
  const octets: string[] = [];
  for (let i = 0; i < MAC_BYTES; i++) {
    octets.push(bytes[reverse ? MAC_BYTES - 1 - i : i].toString(16).padStart(2, '0'));
  }
  return octets.join(':').toUpperCase();
}

/**
 * 게이트웨이는 자기 MAC 을 구분자 없이 보낸다 (`28562F79B420`). 설정 툴 화면과
 * `gateways.json` 은 콜론 표기(`28:56:2F:79:B4:20`)라 그쪽에 맞춘다 — 사람이 두 값을
 * 눈으로 대조하는 자리라 표기가 갈리면 매핑을 틀린다.
 */
function normalizeGatewayMac(raw: string): string | null {
  const hex = raw.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  if (hex.length !== MAC_BYTES * 2) return null;
  return (hex.match(/.{2}/g) as string[]).join(':');
}

export interface AbGatewayV4Options {
  /**
   * 비콘 MAC 바이트 순서를 뒤집는다.
   *
   * 벤더 문서는 "[1..6] = MAC" 이라고만 적어 두었고, 실측 샘플이 전부 랜덤 주소
   * (폰·워치)라 순서를 단정할 수 없었다. **MAC 이 스티커에 적힌 실물 비콘(CP35·
   * BP105N)을 게이트웨이 앞에 대 보고**, 관제 화면의 값이 스티커와 뒤집혀 보이면
   * `AB_MAC_REVERSE=1` 로 켠다.
   */
  reverseMac?: boolean;
}

export class AbGatewayV4Adapter implements GatewayAdapter {
  private readonly reverseMac: boolean;

  constructor(options: AbGatewayV4Options = {}) {
    this.reverseMac = options.reverseMac ?? false;
  }

  /**
   * 페이로드에 실려 오는 `mid`(일련번호)·`time`(부팅 후 경과 초)를 꺼낸다.
   *
   * **비콘을 하나도 못 들어도 이 값은 온다.** 그래서 "근처에 사람이 없어 조용한 것"과
   * "게이트웨이가 죽은 것"을 가르는 근거가 된다 — 스캔만 세면 둘이 구분되지 않는다.
   * 실측으로 초 단위임을 확인했다 (45초 관찰에 +44).
   */
  parseHealth(_topic: string, rawPayload: Buffer | string): GatewayHealthSample | null {
    let root: unknown;
    try {
      root = decode(typeof rawPayload === 'string' ? Buffer.from(rawPayload) : rawPayload);
    } catch {
      return null;
    }
    if (typeof root !== 'object' || root === null) return null;
    const { mac, devices, mid, time } = root as Record<string, unknown>;
    if (typeof mac !== 'string') return null;
    const gatewayId = normalizeGatewayMac(mac);
    if (!gatewayId) return null;
    return {
      gatewayId,
      uptimeSec: typeof time === 'number' ? time : null,
      mid: typeof mid === 'number' ? mid : null,
      devices: Array.isArray(devices) ? devices.length : 0,
      at: Date.now(),
    };
  }

  parse(_topic: string, rawPayload: Buffer | string): ScanEvent[] {
    let root: unknown;
    try {
      root = decode(typeof rawPayload === 'string' ? Buffer.from(rawPayload) : rawPayload);
    } catch {
      return []; // 잘린 프레임·다른 벤더 페이로드 — 조용히 버린다
    }
    if (typeof root !== 'object' || root === null) return [];

    const { mac, devices } = root as Record<string, unknown>;
    if (typeof mac !== 'string' || !Array.isArray(devices)) return [];
    const gatewayId = normalizeGatewayMac(mac);
    if (!gatewayId) return [];

    const timestamp = Date.now();
    const events: ScanEvent[] = [];
    for (const raw of devices) {
      // msgpack bin 타입은 Uint8Array 로 디코딩된다
      if (!(raw instanceof Uint8Array) || raw.length < DEVICE_HEADER_LEN) continue;
      const rssi = raw[MAC_BYTES + 1] - 256;
      if (rssi < RSSI_MIN || rssi > RSSI_MAX) continue;
      events.push({
        gatewayId,
        tagId: formatMac(raw.subarray(1, 1 + MAC_BYTES), this.reverseMac),
        rssi,
        timestamp,
      });
    }
    return events;
  }
}
