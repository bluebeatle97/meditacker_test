export { ZoneDwellFilter, ZONE_DWELL_MS } from './zone-dwell.js';
export { MOCK_PROFILES, MOCK_TAGS, ROUTES, groupFromRoute, mockProfileFor } from './mock-tags.js';
export {
  CM_PER_PX,
  MOCK_WALK_PX_PER_SEC,
  buildRouteTimelines,
  positionAt,
  type RouteStop,
  type RouteTimeline,
} from './mock-walk.js';
export { DemoSim } from './demo-sim.js';
export {
  PATH_LOSS_N,
  RX_FLOOR,
  TX_AT_1M,
  USABLE_RSSI,
  WALL_LOSS_DB,
  rssiAt,
} from './rssi-model.js';
export {
  computeCoverage,
  coverageStats,
  wallsBetween,
  type BlockedGrid,
  type CoverageCell,
  type CoverageGateway,
  type CoverageResult,
  type CoverageStats,
} from './coverage.js';
export {
  ARRIVE_EPS_PX,
  DEFAULT_UPDATE_INTERVAL_MS,
  INTERPOLATION_OVERSHOOT,
  MAX_CATCHUP_MULT,
  UpdateClock,
  WALK_PX_PER_SEC,
  pathLengthPx,
  paceForPath,
  type Point,
} from './walk-pacing.js';

// ─── 정적 데이터 (설계서 5.1) ───────────────────────────────────────────────

export type ZoneType =
  | 'waiting'
  | 'consult'
  | 'surgery'
  | 'laser'
  | 'recovery'
  | 'skincare'
  | 'reception'
  | 'staff'
  /**
   * 화장실·체인징룸. 원래 `etc` 였는데 갈라냈다 — 다른 손님 화면에서 숨겨야 하는데
   * `etc` 에는 ELEV.홀(숨기면 안 되는 통행 공간)이 같이 들어 있었다.
   * 이름으로 거르면 도면이 바뀔 때 조용히 썩는다 (`isPrivateRoom` 참고).
   */
  | 'toilet'
  | 'changing'
  | 'etc';

export type ZoneCategory = 'patient_area' | 'staff_area' | 'common';

/** 성별로 갈리는 방(화장실·체인징룸)에만 쓴다 — 나머지 방에는 없는 값이다 */
export type ZoneGender = 'male' | 'female';

export interface Zone {
  zoneId: string; // "waiting_1", "consult_1"
  name: string; // 도면 라벨 그대로 ("시술실 1")
  type: ZoneType;
  category: ZoneCategory;
  /** 도면 배경 이미지 픽셀 좌표 — 방 라벨 위치 (아바타/게이트웨이 기준점) */
  tilePosition: { x: number; y: number };
  socialEnabled: boolean; // 존 채팅 허용 여부
  /**
   * 이 방을 쓸 수 있는 성별 — 없으면(`공용화장실`) 누구나.
   *
   * **이름 문자열로 알아내지 않는다.** "여자화장실 1" 에서 '여자' 를 찾는 코드는 도면
   * 라벨이 '여성화장실' 로 바뀌는 날 조용히 죽는다 (`isPrivateRoom`·`isGuidableZone` 이
   * 종류·분류로 판정하는 것과 같은 이유). 설정에 적어 둔다.
   */
  forGender?: ZoneGender | null;
}

/** 이 방을 이 성별 손님이 쓸 수 있나 (공용은 둘 다 쓴다) */
export function zoneAllowsGender(zone: Zone, gender: ZoneGender): boolean {
  return zone.forGender == null || zone.forGender === gender;
}

/**
 * 환자를 데려다 놓을 수 있는 방인가 (직원용 「방 안내」 목적지 목록).
 *
 * 손으로 목록을 관리하면 방이 늘 때마다 조용히 썩는다 — 존 설정에 이미 있는
 * 분류로 정한다. 진료 관련 방 전부 + 대기공간 + 접수데스크.
 * 빠지는 것: 직원 구역, 화장실·체인징룸, ELEV.홀 — 안내할 일이 없다.
 * 복도는 애초에 존이 아니다(게이트웨이가 없어 '이동 중' 으로 잡힌다).
 */
export function isGuidableZone(zone: Zone): boolean {
  return (
    zone.category === 'patient_area' || zone.type === 'waiting' || zone.type === 'reception'
  );
}

