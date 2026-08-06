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
  migrateTagsToBeacons(db);
}

/**
 * 구버전 `tags` → `beacons` + `assignments` 이관.
 *
 * 옛 구조는 비콘 한 개당 사람 한 명이 영구히 붙어 있었다(`person_id` 가 MAC 에서 파생).
 * 비콘을 돌려쓰면 두 환자가 같은 사람이 되어 체류 기록이 이어붙는다. 그래서 하드웨어
 * 대장과 배정 이력을 갈랐다.
 *
 * 이관은 **beacons 가 비어 있을 때 한 번만** 돈다. 옛 표는 지우지 않는다 — 되돌릴 여지를
 * 남겨두는 값이 지금 단계에서는 정리보다 크다.
 */
function migrateTagsToBeacons(db: Db): void {
  const already = db.prepare(`SELECT COUNT(*) AS c FROM beacons`).get() as { c: number };
  if (already.c > 0) return;
  const old = db
    .prepare(`SELECT tag_id, person_id, assigned_at, active FROM tags`)
    .all() as Array<{ tag_id: string; person_id: string | null; assigned_at: number | null; active: number }>;
  if (old.length === 0) return;

  db.transaction(() => {
    for (const t of old) {
      db.prepare(
        `INSERT OR IGNORE INTO beacons (tag_id, label, registered_at, retired) VALUES (?, NULL, ?, 0)`,
      ).run(t.tag_id, t.assigned_at ?? Date.now());
      // 살아 있던 배정만 '열린 배정' 으로 옮긴다. 이미 반납된 건 이력이 없으므로 버린다
      if (t.active === 1 && t.person_id) {
        db.prepare(
          `INSERT INTO assignments (tag_id, person_id, assigned_at, released_at) VALUES (?, ?, ?, NULL)`,
        ).run(t.tag_id, t.person_id, t.assigned_at ?? Date.now());
      }
    }
  })();
  console.log(`[db] tags → beacons/assignments 이관: 비콘 ${old.length}개`);
}

// ── 비콘 대장 · 배정 (설계서 5.1 TagAssignment) ─────────────────────────────
//
// **등록과 배정은 다른 일이다.**
//   등록 — 비콘당 평생 한 번. "이건 우리 하드웨어다". 화이트리스트의 원본
//   배정 — 방문마다. "이 비콘을 지금 이 사람이 들고 있다". 화면 노출의 기준
// 비콘은 전원이 늘 켜져 있어 창고에 있어도 신호를 보낸다. 그래서 둘을 갈라야
// "등록됐지만 아무도 안 들고 있음" 상태를 표현할 수 있다.

/** 비콘을 하드웨어 대장에 올린다 (사람은 안 붙는다) */
export function registerBeacon(db: Db, tagId: string, label?: string): void {
  db.prepare(
    `INSERT INTO beacons (tag_id, label, registered_at, retired) VALUES (?, ?, ?, 0)
     ON CONFLICT(tag_id) DO UPDATE SET label = COALESCE(excluded.label, beacons.label), retired = 0`,
  ).run(tagId, label ?? null, Date.now());
}

/** 분실·고장으로 재고에서 뺀다. 열린 배정이 있으면 같이 닫는다 */
export function retireBeacon(db: Db, tagId: string): void {
  db.transaction(() => {
    releaseBeacon(db, tagId);
    db.prepare(`UPDATE beacons SET retired = 1 WHERE tag_id = ?`).run(tagId);
  })();
}

/** 화이트리스트 원본 — 등록돼 있고 폐기되지 않은 비콘 전부 (배정 여부와 무관) */
export function getRegisteredTagIds(db: Db): string[] {
  const rows = db.prepare(`SELECT tag_id FROM beacons WHERE retired = 0`).all() as Array<{
    tag_id: string;
  }>;
  return rows.map((r) => r.tag_id);
}

/** 지금 누군가 들고 있는 비콘 — 화면에 나갈 대상 */
export function getAssignedTagIds(db: Db): string[] {
  const rows = db
    .prepare(`SELECT tag_id FROM assignments WHERE released_at IS NULL`)
    .all() as Array<{ tag_id: string }>;
  return rows.map((r) => r.tag_id);
}

