import type { ScanEvent } from '@meditracker/shared';
import type { GatewayAdapter } from '../adapter.js';

/**
 * 임시 표준 어댑터 — gateway4 실포맷 확정 전 가정 (설계서 6.1):
 *
 *   토픽: gw/<gatewayId>/scan
 *   페이로드: [{ "mac": "AA:BB:...", "rssi": -63, "ts": 1710000000000 }, ...]
 *
 * ts 누락 시 수신 시각으로 대체. 실장비 포맷이 다르면 이 파일만 교체.
 */
export class GenericJsonAdapter implements GatewayAdapter {
  parse(topic: string, rawPayload: Buffer | string): ScanEvent[] {
    const gatewayId = topic.split('/')[1];
    if (!gatewayId) return [];

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawPayload.toString());
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];

    const now = Date.now();
    const events: ScanEvent[] = [];
    for (const item of parsed) {
      if (typeof item !== 'object' || item === null) continue;
      const { mac, rssi, ts } = item as Record<string, unknown>;
      if (typeof mac !== 'string' || typeof rssi !== 'number') continue;
      events.push({
        gatewayId,
        tagId: mac.toUpperCase(),
        rssi,
        timestamp: typeof ts === 'number' ? ts : now,
      });
    }
    return events;
  }
}