/**
 * 환자가 **스스로** 안내를 걸 수 있는 방인가 (환자 앱의 `화장실` 버튼).
 *
 * 직원 손을 탈 이유가 없는 유일한 안내다 — 화장실은 물어서 가는 곳이 아니다
 * (액팅보드 설계 6.2). 그래서 직원 디스패치 목록({@link isGuidableZone})과
 * **서로 겹치지 않는 별개 목록**이다: 저쪽은 화장실을 일부러 뺀다.
 *
 * 직원 화장실은 빠진다 — 손님이 갈 곳이 아니다. 여기서도 이름 문자열이 아니라
 * 존 설정(`type`·`category`)으로 정한다: 화장실이 늘거나 줄 때 조용히 썩지 않게.
 */
export function isSelfGuidableZone(zone: Zone): boolean {
  return zone.type === 'toilet' && zone.category !== 'staff_area';
}

/**
 * 이 방에 있는 손님은 **다른 손님 화면에서 숨긴다** (환자용 화면 한정).
 *
 * 두 갈래다:
 * - `patient_area` — 진료·시술·회복·피부관리·촬영·탈의. 들어가 있다는 사실 자체가
 *   다른 환자에게 알려질 일이 아니다
 * - 화장실·체인징룸 — 분류상 `common` 이지만 프라이버시는 더 세다
 *
 * 그대로 보이는 곳: 대기공간·접수데스크·ELEV.홀·복도. 여럿이 같이 쓰는 공간이고,
 * 여기서까지 숨기면 "다른 사람이 보인다" 는 기능 자체가 없어진다.
 *
 * **존 설정으로 정한다 — 이름 문자열로 거르지 않는다.** 손으로 목록을 관리하면
 * 방이 늘 때 조용히 썩는다. 화장실·체인징룸에 `toilet`·`changing` 종류를 따로 준
 * 것도 그래서다 (`etc` 로 묶으면 ELEV.홀이 같이 걸린다).
 *
 * ⚠️ **직원용 패널·관제와는 무관하다.** 이 판정은 `/patient` 로 나가는 좌표에만 걸린다.
 *    직원은 전원을 봐야 한다 — 안 그러면 환자를 찾을 수 없다.
 */
export function isPrivateRoom(zone: Zone): boolean {
  return zone.category === 'patient_area' || zone.type === 'toilet' || zone.type === 'changing';
}

/**
 * 안내 지시 하나 — "이 비콘을 든 사람을 이 방으로".
 * 도착 판정은 서버가 한다(존 판정이 서버 것이라 화면 말을 믿을 이유가 없다).
 */
export interface Guidance {
  tagId: string;
  zoneId: string;
  /** 안내를 건 시각 (ms) — 오래된 안내를 화면에서 흐리게 하는 데 쓴다 */
  since: number;
}

/**
 * 안내가 끝난 사유.
 *
 * `moving` 만 진행 중이고 나머지는 종료 상태다. 끝난 사유를 하나로 뭉치지 않는 이유는
 * **알림 문구가 사유마다 다르기** 때문이다 — 도착은 관련 인원에게 알려야 하고, 해제는
 * 조용히 취소돼야 하고, `aborted` 는 애초에 알릴 사람이 없다.
 */
export type NavigationStatus =
  /** 진행 중 — 아직 도착도 해제도 안 됐다 */
  | 'moving'
  /** 목적지 방에 들어왔다 (서버 존 판정 기준) */
  | 'arrived'
  /** 직원이 안내를 풀었다 */
  | 'cancelled'
  /** 도착 전에 **다른 방으로** 목적지가 바뀌었다 (그 새 안내가 다음 줄로 남는다) */
  | 'superseded'
  /**
   * 끝을 볼 수 없게 된 안내 — 비콘 반납, 또는 서버 재시작으로 살아 있던 화살표가 사라짐.
   * 이 상태가 있어야 "영원히 이동 중" 인 줄이 표에 남지 않는다.
   */
  | 'aborted';

/**
 * 방 안내 한 건의 이력 (발행 → 도착/해제). 살아 있는 화살표(`Guidance`)와 달리
 * 재시작을 넘어 남는다 — 알림톡·대기시간 분석의 원본.
 */
export interface NavigationLog {
  id: number;
  tagId: string;
  personId: string | null;
  /** 발행 시점의 표시 이름 (보낸 메시지 내용이라 나중 개명에 따라 바뀌지 않는다) */
  personName: string | null;
  fromZone: string | null;
  toZone: string;
  issuedAt: number;
  arrivedAt: number | null;
  closedAt: number | null;
  status: NavigationStatus;
  travelSec: number | null;
}