export interface OpenAssignment {
  assignmentId: number;
  tagId: string;
  personId: string;
  assignedAt: number;
}

export function getOpenAssignment(db: Db, tagId: string): OpenAssignment | undefined {
  return db
    .prepare(
      `SELECT id AS assignmentId, tag_id AS tagId, person_id AS personId, assigned_at AS assignedAt
       FROM assignments WHERE tag_id = ? AND released_at IS NULL`,
    )
    .get(tagId) as OpenAssignment | undefined;
}

/**
 * 비콘을 사람에게 배정한다.
 *
 * **배정마다 새 person 을 만든다.** 비콘을 돌려쓰기 때문이다 — 같은 person_id 를 재사용하면
 * presence_logs 가 person_id 기준이라 앞 사람과 뒤 사람의 동선이 한 기록으로 이어붙는다.
 *
 * 열려 있던 배정은 먼저 닫는다. 인포에서 반납을 안 찍고 바로 다음 환자에게 넘기는 일이
 * 실제로 생기는데, 그때 앞 사람의 캐릭터·별명이 그대로 넘어가면 안 된다.
 */
export function assignBeacon(
  db: Db,
  { tagId, displayName, group }: { tagId: string; displayName: string; group: TagGroup },
): { personId: string; assignmentId: number } {
  const isStaff = group === 'doctor' || group === 'nurse' || group === 'interpreter';
  const type: PersonType = isStaff ? 'staff' : 'patient';
  const role = group === 'doctor' ? 'doctor' : group === 'nurse' ? 'nurse' : null;

  return db.transaction(() => {
    registerBeacon(db, tagId); // 등록 안 된 비콘에 배정하면 같이 올린다
    releaseBeacon(db, tagId);

    const info = db
      .prepare(
        `INSERT INTO assignments (tag_id, person_id, assigned_at, released_at)
         VALUES (?, '', ?, NULL)`,
      )
      .run(tagId, Date.now());
    const assignmentId = Number(info.lastInsertRowid);
    // 배정 번호로 사람 id 를 만든다 — 비콘에서 만들면 재사용 때 같은 사람이 되어 버린다
    const personId = `${type}-a${assignmentId}`;

    db.prepare(`UPDATE assignments SET person_id = ? WHERE id = ?`).run(personId, assignmentId);
    db.prepare(
      `INSERT INTO persons (person_id, type, display_name, role, dept) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(person_id) DO UPDATE SET display_name = excluded.display_name,
         type = excluded.type, role = excluded.role`,
    ).run(personId, type, displayName || tagId, role, isStaff ? 'derma' : null);

    return { personId, assignmentId };
  })();
}

/**
 * 반납. 캐릭터 커스터마이징도 같이 지운다 —
 * 다음 환자가 이전 사람 캐릭터를 물려받으면 안 된다.
 */
export function releaseBeacon(db: Db, tagId: string): void {
  const open = getOpenAssignment(db, tagId);
  if (!open) return;
  db.prepare(`UPDATE assignments SET released_at = ? WHERE id = ?`).run(Date.now(), open.assignmentId);
  clearPatientProfile(db, open.personId);
}

/** 이 비콘을 **지금** 들고 있는 사람. 배정이 없으면 undefined (창고에 있는 비콘) */
export function findPersonByTag(db: Db, tagId: string): Person | undefined {
  return db
    .prepare(
      `SELECT p.person_id AS personId, p.type, p.display_name AS displayName, p.role, p.dept
       FROM assignments a JOIN persons p ON p.person_id = a.person_id
       WHERE a.tag_id = ? AND a.released_at IS NULL`,
    )
    .get(tagId) as Person | undefined;
}

/** 이 사람이 **지금** 들고 있는 비콘 */
export function findTagByPerson(db: Db, personId: string): string | null {
  const row = db
    .prepare(`SELECT tag_id FROM assignments WHERE person_id = ? AND released_at IS NULL`)
    .get(personId) as { tag_id: string } | undefined;
  return row?.tag_id ?? null;
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
