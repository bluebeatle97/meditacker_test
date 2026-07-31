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
import { assignTag, openDb, upsertTagMeta } from '../db/index.js';
import { signToken } from '../auth/jwt.js';
import { MOCK_TAGS } from './mock-tags.js';
import type { PersonType, TagGroup } from '@meditracker/shared';

const db = openDb(SERVER_CONFIG.dbPath);

/** 목 태그 MAC → 표시 이름·그룹·메모 */
const PROFILE: Record<string, { name: string; group: TagGroup; memo?: string }> = {
  'AA:BB:CC:00:00:01': { name: '손님 1', group: 'patient', memo: '상담 → 시술' },
  'AA:BB:CC:00:00:02': { name: '손님 2', group: 'patient' },
  'AA:BB:CC:00:00:03': { name: '손님 3', group: 'patient', memo: '레이저 예약' },
  'AA:BB:CC:00:00:04': { name: '손님 4', group: 'patient' },
  'AA:BB:CC:00:00:05': { name: '손님 5', group: 'patient', memo: '피부관리 코스' },
  'AA:BB:CC:00:00:06': { name: '손님 6', group: 'patient' },
  'AA:BB:CC:00:00:07': { name: '손님 7', group: 'patient', memo: '수술 예정' },
  'AA:BB:CC:00:00:08': { name: '손님 8', group: 'patient' },
  'AA:BB:CC:00:00:50': { name: '김원장', group: 'doctor', memo: '피부과' },
  'AA:BB:CC:00:00:51': { name: '박과장', group: 'doctor', memo: '성형외과' },
  'AA:BB:CC:00:00:52': { name: '이간호사', group: 'nurse', memo: '시술실 담당' },
  'AA:BB:CC:00:00:53': { name: '최간호사', group: 'nurse', memo: '회복실 담당' },
  'AA:BB:CC:00:00:54': { name: '정간호사', group: 'nurse' },
  'AA:BB:CC:00:00:60': { name: '왕통역', group: 'interpreter', memo: '중국어' },
};

const STAFF_GROUPS = new Set<TagGroup>(['doctor', 'nurse', 'interpreter']);
let persons = 0;
let firstPatient = '';

for (const [i, tag] of MOCK_TAGS.entries()) {
  const profile = PROFILE[tag.mac] ?? { name: `손님 ${i + 1}`, group: 'unassigned' as TagGroup };
  const isStaff = STAFF_GROUPS.has(profile.group);
  const personId = `${isStaff ? 'staff' : 'patient'}-${tag.mac.slice(-2)}`;
  const type: PersonType = isStaff ? 'staff' : 'patient';
  const role = profile.group === 'doctor' ? 'doctor' : profile.group === 'nurse' ? 'nurse' : null;

  db.prepare(
    `INSERT INTO persons (person_id, type, display_name, role, dept) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(person_id) DO UPDATE SET display_name = excluded.display_name,
       type = excluded.type, role = excluded.role`,
  ).run(personId, type, profile.name, role, isStaff ? 'derma' : null);
  persons++;

  assignTag(db, {
    tagId: tag.mac,
    assignedTo: personId,
    personType: type,
    assignedAt: Date.now(),
    active: true,
  });
  // 직원 화면 비콘 목록에 이름·그룹이 바로 뜨게
  upsertTagMeta(db, tag.mac, profile.name, profile.memo ?? '', profile.group);

  if (!isStaff && !firstPatient) firstPatient = personId;
}

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

console.log(`[dev-seed] 완료 — persons ${persons + 1}, tags ${MOCK_TAGS.length}\n`);
console.log(`직원용:  http://localhost:5173/?token=${staffToken}\n`);
console.log(`환자용(${firstPatient}): http://localhost:5174/?token=${patientToken}`);
