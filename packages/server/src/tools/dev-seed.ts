/**
 * 개발용 시드 + JWT 발급 (Phase 2 로그인 화면 전까지의 임시 수단)
 *
 *   npm run dev:seed -w @meditracker/server
 *
 * - persons: 의사 1명 + 환자 2명
 * - tags: 목 게이트웨이(mock-gateway.ts)가 쓰는 MAC 2개를 환자에게 배정
 * - 직원/환자용 JWT 출력 → 프론트에 ?token=... 으로 전달
 */
import { SERVER_CONFIG } from '../config/index.js';
import { assignTag, openDb } from '../db/index.js';
import { signToken } from '../auth/jwt.js';

const db = openDb(SERVER_CONFIG.dbPath);

const persons = [
  { personId: 'staff-doc-1', type: 'staff', displayName: '김원장', role: 'doctor', dept: 'derma' },
  { personId: 'patient-001', type: 'patient', displayName: '환자 A', role: null, dept: null },
  { personId: 'patient-002', type: 'patient', displayName: '환자 B', role: null, dept: null },
] as const;

for (const p of persons) {
  db.prepare(
    `INSERT INTO persons (person_id, type, display_name, role, dept) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(person_id) DO UPDATE SET display_name = excluded.display_name`,
  ).run(p.personId, p.type, p.displayName, p.role, p.dept);
}

// 목 게이트웨이의 가상 태그 MAC ↔ 환자 매핑
assignTag(db, { tagId: 'AA:BB:CC:00:00:01', assignedTo: 'patient-001', personType: 'patient', assignedAt: Date.now(), active: true });
assignTag(db, { tagId: 'AA:BB:CC:00:00:02', assignedTo: 'patient-002', personType: 'patient', assignedAt: Date.now(), active: true });

const staffToken = signToken(
  { personId: 'staff-doc-1', type: 'staff', role: 'doctor', dept: 'derma' },
  SERVER_CONFIG.jwtSecret,
);
const patientToken = signToken(
  { personId: 'patient-001', type: 'patient' },
  SERVER_CONFIG.jwtSecret,
);

console.log('[dev-seed] 완료 — persons 3, tags 2\n');
console.log(`직원용(의사):  http://localhost:5173/?token=${staffToken}\n`);
console.log(`환자용(환자A): http://localhost:5174/?token=${patientToken}`);
