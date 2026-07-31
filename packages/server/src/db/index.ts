import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  PatientProfile,
  Person,
  PersonType,
  TagAssignment,
  TagGroup,
  TagMetaMap,
} from '@meditracker/shared';

const here = dirname(fileURLToPath(import.meta.url));

export type Db = Database.Database;

export function openDb(dbPath: string): Db {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(readFileSync(join(here, 'schema.sql'), 'utf-8'));
  migrate(db);
  return db;
}

/**
 * 이미 만들어진 DB 에 열을 추가한다.
 * schema.sql 은 CREATE TABLE IF NOT EXISTS 라서 기존 테이블의 열은 늘려주지 않는다.
 */
function migrate(db: Db): void {
  const cols = db.prepare(`PRAGMA table_info(tag_meta)`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'tag_group')) {
    db.exec(`ALTER TABLE tag_meta ADD COLUMN tag_group TEXT`);
  }
}

// ── 태그 ↔ 사람 매핑 (설계서 5.1 TagAssignment) ─────────────────────────────

export function assignTag(db: Db, a: TagAssignment): void {
  db.prepare(
    `INSERT INTO tags (tag_id, person_id, person_type, assigned_at, active)
     VALUES (?, ?, ?, ?, 1)
     ON CONFLICT(tag_id) DO UPDATE SET
       person_id = excluded.person_id, person_type = excluded.person_type,
       assigned_at = excluded.assigned_at, active = 1`,
  ).run(a.tagId, a.assignedTo, a.personType, a.assignedAt);
}

/**
 * 태그 반납 (환자 호출 후 회수 → 소독 → 재사용).
 * 캐릭터 커스터마이징도 같이 지운다 — 다음 환자가 이전 사람 캐릭터를 물려받으면 안 된다.
 */
export function releaseTag(db: Db, tagId: string): void {
  const person = findPersonByTag(db, tagId);
  db.prepare(`UPDATE tags SET active = 0 WHERE tag_id = ?`).run(tagId);
  if (person) clearPatientProfile(db, person.personId);
}

/** 화이트리스트 원본 — 배정되어 살아 있는 태그 ID 전부 */
export function getActiveTagIds(db: Db): string[] {
  const rows = db.prepare(`SELECT tag_id FROM tags WHERE active = 1`).all() as Array<{
    tag_id: string;
  }>;
  return rows.map((r) => r.tag_id);
}

/**
 * 비콘을 재고에 올린다 (관제 페이지 "미등록 신호" → 등록).
 *
 * persons 와 tags 를 한 트랜잭션으로 묶는다 — 하나만 들어가면 화이트리스트는 통과하는데
 * 주인이 없는 태그가 생긴다. 표시 이름(tag_meta)은 인메모리 캐시 일관성 때문에
 * 호출부가 `TagMetaStore.set()` 으로 따로 쓴다 (여기서 직접 쓰면 캐시가 어긋난다).
 *
 * personId 는 tagId 에서 결정론적으로 만든다. 같은 비콘을 다시 등록하면 같은 사람에
 * 붙는다 — 여기서 하는 건 "이 비콘이 우리 재고다" 이지 "이 비콘이 오늘 누구 것이다" 가
 * 아니기 때문. 접수 때 환자에게 지급/반납하는 건 별도 워크플로우다.
 */
export function registerTag(
  db: Db,
  { tagId, name, group }: { tagId: string; name: string; group: TagGroup },
): { personId: string } {
  const isStaff = group === 'doctor' || group === 'nurse' || group === 'interpreter';
  const type: PersonType = isStaff ? 'staff' : 'patient';
  // MAC 이든 UUID 합성키든 안전한 슬러그로 (구분자 제거 후 뒤 8자)
  const slug = tagId.replace(/[^A-Za-z0-9]/g, '').slice(-8).toLowerCase();
  const personId = `${type}-${slug}`;
  const role = group === 'doctor' ? 'doctor' : group === 'nurse' ? 'nurse' : null;

  db.transaction(() => {
    db.prepare(
      `INSERT INTO persons (person_id, type, display_name, role, dept) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(person_id) DO UPDATE SET display_name = excluded.display_name,
         type = excluded.type, role = excluded.role`,
    ).run(personId, type, name || tagId, role, isStaff ? 'derma' : null);

    assignTag(db, {
      tagId,
      assignedTo: personId,
      personType: type,
      assignedAt: Date.now(),
      active: true,
    });
  })();

  return { personId };
}

