import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  NavigationLog,
  NavigationStatus,
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

  // 팔찌 QR 을 처음 찍은 기기가 그 배정을 차지한다 (아래 claimAssignment 참고)
  const acols = db.prepare(`PRAGMA table_info(assignments)`).all() as Array<{ name: string }>;
  if (!acols.some((c) => c.name === 'claimed_at')) {
    db.exec(`ALTER TABLE assignments ADD COLUMN claimed_at INTEGER`);
  }
}

/** 팔찌에 인쇄되는 번호 — MAC 에서 구분기호를 뺀 뒤 뒤 6자리 */
export function pinOf(tagId: string): string {
  return tagId.replace(/[^0-9A-Fa-f]/g, '').slice(-6).toUpperCase();
}

/**
 * 핀으로 비콘 찾기.
 *
 * 24비트(1,677만) 공간이라 비콘 100개로는 충돌이 사실상 없지만 0은 아니다. 겹치면
 * **아무거나 고르면 안 된다** — 남의 화면이 열린다. 그래서 겹침을 따로 알린다.
 */
export function findBeaconByPin(
  db: Db,
  pin: string,
): { tagId: string } | 'none' | 'ambiguous' {
  const want = pin.replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  if (want.length !== 6) return 'none';
  const hits = (
    db.prepare(`SELECT tag_id FROM beacons WHERE retired = 0`).all() as Array<{ tag_id: string }>
  ).filter((b) => pinOf(b.tag_id) === want);
  if (hits.length === 0) return 'none';
  if (hits.length > 1) return 'ambiguous';
  return { tagId: hits[0].tag_id };
}

/**
 * 팔찌 QR 을 처음 찍은 기기가 이 배정을 차지한다.
 *
 * **왜 필요한가.** 핀은 팔찌에 인쇄돼 있어 안 바뀌는데 환자는 바뀐다. 아침 환자가
 * 브라우저 기록에 남은 링크를 오후에 다시 누르면 그 팔찌를 지금 든 사람의 위치가
 * 보인다. 먼저 찍은 기기에 묶어 두면, 데스크에서 팔찌를 받자마자 찍는 환자가 이기고
 * 나중에 누르는 예전 환자는 거부된다.
 *
 * 기기 식별자를 브라우저에 저장하지는 않는다(불변식 B-5). 대신 **차지한 사실만** 여기
 * 적어두고, 그 기기는 발급받은 토큰을 URL 에 지닌 채로 다닌다.
 */
export function claimAssignment(db: Db, tagId: string): 'ok' | 'already' | 'none' {
  const open = getOpenAssignment(db, tagId);
  if (!open) return 'none';
  const row = db
    .prepare(`SELECT claimed_at AS claimedAt FROM assignments WHERE id = ?`)
    .get(open.assignmentId) as { claimedAt: number | null };
  if (row.claimedAt) return 'already';
  db.prepare(`UPDATE assignments SET claimed_at = ? WHERE id = ?`).run(Date.now(), open.assignmentId);
  return 'ok';
}

/** 데스크용 — 환자가 폰을 바꾸거나 기록을 지웠을 때 다시 찍을 수 있게 푼다 */
export function resetClaim(db: Db, tagId: string): void {
  const open = getOpenAssignment(db, tagId);
  if (open) db.prepare(`UPDATE assignments SET claimed_at = NULL WHERE id = ?`).run(open.assignmentId);
}

