import type { TagMetaMap } from '@meditracker/shared';
import { getAllTagMeta, upsertTagMeta, type Db } from '../db/index.js';

/**
 * 태그 이름/메모 저장소 — 인메모리 캐시 + SQLite 영속화.
 * 변경 시 리스너에 알려 관제(/monitor)·직원(/staff) 화면으로 실시간 브로드캐스트.
 */
export class TagMetaStore {
  private map: TagMetaMap;
  private listeners: Array<(map: TagMetaMap) => void> = [];

  constructor(private db: Db) {
    this.map = getAllTagMeta(db);
  }

  all(): TagMetaMap {
    return this.map;
  }

  set(tagId: string, name: string, memo: string): void {
    if (!tagId) return;
    this.map[tagId] = { name: name || undefined, memo: memo || undefined };
    upsertTagMeta(this.db, tagId, name, memo);
    for (const l of this.listeners) l(this.map);
  }

  onChange(cb: (map: TagMetaMap) => void): void {
    this.listeners.push(cb);
  }
}