/**
 * 도면에만 표시되는 라벨 — 존이 아니다(추적 대상 없음).
 * 도면 PDF 에 이름이 있지만 방이 아닌 것(가구·설비): 대기석, 직원PC, 서브데스크, 실외기실.
 */
export interface MapAnnotation {
  text: string; // 도면 라벨 그대로
  x: number; // 도면 이미지 픽셀 좌표
  y: number;
}

/** 도면 배경 이미지 메타 — 프론트가 이 이미지를 깔고 tilePosition 을 그 위에 매핑 */
export interface FloorplanMeta {
  image: string; // public/ 에 놓인 파일명
  width: number;
  height: number;
  /** 방 이름은 Zone.name 이 단일 출처 — 여기엔 존 아닌 라벨만 둔다 */
  annotations?: MapAnnotation[];
}

export interface Gateway {
  gatewayId: string; // MAC 또는 고유 ID
  zoneId: string; // 이 게이트웨이가 커버하는 존
  label: string; // "대기실-천장-A"
  /** 게이트웨이 설치 위치 (타일 좌표) — RSSI 가중평균 연속 위치 계산용 */
  tile?: { x: number; y: number };
}

/**
 * 비콘 묶음 — 직원 화면 왼쪽 목록의 그룹 탭. 운영자가 태그마다 지정한다.
 * 하드웨어로 자동 구분(iBeacon UUID·MAC 프리픽스)이 붙기 전까지의 단일 출처.
 */
export type TagGroup = 'doctor' | 'nurse' | 'interpreter' | 'patient' | 'unassigned';
export const TAG_GROUP_IDS: readonly TagGroup[] = [
  'doctor',
  'nurse',
  'interpreter',
  'patient',
  'unassigned',
];

/** 태그에 운영자가 붙인 이름/메모/그룹 (관제·직원 화면에서 tagId 대신 표시) */
export interface TagMeta {
  name?: string;
  memo?: string;
  group?: TagGroup;
}
export type TagMetaMap = Record<string, TagMeta>;

/**
 * 환자용 화면 캐릭터. 첫 진입 시 고르고 서버에 저장한다
 * (⚠️ 불변식 B-5: 브라우저 스토리지 금지 — 그래서 서버 보관).
 * 태그 반납 시 초기화되므로 다음 환자에게 남지 않는다.
 */
export const PATIENT_CHARACTERS = ['adam', 'alex', 'amelia', 'bob'] as const;
export type PatientCharacter = (typeof PATIENT_CHARACTERS)[number];

/**
 * 조합형 캐릭터 id — 파츠 이름 5개를 `|` 로 이은 것
 * (`몸|눈|옷|머리|장식`, 만드는 쪽은 web-patient/char-builder.ts).
 * 장식은 '없음' 이 정상이라 뒤 4칸은 비어 있어도 된다.
 *
 * ⚠️ 이 값은 화면에서 **파일 경로**(`charparts/<칸>/<이름>.png`)가 된다.
 *    글자를 영숫자·밑줄로 묶어 두는 것이 경로를 벗어나지 못하게 하는 유일한 장치다.
 */
const COMPOSED_CHAR_ID = /^\w{1,40}(\|\w{0,40}){4}$/;

/** 저장해도 되는 캐릭터 id 인가 (예전 고정 4종 + 조합형) */
export function isValidCharId(id: string): boolean {
  return PATIENT_CHARACTERS.includes(id as PatientCharacter) || COMPOSED_CHAR_ID.test(id);
}

export interface PatientProfile {
  charId: PatientCharacter | string;
  nickname: string | null;
}

/** RSSI 가중평균으로 추정한 연속 위치 (타일 좌표, 트래킹 시각화용) */
export interface PositionEstimate {
  tagId: string;
  x: number;
  y: number;
  zone: string | null; // 존 엔진의 현재 판정 (병행 표시용)
  /**
   * 방 사이(복도) 이동 중 — `PresenceState.inTransit` 과 같은 값.
   *
   * 존 전환 이벤트(presence:update)는 존이 **바뀔 때만** 나가는데 복도 진입은 존 변화가
   * 아니라서 그 채널로는 전달되지 않는다. 주기 좌표 방송에 실어 보낸다.
   */
  inTransit?: boolean;
}

