/**
 * 개발용 시드 + JWT 발급 (Phase 2 로그인 화면 전까지의 임시 수단)
 *
 *   npm run dev:seed -w @meditracker/server
 *
 * 목 게이트웨이가 돌리는 가상 태그 전원에 사람·이름·그룹을 붙인다.
 * 명단은 mock-tags.ts 를 그대로 가져온다 — 두 곳에 적으면 어긋난다.
 *
 * - persons: 손님(환자) + 직원(의사·간호사·통역)
 * - tags: MAC ↔ person 배정
 * - tag_meta: 직원 화면 왼쪽 비콘 목록에 뜰 이름·그룹·메모
 * - 직원/환자용 JWT 출력 → 프론트에 ?token=... 으로 전달
 */
import { SERVER_CONFIG } from '../config/index.js';
import { assignBeacon, openDb, releaseBeacon, upsertTagMeta } from '../db/index.js';
import { signToken } from '../auth/jwt.js';
import { MOCK_TAGS, mockProfileFor } from '@meditracker/shared';
import type { PersonType, TagGroup } from '@meditracker/shared';

const db = openDb(SERVER_CONFIG.dbPath);

const STAFF_GROUPS = new Set<TagGroup>(['doctor', 'nurse', 'interpreter']);

let persons = 0;
let firstPatient = '';

for (const [i, tag] of MOCK_TAGS.entries()) {
  const profile = mockProfileFor(tag.mac, tag.route, i);
  const isStaff = STAFF_GROUPS.has(profile.group);
  // 등록 + 배정을 한 번에. person 은 assignBeacon 이 배정마다 새로 만든다
  const { personId } = assignBeacon(db, {
    tagId: tag.mac,
    displayName: profile.name,
    group: profile.group,
  });
  persons++;
  // 직원 화면 비콘 목록에 이름·그룹이 바로 뜨게
  upsertTagMeta(db, tag.mac, profile.name, profile.memo ?? '', profile.group);

  if (!isStaff && !firstPatient) firstPatient = personId;
}

// 명단에서 빠진 태그는 반납 처리 — 안 그러면 신호 없는 옛 배정이 DB 에 남는다
const keep = MOCK_TAGS.map((t) => t.mac);
const stale = db
  .prepare(
    `SELECT tag_id FROM assignments
     WHERE released_at IS NULL AND tag_id NOT IN (${keep.map(() => '?').join(',')})`,
  )
  .all(...keep) as Array<{ tag_id: string }>;
for (const r of stale) releaseBeacon(db, r.tag_id);
const dropped = stale.length;

// 관제·직원 화면을 열 계정 (전체 열람 권한이 있는 의사 역할)
db.prepare(
  `INSERT INTO persons (person_id, type, display_name, role, dept) VALUES (?, ?, ?, ?, ?)
   ON CONFLICT(person_id) DO UPDATE SET display_name = excluded.display_name`,
).run('staff-doc-1', 'staff', '관제 담당', 'doctor', 'derma');

const staffToken = signToken(
  { personId: 'staff-doc-1', type: 'staff', role: 'doctor', dept: 'derma' },
  SERVER_CONFIG.jwtSecret,
);
const patientToken = signToken({ personId: firstPatient, type: 'patient' }, SERVER_CONFIG.jwtSecret);

console.log(
  `[dev-seed] 완료 — persons ${persons + 1}, tags ${MOCK_TAGS.length}` +
    (dropped > 0 ? ` (명단에서 빠진 옛 배정 ${dropped}건 반납 처리)` : '') +
    '\n',
);
console.log(`직원용:  http://localhost:5173/?token=${staffToken}\n`);
console.log(`환자용(${firstPatient}): http://localhost:5174/?token=${patientToken}`);