export function findPersonByTag(db: Db, tagId: string): Person | undefined {
  return db
    .prepare(
      `SELECT p.person_id AS personId, p.type, p.display_name AS displayName, p.role, p.dept
       FROM tags t JOIN persons p ON p.person_id = t.person_id
       WHERE t.tag_id = ? AND t.active = 1`,
    )
    .get(tagId) as Person | undefined;
}

// ── 입퇴실 로그 (설계서 5.2 PresenceLog) ────────────────────────────────────

export function openPresenceLog(db: Db, tagId: string, personId: string, zoneId: string, enteredAt: number): void {
  db.prepare(
    `INSERT INTO presence_logs (tag_id, person_id, zone_id, entered_at) VALUES (?, ?, ?, ?)`,
  ).run(tagId, personId, zoneId, enteredAt);
}

export function closePresenceLog(db: Db, tagId: string, exitedAt: number, durationSec: number): void {
  db.prepare(
    `UPDATE presence_logs SET exited_at = ?, duration_sec = ?
     WHERE id = (SELECT id FROM presence_logs WHERE tag_id = ? AND exited_at IS NULL ORDER BY entered_at DESC LIMIT 1)`,
  ).run(exitedAt, durationSec, tagId);
}

// ── 환자용 캐릭터 커스터마이징 (첫 진입 시 선택 → 반납 시 초기화) ───────────

export function getPatientProfile(db: Db, personId: string): PatientProfile | null {
  const row = db
    .prepare(`SELECT char_id AS charId, nickname FROM patient_profiles WHERE person_id = ?`)
    .get(personId) as PatientProfile | undefined;
  return row ?? null;
}

export function upsertPatientProfile(db: Db, personId: string, charId: string, nickname: string): void {
  db.prepare(
    `INSERT INTO patient_profiles (person_id, char_id, nickname, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(person_id) DO UPDATE SET char_id = excluded.char_id,
       nickname = excluded.nickname, updated_at = excluded.updated_at`,
  ).run(personId, charId, nickname || null, Date.now());
}

export function clearPatientProfile(db: Db, personId: string): void {
  db.prepare(`DELETE FROM patient_profiles WHERE person_id = ?`).run(personId);
}

// ── 태그 이름/메모 (설계서 외 운영 편의 — 관제·직원 화면 라벨) ──────────────

export function getAllTagMeta(db: Db): TagMetaMap {
  const rows = db.prepare(`SELECT tag_id, name, memo, tag_group FROM tag_meta`).all() as Array<{
    tag_id: string;
    name: string | null;
    memo: string | null;
    tag_group: string | null;
  }>;
  const map: TagMetaMap = {};
  for (const r of rows) {
    map[r.tag_id] = {
      name: r.name ?? undefined,
      memo: r.memo ?? undefined,
      group: (r.tag_group as TagGroup | null) ?? undefined,
    };
  }
  return map;
}

export function upsertTagMeta(
  db: Db,
  tagId: string,
  name: string,
  memo: string,
  group: TagGroup | undefined,
): void {
  db.prepare(
    `INSERT INTO tag_meta (tag_id, name, memo, tag_group, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(tag_id) DO UPDATE SET name = excluded.name, memo = excluded.memo,
       tag_group = excluded.tag_group, updated_at = excluded.updated_at`,
  ).run(tagId, name || null, memo || null, group ?? null, Date.now());
}