export type PersonType = 'patient' | 'staff';
export type StaffRole = 'doctor' | 'nurse' | 'manager' | 'staff';

export interface TagAssignment {
  tagId: string; // 비콘 UUID 또는 MAC
  assignedTo: string; // personId
  personType: PersonType;
  assignedAt: number; // 접수 시각 (환자 대기시간 기산점)
  active: boolean;
}

export interface Person {
  personId: string;
  type: PersonType;
  displayName: string; // 환자는 익명 별칭 권장 ("환자 A")
  role?: StaffRole; // 직원 전용
  dept?: string;
}

// ─── 런타임 상태 (설계서 5.2) ───────────────────────────────────────────────

export interface PresenceState {
  tagId: string;
  currentZone: string | null; // null = 추적구역 벗어남(자리비움)
  lastSeen: number;
  enteredAt: number; // 현재 존 진입 시각
  candidateZone?: string; // 전환 판정 중인 후보존
  candidateCount?: number; // 후보존 연속 카운트 (채터링 방지)
  /**
   * 어느 방으로도 신호가 확실히 기울지 않음 = **방 사이(복도) 이동 중**.
   *
   * 복도에는 게이트웨이가 없어서 nearest-anchor 는 어쩔 수 없이 옆방 이름을 찍는다.
   * 그러면 복도에 서 있는 사람이 "시술실 2 체류 1분" 으로 뜬다(실제로 그랬다).
   * 방 한가운데면 한 게이트웨이가 압도적이고 복도면 양쪽이 비슷하다는 성질을 이용해,
   * 1·2위 존의 세기 차이(margin)가 작으면 이 플래그를 세운다.
   *
   * `currentZone` 은 그대로 최선의 추측을 유지한다 — 지도에 점은 찍어야 하므로.
   * 바뀌는 건 **표시와 체류 타이머**뿐이다.
   */
  inTransit?: boolean;
  /** inTransit 전환 판정 중인 연속 카운트 (내부용) */
  transitCount?: number;
}

export interface PresenceLog {
  id: number;
  tagId: string;
  personId: string;
  zoneId: string;
  enteredAt: number;
  exitedAt: number | null;
  durationSec: number | null;
}

// ─── Ingestion 표준 이벤트 (설계서 6.1) ─────────────────────────────────────

export interface ScanEvent {
  gatewayId: string;
  tagId: string;
  rssi: number; // dBm (음수, 클수록 가까움: -50 > -90)
  timestamp: number;
}

// ─── 존 액션 (설계서 6.4) ───────────────────────────────────────────────────

export type ZoneActionType = 'info' | 'reaction' | 'checkin' | 'faq';

export interface ZoneAction {
  actionId: string;
  zoneId: string;
  label: string;
  type: ZoneActionType;
}

// ─── WebSocket 프로토콜 (설계서 7) ──────────────────────────────────────────

/** namespace: /patient — 서버→클라 */
export interface PatientServerEvents {
  'presence:self': (p: { zone: string | null; waitingRank: number; estimatedWaitSec: number }) => void;
  'zone:occupancy': (p: { zoneId: string; anonymousCount: number }) => void;
  'zone:actions': (actions: ZoneAction[]) => void;
  'chat:message': (p: { alias: string; text: string; ts: number }) => void;
  reaction: (p: { alias: string; emoji: string; ts: number }) => void;
}

/** namespace: /patient — 클라→서버 */
export interface PatientClientEvents {
  'chat:send': (p: { text: string }) => void;
  'reaction:send': (p: { emoji: string }) => void;
  'action:invoke': (p: { actionId: string }) => void;
}

/** namespace: /staff — 서버→클라 */
export interface StaffServerEvents {
  'presence:update': (states: PresenceState[]) => void; // 권한 필터링된 대상만
  'presence:remove': (p: { tagId: string }) => void;
  'waittime:update': (p: { personId: string; zone: string; durationSec: number }) => void;
}

/** namespace: /staff — 클라→서버 */
export interface StaffClientEvents {
  'person:locate': (p: { personId: string }) => void;
  'filter:set': (p: { zoneId?: string; dept?: string }) => void;
}

/** JWT payload — role·dept·담당구역 claim (설계서 4) */
export interface AuthClaims {
  personId: string;
  type: PersonType;
  role?: StaffRole;
  dept?: string;
  chargeZones?: string[]; // 간호사 담당구역
}
