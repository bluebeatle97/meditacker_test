import { TAG_GROUP_IDS, type TagGroup, type TagMetaMap } from '@meditracker/shared';
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

  /**
   * 이름·메모·그룹 저장.
   * `group` 을 안 보내면 기존 그룹을 유지한다 — 관제 페이지의 이름/메모 편집이
   * 직원 화면에서 지정한 그룹을 지워버리지 않도록. (모르는 값은 버린다)
   */
  set(tagId: string, name: string, memo: string, group?: string): void {
    if (!tagId) return;
    const g = TAG_GROUP_IDS.includes(group as TagGroup)
      ? (group as TagGroup)
      : this.map[tagId]?.group;
    this.map[tagId] = { name: name || undefined, memo: memo || undefined, group: g };
    upsertTagMeta(this.db, tagId, name, memo, g);
    for (const l of this.listeners) l(this.map);
  }

  onChange(cb: (map: TagMetaMap) => void): void {
    this.listeners.push(cb);
  }
}
