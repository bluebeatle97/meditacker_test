import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  PatientProfile,
  Person,
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
