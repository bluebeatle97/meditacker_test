import type { AuthClaims, PresenceState } from '@meditracker/shared';

/**
 * 권한 필터 (설계서 6.3 — 보안 핵심)
 *
 * 불변식 B-1: 환자 소켓으로 타 환자·직원의 위치 좌표를 전송하지 않는다.
 * 필터링은 100% 서버에서 — 클라이언트에는 "볼 수 있는 데이터"만 직렬화.
 *
 * 권한 매트릭스는 법무·노무 검토 후 확정 (설계서 12) — 여기 로직만 고치면 됨.
 */
export function visibleTargets(
  viewer: AuthClaims,
  all: PresenceState[],
  tagOwner: (tagId: string) => { personId: string; dept?: string } | null,
): PresenceState[] {
  const role = viewer.type === 'staff' ? (viewer.role ?? 'staff') : 'patient';

  switch (role) {
    case 'patient':
      // 환자: 본인만. 같은 존 인원수는 별도 익명 집계 이벤트로 전송 (좌표 아님)
      return all.filter((p) => tagOwner(p.tagId)?.personId === viewer.personId);

    case 'nurse': {
      // 간호사: 담당구역(chargeZones) 내 전원 + 같은 과 직원
      const chargeZones = new Set(viewer.chargeZones ?? []);
      return all.filter((p) => {
        if (p.currentZone !== null && chargeZones.has(p.currentZone)) return true;
        const owner = tagOwner(p.tagId);
        return owner?.dept !== undefined && owner.dept === viewer.dept;
      });
    }

    case 'doctor':
    case 'manager':
      return all; // 전체 열람

    default:
      // 일반 staff: 정책 확정 전까지 본인만 (보수적 기본값)
      return all.filter((p) => tagOwner(p.tagId)?.personId === viewer.personId);
  }
}

/** 환자 화면용 — 같은 존의 "익명 인원 수"만 (설계서 7 zone:occupancy) */
export function anonymousOccupancy(zoneId: string, all: PresenceState[]): number {
  return all.filter((p) => p.currentZone === zoneId).length;
}
