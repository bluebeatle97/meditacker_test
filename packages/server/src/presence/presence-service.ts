import type { PresenceState } from '@meditracker/shared';
import type { ZoneChangeEvent, ZoneEngine } from '../zone-engine/zone-engine.js';
import { closePresenceLog, findPersonByTag, openPresenceLog, type Db } from '../db/index.js';

export interface PresenceChange extends ZoneChangeEvent {
  personId: string | null; // 미배정 태그면 null (로그 미기록)
}

/**
 * Zone Engine 의 zoneChange 를 받아 입퇴실 로그를 DB에 기록하고
 * 상위(권한필터 → WebSocket)로 전달 (설계서 6.2 commitZone 후처리 + 5.2)
 */
export class PresenceService {
  private listeners: Array<(change: PresenceChange) => void> = [];

  constructor(
    private engine: ZoneEngine,
    private db: Db,
  ) {
    engine.on('zoneChange', (e: ZoneChangeEvent) => this.handleZoneChange(e));
  }

  onChange(listener: (change: PresenceChange) => void): void {
    this.listeners.push(listener);
  }

  getAllStates(): PresenceState[] {
    return this.engine.getAllStates();
  }

  private handleZoneChange(e: ZoneChangeEvent): void {
    const person = findPersonByTag(this.db, e.tagId);
    const personId = person?.personId ?? null;

    if (personId) {
      if (e.fromZone !== null) {
        closePresenceLog(this.db, e.tagId, e.at, e.durationSec ?? 0);
      }
      if (e.toZone !== null) {
        openPresenceLog(this.db, e.tagId, personId, e.toZone, e.at);
      }
    }

    const change: PresenceChange = { ...e, personId };
    for (const listener of this.listeners) listener(change);
  }
}
