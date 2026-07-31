/**
 * 목(mock) 태그 명단과 역할별 동선 — **순수 데이터**.
 *
 * mock-gateway(신호 발생)와 dev-seed(사람·이름·그룹 시드) 양쪽이 같은 명단을 봐야 한다.
 * mock-gateway 를 직접 import 하면 MQTT 접속·타이머까지 딸려오므로 데이터만 뺐다.
 */

// 도면 구역을 순서대로 경유 (존 중심 좌표 자동 사용).
// 손님·직원이 섞여 돌아다니는 그림을 만들려고 역할별로 다른 동선을 둔다.
export const ROUTES: Record<string, Array<{ zoneId: string; pause: number }>> = {
  // 환자 A: 접수 → 상담 → 시술 → 회복
  patientA: [
    { zoneId: 'reception', pause: 40 },
    { zoneId: 'consult_2', pause: 30 },
    { zoneId: 'proc_2', pause: 45 },
    { zoneId: 'vip_recovery', pause: 35 },
    { zoneId: 'waiting_2', pause: 20 },
  ],
  // 환자 B: 접수 → 촬영 → 상담 → 레이저 → 회복
  patientB: [
    { zoneId: 'reception', pause: 30 },
    { zoneId: 'photo', pause: 20 },
    { zoneId: 'consult_1', pause: 35 },
    { zoneId: 'laser_1', pause: 40 },
    { zoneId: 'recovery_1', pause: 30 },
    { zoneId: 'waiting_1', pause: 25 },
  ],
  // 환자 C: 피부관리 코스 (체인징룸 경유)
  patientC: [
    { zoneId: 'waiting_3', pause: 25 },
    { zoneId: 'changing_w_1', pause: 20 },
    { zoneId: 'skincare_prep', pause: 15 },
    { zoneId: 'skincare', pause: 50 },
    { zoneId: 'changing_w_1', pause: 15 },
    { zoneId: 'reception', pause: 20 },
  ],
  // 환자 D: 수술 코스
  patientD: [
    { zoneId: 'waiting_2', pause: 30 },
    { zoneId: 'consult_3', pause: 25 },
    { zoneId: 'surgery_1', pause: 60 },
    { zoneId: 'recovery_2', pause: 45 },
  ],
  // 의사: 의국실 ↔ 상담실 ↔ 시술실 (짧게 자주 이동)
  doctor: [
    { zoneId: 'doctors_office', pause: 25 },
    { zoneId: 'consult_1', pause: 20 },
    { zoneId: 'proc_1', pause: 30 },
    { zoneId: 'consult_3', pause: 20 },
    { zoneId: 'surgery_2', pause: 35 },
  ],
  // 간호사: 소독실·회복실·접수를 계속 왕복
  nurse: [
    { zoneId: 'sterilize', pause: 15 },
    { zoneId: 'proc_2', pause: 20 },
    { zoneId: 'recovery_1', pause: 20 },
    { zoneId: 'reception', pause: 15 },
    { zoneId: 'pantry_1', pause: 20 },
  ],
  // 통역: 대기공간·상담실 중심 (손님 응대)
  interpreter: [
    { zoneId: 'waiting_1', pause: 30 },
    { zoneId: 'consult_2', pause: 35 },
    { zoneId: 'waiting_2', pause: 25 },
    { zoneId: 'reception', pause: 20 },
  ],
};

/**
 * 가상 태그 명단. MAC 끝 두 자리로 역할을 알 수 있게 묶어 뒀다
 * (01~ 환자, 50~ 직원). dev-seed 가 같은 MAC 에 이름·그룹을 붙인다.
 */
export const MOCK_TAGS: Array<{ mac: string; route: string; offsetSec: number }> = [
  { mac: 'AA:BB:CC:00:00:01', route: 'patientA', offsetSec: 0 },
  { mac: 'AA:BB:CC:00:00:02', route: 'patientA', offsetSec: 150 },
  { mac: 'AA:BB:CC:00:00:03', route: 'patientB', offsetSec: 0 },
  { mac: 'AA:BB:CC:00:00:04', route: 'patientB', offsetSec: 120 },
  { mac: 'AA:BB:CC:00:00:05', route: 'patientC', offsetSec: 0 },
  { mac: 'AA:BB:CC:00:00:06', route: 'patientC', offsetSec: 100 },
  { mac: 'AA:BB:CC:00:00:07', route: 'patientD', offsetSec: 0 },
  { mac: 'AA:BB:CC:00:00:08', route: 'patientD', offsetSec: 90 },
  { mac: 'AA:BB:CC:00:00:50', route: 'doctor', offsetSec: 0 },
  { mac: 'AA:BB:CC:00:00:51', route: 'doctor', offsetSec: 70 },
  { mac: 'AA:BB:CC:00:00:52', route: 'nurse', offsetSec: 0 },
  { mac: 'AA:BB:CC:00:00:53', route: 'nurse', offsetSec: 45 },
  { mac: 'AA:BB:CC:00:00:54', route: 'nurse', offsetSec: 90 },
  { mac: 'AA:BB:CC:00:00:60', route: 'interpreter', offsetSec: 0 },
];

