import type { ScanEvent } from '@meditracker/shared';
import type { GatewayAdapter } from '../adapter.js';
import { AbGatewayV4Adapter, type AbGatewayV4Options } from './ab-gateway-v4.adapter.js';
import { GenericJsonAdapter } from './generic-json.adapter.js';

/**
 * 첫 바이트를 보고 실장비(MessagePack)와 목 게이트웨이(JSON)를 갈라 보낸다.
 *
 * 실장비 어댑터로 갈아타면서 목 게이트웨이를 JSON 그대로 둔 이유: 목은 로컬 개발과
 * 리플레이 채점의 입력원이고(`npm run mock:gw`), 시연 배포도 여기에 얹혀 있다.
 * 목까지 MessagePack 으로 바꾸면 손으로 페이로드를 만들어 보는 길이 사라진다.
 *
 * 판별은 추측이 아니다 — MessagePack map 헤더는 `0x80~0x8f`(fixmap)·`0xde`·`0xdf`,
 * JSON 은 항상 `[` 또는 `{` 로 시작하므로 겹치지 않는다.
 */

const JSON_ARRAY = 0x5b; // '['
const JSON_OBJECT = 0x7b; // '{'

export class AutoAdapter implements GatewayAdapter {
  private readonly abGateway: AbGatewayV4Adapter;
  private readonly json = new GenericJsonAdapter();

  constructor(options: AbGatewayV4Options = {}) {
    this.abGateway = new AbGatewayV4Adapter(options);
  }

  parse(topic: string, rawPayload: Buffer | string): ScanEvent[] {
    const buf = typeof rawPayload === 'string' ? Buffer.from(rawPayload) : rawPayload;
    if (buf.length === 0) return [];
    const head = buf[0];
    const adapter = head === JSON_ARRAY || head === JSON_OBJECT ? this.json : this.abGateway;
    return adapter.parse(topic, buf);
  }
}
