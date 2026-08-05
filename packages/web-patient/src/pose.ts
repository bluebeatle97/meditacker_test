import type { Zone, ZoneType } from '@meditracker/shared';

/**
 * 사람이 지금 취할 자세를 고른다 — 걷기 / 앉기 / 폰 보기 / 서기.
 *
 * **왜 필요한가.** 도착해서 머무는 사람이 전부 선 채로 숨만 쉬면 대기실이 사람 대기실로
 * 안 보인다. 동선 타임라인에 이미 '머무는 구간' 이 있으니, 그 정보를 자세로 쓰면
 * 스프라이트만 갈아 끼워도 화면이 살아난다.
 *
 * Phaser 에 의존하지 않는 순수 함수로 둔다 — 브라우저 없이 검증할 수 있어야 한다
 * (실제로 WebGL 이 안 뜨는 환경에서 이 규칙만 따로 확인해야 했다).
 */

export type Pose = 'walk' | 'sit' | 'phone' | 'idle';

/**
 * 앉을 수 있는 방. 의자·침대가 있고 머무르는 곳이다.
 * 접수·복도(etc)·수술실·직원구역은 뺀다 — 복도 한가운데 앉아 있으면 그게 더 이상하고,
 * 수술실은 앉는 자세 자체가 맞지 않는다.
 */
export const SITTABLE_ZONE_TYPES: ReadonlySet<ZoneType> = new Set<ZoneType>([
  'waiting',
  'consult',
  'recovery',
  'skincare',
]);

/** 앉을 수 있는 방에서도 이 비율(1/N)은 서서 폰을 본다 — 전원이 같은 자세면 인형처럼 보인다 */
export const PHONE_SHARE = 3;

/** 존 중심에서 이 거리(도면 px) 밖이면 방 안이라고 보지 않는다 (복도로 취급) */
export const IN_ZONE_PX = 110;

/** 익명 id → 같은 사람은 늘 같은 선택 (프레임마다 다시 뽑으면 자세가 깜빡인다) */
function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

/** 이 지점이 앉을 만한 방 안인가 (도면 좌표) */
export function sittableAt(zones: Iterable<Zone>, x: number, y: number): boolean {
  let bestType: ZoneType | undefined;
  let bestD = Number.POSITIVE_INFINITY;
  for (const z of zones) {
    const d = Math.hypot(z.tilePosition.x - x, z.tilePosition.y - y);
    if (d < bestD) {
      bestD = d;
      bestType = z.type;
    }
  }
  return bestType !== undefined && bestD <= IN_ZONE_PX && SITTABLE_ZONE_TYPES.has(bestType);
}

/**
 * @param id     익명 id — 같은 사람이 늘 같은 자세를 고르게 하는 씨앗
 * @param moving 이번 프레임에 움직였나
 * @param x,y    **도면 좌표** (화면 좌표가 아니다 — 축척만큼 어긋난다)
 */
export function poseFor(
  zones: Iterable<Zone>,
  id: string,
  moving: boolean,
  x: number,
  y: number,
): Pose {
  if (moving) return 'walk';
  if (!sittableAt(zones, x, y)) return 'idle';
  return Math.abs(hashCode(id)) % PHONE_SHARE === 0 ? 'phone' : 'sit';
}