/** 이 배정이 이미 누군가에게 차지됐나 (목록 표시용) */
export function isClaimed(db: Db, tagId: string): boolean {
  const open = getOpenAssignment(db, tagId);
  if (!open) return false;
  const row = db
    .prepare(`SELECT claimed_at AS claimedAt FROM assignments WHERE id = ?`)
    .get(open.assignmentId) as { claimedAt: number | null };
  return row.claimedAt !== null;
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

/** 이 MAC 이 이미 재고에 있나 (폐기된 것도 포함 — 되살리는 건 등록과 다른 일이다) */
export function findBeacon(db: Db, tagId: string): { tagId: string; retired: boolean } | undefined {
  const row = db
    .prepare(`SELECT tag_id AS tagId, retired FROM beacons WHERE tag_id = ?`)
    .get(tagId) as { tagId: string; retired: number } | undefined;
  return row ? { tagId: row.tagId, retired: row.retired === 1 } : undefined;
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
/**
 * 이 팔찌를 지금 든 사람의 표시 이름을 바꾼다.
 *
 * **이름은 한 값이다.** 예전엔 비콘 목록이 `tag_meta.name` 을, 환자 등록/반납이
 * `persons.display_name` 을 각각 보여줘서 한쪽만 고치면 갈라졌다 — 목록에서 이름을
 * 고쳐도 등록/반납엔 `비콘 5` 가 그대로 남았다. 어느 쪽에서 고치든 둘 다 바뀌게 한다.
 *
 * 배정이 없으면 아무것도 안 한다 (창고 비콘엔 사람이 없다).
 */
export function renameHolder(db: Db, tagId: string, displayName: string): void {
  const open = getOpenAssignment(db, tagId);
  if (!open) return;
  db.prepare(`UPDATE persons SET display_name = ? WHERE person_id = ?`).run(
    displayName,
    open.personId,
  );
}

export function releaseBeacon(db: Db, tagId: string): void {
  const open = getOpenAssignment(db, tagId);
  if (!open) return;
  db.prepare(`UPDATE assignments SET released_at = ? WHERE id = ?`).run(Date.now(), open.assignmentId);
  clearPatientProfile(db, open.personId);
}

export interface BeaconRow {
  tagId: string;
  label: string | null;
  registeredAt: number;
  /** 지금 배정돼 있으면 그 사람, 아니면 null (창고 보관) */
  personId: string | null;
  holder: string | null;
  assignedAt: number | null;
}

/**
 * 비콘 재고 전체 — 배정된 것과 창고에 있는 것을 한 번에.
 * 태그 목록 화면의 원천이라 미배정도 같이 나와야 한다.
 */
export function listBeacons(db: Db): BeaconRow[] {
  return db
    .prepare(
      `SELECT b.tag_id AS tagId, b.label, b.registered_at AS registeredAt,
              a.person_id AS personId, p.display_name AS holder, a.assigned_at AS assignedAt
       FROM beacons b
       LEFT JOIN assignments a ON a.tag_id = b.tag_id AND a.released_at IS NULL
       LEFT JOIN persons p ON p.person_id = a.person_id
       WHERE b.retired = 0
       ORDER BY b.tag_id`,
    )
    .all() as BeaconRow[];
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

// ── 방 안내 이력 (알림톡·대기시간 분석의 원본) ──────────────────────────────
//
// 살아 있는 화살표는 GuidanceStore(메모리)에 있고, 여기는 그 이력이다.
// 상태 전이는 전부 `closeNavLog` 한 곳을 지난다 — 종료 경로가 넷(도착·해제·변경·중단)이라
// 각자 UPDATE 를 쓰면 travel_sec 을 빼먹거나 이미 닫힌 줄을 두 번 닫는 일이 생긴다.

/** 진행 중인 안내 한 줄 (비콘당 최대 하나) */
export function findOpenNavLog(db: Db, tagId: string): NavigationLog | undefined {
  return db
    .prepare(
      `SELECT id, tag_id AS tagId, person_id AS personId, person_name AS personName,
              from_zone AS fromZone, to_zone AS toZone, issued_at AS issuedAt,
              arrived_at AS arrivedAt, closed_at AS closedAt, status, travel_sec AS travelSec
       FROM navigation_logs WHERE tag_id = ? AND closed_at IS NULL
       ORDER BY issued_at DESC LIMIT 1`,
    )
    .get(tagId) as NavigationLog | undefined;
}

export function openNavLog(
  db: Db,
  row: {
    tagId: string;
    personId: string | null;
    personName: string | null;
    fromZone: string | null;
    toZone: string;
    issuedAt: number;
  },
): number {
  const info = db
    .prepare(
      `INSERT INTO navigation_logs
         (tag_id, person_id, person_name, from_zone, to_zone, issued_at, status)
       VALUES (?, ?, ?, ?, ?, ?, 'moving')`,
    )
    .run(row.tagId, row.personId, row.personName, row.fromZone, row.toZone, row.issuedAt);
  return Number(info.lastInsertRowid);
}

/**
 * 진행 중인 안내를 닫는다. 열린 줄이 없으면 아무것도 안 하고 undefined.
 *
 * `travel_sec` 은 도착일 때만 채운다 — 해제·중단은 "몇 초 걸렸다" 가 의미 없는 값이고,
 * 채워 두면 나중에 평균 이동시간을 낼 때 걸러야 할 쓰레기가 섞인다.
 */
export function closeNavLog(
  db: Db,
  tagId: string,
  status: Exclude<NavigationStatus, 'moving'>,
  at: number,
): NavigationLog | undefined {
  const open = findOpenNavLog(db, tagId);
  if (!open) return undefined;
  const arrived = status === 'arrived';
  const travelSec = arrived ? Math.max(0, Math.round((at - open.issuedAt) / 1000)) : null;
  db.prepare(
    `UPDATE navigation_logs SET status = ?, closed_at = ?, arrived_at = ?, travel_sec = ?
     WHERE id = ?`,
  ).run(status, at, arrived ? at : null, travelSec, open.id);
  return { ...open, status, closedAt: at, arrivedAt: arrived ? at : null, travelSec };
}

/**
 * 서버가 뜰 때 남아 있는 `moving` 줄을 정리한다.
 *
 * 살아 있던 안내는 메모리에 있었으므로 재시작으로 전부 사라졌다 — 그 줄들을 그대로 두면
 * 아무도 도착 판정을 해 줄 수 없어 **영원히 이동 중**으로 남는다. 알림을 붙이면 그게 곧
 * 끝나지 않는 알림이 되므로, 뜰 때 한 번 끊어 준다.
 */
export function abortOpenNavLogs(db: Db, at: number): number {
  const info = db
    .prepare(
      `UPDATE navigation_logs SET status = 'aborted', closed_at = ?
       WHERE closed_at IS NULL`,
    )
    .run(at);
  return info.changes;
}

/** 최근 이력 (관제·알림 연동에서 읽는다). 진행 중인 줄도 섞여 나온다 */
export function listNavLogs(
  db: Db,
  opts: { limit?: number; personId?: string; tagId?: string } = {},
): NavigationLog[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.personId) {
    where.push('person_id = ?');
    args.push(opts.personId);
  }
  if (opts.tagId) {
    where.push('tag_id = ?');
    args.push(opts.tagId);
  }
  args.push(Math.min(Math.max(opts.limit ?? 100, 1), 500));
  return db
    .prepare(
      `SELECT id, tag_id AS tagId, person_id AS personId, person_name AS personName,
              from_zone AS fromZone, to_zone AS toZone, issued_at AS issuedAt,
              arrived_at AS arrivedAt, closed_at AS closedAt, status, travel_sec AS travelSec
       FROM navigation_logs
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY issued_at DESC LIMIT ?`,
    )
    .all(...args) as NavigationLog[];
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
