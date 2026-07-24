# 실내 위치추적 시스템 — 기술 설계서 (Claude Code 착수용)

> **문서 목적**: 이 문서는 개발 착수를 위한 기술 사양서입니다. 확정된 하드웨어 스펙과 시스템 구조를 기반으로, Claude Code가 프로젝트 스캐폴딩·핵심 모듈 구현을 바로 시작할 수 있도록 작성되었습니다.
>
> **한 줄 요약**: BLE 비콘(태그)을 지닌 환자·직원의 위치를 게이트웨이가 스캔 → 서버가 "존(구역) 단위"로 판정 → 권한별로 필터링해 웹 화면(2D 평면도)에 실시간 표시. 환자는 대기 관리·존 기반 상호작용, 직원은 위치 파악.

---

## 1. 프로젝트 개요

| 항목 | 내용 |
|---|---|
| 대상 현장 | 강남 고트의원 6F (약 160평, 530㎡) |
| 추적 대상 | 대기/시술 환자 약 70명, 직원 약 25명 (동시 최대치 기준) |
| 추적 구역(존) | 약 30개 (대기공간·상담실·시술실·회복실·직원공간 등) |
| 위치 정밀도 | **존(구역) 단위** — "몇 미터"가 아니라 "어느 방/구역에 있는가" |
| 핵심 목적 | ① 대기 환자 실시간 위치 + 대기시간 측정 ② 직원 위치 파악 ③ 환자용 대기 화면 + 존 기반 상호작용 |
| 배포 형태 | **온프레미스 폐쇄망** (외부 클라우드 미사용, 개인정보 보호) |
| 서버 | 사무용 PC 상시 가동 (고사양 불필요) |

---

## 2. 확정 하드웨어 스펙

### 2.1 게이트웨이 (존 수신기)
- **모델**: White BLE Gateway (gateway4)
- **기능**: BLE iBeacon 스캔 → 네트워크(Ethernet/WiFi) 브리지
- **통신**: Ethernet + WiFi 동시 지원
- **전원**: 5V DC / 2A (MINI-USB 어댑터 급전) — **⚠️ PoE 아님. 각 게이트웨이에 USB 전원 필요**
- **수신감도**: -96dBm
- **데이터 출력**: MQTT/HTTP 예상 (⚠️ **구매 시 판매자 확인 필요** — 아래 6.1의 ingestion 레이어는 이를 추상화하여 대응)
- **배치**: 존마다 1대 (넓은 존은 2대), 테스트로 실수량 확정

### 2.2 환자용 태그
- **모델**: DX-SMART CP35
- **프로토콜**: BLE 5.1, **iBeacon / Eddystone** (표준)
- **칩**: DA14531
- **방수**: IP67 (소독·재사용 가능)
- **배터리**: 교체형
- **송출거리**: ~70m
- **운영**: 접수 시 지급 → 호출 후 반납 → 소독 후 재사용

### 2.3 직원용 태그
- **모델**: Feasycom FSC-BP105N (카드형, NFC 겸용)
- **프로토콜**: BLE, **iBeacon / Eddystone** (표준)
- **방수**: IP66
- **송출거리**: ~400m (TX power 조절 가능 — 존 튜닝에 활용)
- **운영**: 명찰 클립형, 상시 착용

> **중요**: 태그는 브랜드가 달라도(DX + Feasycom) 모두 표준 iBeacon/Eddystone을 방송하므로 동일 파이프라인에서 처리됨. 게이트웨이는 UUID/MAC로 태그를 식별.

---

## 3. 시스템 아키텍처

```
┌─────────────┐   BLE advertising    ┌──────────────┐
│  태그(비콘)  │ ───────────────────> │  게이트웨이   │  (존별 1대+)
│ CP35/BP105N │   UUID + RSSI        │  gateway4    │
└─────────────┘                      └──────┬───────┘
                                            │ MQTT/HTTP (raw scan)
                                            ▼
                            ┌───────────────────────────────┐
                            │          서버 (사무용 PC)        │
                            │  ┌─────────────────────────┐  │
                            │  │ 1. Ingestion (MQTT sub)  │  │
                            │  ├─────────────────────────┤  │
                            │  │ 2. Zone Engine          │  │  ← 핵심
                            │  │   (nearest-anchor +     │  │
                            │  │    hysteresis)          │  │
                            │  ├─────────────────────────┤  │
                            │  │ 3. State Store + DB     │  │
                            │  │   (재실/입퇴실 로그)      │  │
                            │  ├─────────────────────────┤  │
                            │  │ 4. Permission Filter    │  │  ← 보안 핵심
                            │  ├─────────────────────────┤  │
                            │  │ 5. Social/Zone-object   │  │
                            │  │   (존 채팅·존 액션)       │  │
                            │  └─────────────────────────┘  │
                            └───────┬───────────────┬───────┘
                          WebSocket │               │ WebSocket
                        (namespace: │               │ (namespace:
                          /staff)   ▼               ▼   /patient)
                        ┌──────────────┐    ┌──────────────┐
                        │  직원용 화면   │    │  환자용 화면   │
                        │ Phaser 맵     │    │ Phaser 맵     │
                        │ 전체 위치     │    │ 본인+대기+채팅 │
                        └──────────────┘    └──────────────┘
```

### 설계 원칙 (반드시 준수)
1. **권한 필터링은 100% 서버에서.** 클라이언트로는 "그 사용자가 볼 수 있는 데이터"만 전송. 환자 소켓에는 타인의 위치 좌표가 네트워크로 나가지 않아야 함.
2. **환자용/직원용은 물리적으로 분리된 WebSocket namespace + 분리된 프론트 라우트.** 조건분기로 한 소켓에 섞지 않음.
3. **존 판정은 상대 비교(nearest-anchor)** — RSSI 절대값이 아니라 "어느 게이트웨이가 가장 세게 들었나".
4. **Ingestion 레이어로 게이트웨이 벤더 종속성 격리** — 게이트웨이 페이로드 포맷이 확정되면 어댑터만 교체.

---

## 4. 기술 스택 (권장)

| 레이어 | 기술 | 비고 |
|---|---|---|
| 런타임 | **Node.js (TypeScript)** | 실시간 이벤트 처리에 적합, 프론트와 언어 통일 |
| MQTT 브로커 | **Mosquitto** (로컬) | 게이트웨이 → 서버 수신. HTTP 방식이면 Express 엔드포인트로 대체 |
| MQTT 클라이언트 | `mqtt` (npm) | |
| 실시간 통신 | **Socket.IO** | namespace로 환자/직원 분리, room으로 존 채팅 구현 |
| DB | **SQLite** (시작) → 필요시 PostgreSQL | 온프레미스 경량. 입퇴실 로그·대기시간 |
| 인증 | **JWT** | role·dept·담당구역 claim |
| 프론트 | **Phaser 3** (2D 타일맵) + Vite | Gather 스타일 평면도 렌더링 |
| 맵 제작 | **Tiled** 에디터 | 병원 평면도 기반 타일맵(.tmj) |
| 프로세스 관리 | **PM2** | 사무용 PC에서 상시 가동·자동 재시작 |

> 개발 환경은 Windows(현재 개발 PC) 기준. PM2 + Windows 서비스 등록으로 부팅 시 자동 실행.

---

## 5. 데이터 모델

### 5.1 정적 데이터 (설정/마스터)

```typescript
// 존(구역) 정의 — 평면도 기반
interface Zone {
  zoneId: string;          // "waiting_main", "consult_1", "surgery_2"
  name: string;            // "메인 대기실", "상담실 1"
  type: 'waiting' | 'consult' | 'surgery' | 'laser' | 'recovery'
       | 'skincare' | 'reception' | 'staff' | 'etc';
  category: 'patient_area' | 'staff_area' | 'common';
  tilePosition: { x: number; y: number };  // Phaser 맵 좌표
  socialEnabled: boolean;  // 존 채팅 허용 여부 (대기실만 true 등)
}

// 게이트웨이 정의
interface Gateway {
  gatewayId: string;       // 게이트웨이 MAC 또는 고유 ID
  zoneId: string;          // 이 게이트웨이가 커버하는 존
  label: string;           // "대기실-천장-A"
}

// 태그 ↔ 사람 매핑 (분실·재배정 대응 위해 DB 관리)
interface TagAssignment {
  tagId: string;           // 비콘 UUID 또는 MAC
  assignedTo: string;      // personId
  personType: 'patient' | 'staff';
  assignedAt: number;      // 접수 시각 (환자 대기시간 기산점)
  active: boolean;
}

// 사람
interface Person {
  personId: string;
  type: 'patient' | 'staff';
  displayName: string;     // 환자는 익명 별칭 권장 ("환자 A")
  // 직원 전용
  role?: 'doctor' | 'nurse' | 'manager' | 'staff';
  dept?: string;
}
```

### 5.2 런타임 상태 (인메모리 + DB 로그)

```typescript
// 현재 위치 상태 (인메모리, 존 엔진이 갱신)
interface PresenceState {
  tagId: string;
  currentZone: string | null;   // null = 추적구역 벗어남(자리비움)
  lastSeen: number;             // 마지막 신호 수신 시각
  enteredAt: number;            // 현재 존 진입 시각
  candidateZone?: string;       // 전환 판정 중인 후보존
  candidateCount?: number;      // 후보존 연속 카운트 (채터링 방지)
}

// 입퇴실 로그 (DB 영구 저장 — 대기시간·동선 분석)
interface PresenceLog {
  id: number;
  tagId: string;
  personId: string;
  zoneId: string;
  enteredAt: number;
  exitedAt: number | null;
  durationSec: number | null;
}
```

---

## 6. 핵심 모듈 상세

### 6.1 Ingestion (게이트웨이 수신 어댑터)
게이트웨이 → 서버 raw 데이터를 **내부 표준 포맷으로 정규화**. 게이트웨이 페이로드 포맷이 미확정이므로 어댑터 패턴으로 격리.

```typescript
// 내부 표준 스캔 이벤트 (게이트웨이 벤더 무관)
interface ScanEvent {
  gatewayId: string;
  tagId: string;
  rssi: number;      // dBm (음수, 클수록 가까움: -50 > -90)
  timestamp: number;
}

// 어댑터 인터페이스 — gateway4 포맷 확정 시 이 구현체만 작성
interface GatewayAdapter {
  // MQTT 토픽 구독 또는 HTTP 수신 → ScanEvent[] 로 변환
  parse(rawPayload: unknown): ScanEvent[];
}
```

**MQTT 방식 가정** (판매자 확인 후 확정): 게이트웨이가 `gw/<gatewayId>/scan` 토픽으로 JSON 배열 publish → 서버가 구독 → `parse()` → ScanEvent 스트림.

### 6.2 Zone Engine (존 판정 — 시스템의 심장)
"가장 센 신호 게이트웨이 = 그 존". 단순 최댓값만 쓰면 존 경계에서 채터링(A↔B 깜빡임) 발생 → **히스테리시스 + N회 연속 확인**으로 안정화.

```typescript
// 튜닝 파라미터 (테스트로 실측 조정)
const CONFIG = {
  RSSI_WINDOW_MS: 3000,        // 이 시간 내 스캔만 유효
  HYSTERESIS_DB: 8,            // 새 존이 현재 존보다 이만큼 세야 전환 후보
  CONFIRM_COUNT: 3,            // 후보존이 연속 N회 최강일 때 전환 확정
  ABSENT_TIMEOUT_MS: 15000,    // 이 시간 신호 없으면 자리비움(null)
};

function updatePresence(tagId: string, scans: ScanEvent[]): void {
  // 1. RSSI_WINDOW 내 스캔만 필터, 게이트웨이별 최신 RSSI 취합
  const perGateway = latestRssiPerGateway(tagId, CONFIG.RSSI_WINDOW_MS);
  if (perGateway.length === 0) {
    markAbsentIfTimedOut(tagId);   // 신호 끊김 → null 처리
    return;
  }

  // 2. 가장 센 게이트웨이 → 그 게이트웨이의 zoneId
  const strongest = maxBy(perGateway, g => g.rssi);
  const bestZone = gatewayToZone(strongest.gatewayId);
  const state = getState(tagId);

  // 3. 최초 진입
  if (state.currentZone === null) {
    commitZone(tagId, bestZone);
    return;
  }

  // 4. 같은 존이면 유지
  if (bestZone === state.currentZone) {
    clearCandidate(tagId);
    return;
  }

  // 5. 다른 존 후보 → 히스테리시스 검사
  const currentRssi = rssiOfZone(perGateway, state.currentZone) ?? -999;
  const bestRssi = strongest.rssi;
  if (bestRssi - currentRssi < CONFIG.HYSTERESIS_DB) {
    clearCandidate(tagId);   // 차이 부족 → 전환 안 함
    return;
  }

  // 6. N회 연속 확인
  if (state.candidateZone === bestZone) {
    state.candidateCount = (state.candidateCount ?? 0) + 1;
    if (state.candidateCount >= CONFIG.CONFIRM_COUNT) {
      commitZone(tagId, bestZone);   // 전환 확정 → 로그 기록
    }
  } else {
    state.candidateZone = bestZone;
    state.candidateCount = 1;
  }
}

// commitZone: 이전 존 PresenceLog.exitedAt 기록 + 새 존 로그 시작
//             + 상태 갱신 + 이벤트 emit (→ 권한필터 → WebSocket)
```

> **채터링 방지가 이 프로젝트 체감 품질의 90%.** 특히 상담실 밀집구역(벽 얇음)에서 중요. 파라미터는 테스트로 조정.

### 6.3 Permission Filter (권한 필터 — 보안 핵심)
연결(소켓)마다 JWT로 권한을 알고, **볼 수 있는 대상만 직렬화해서 push**.

```typescript
// 권한 매트릭스 (정책은 법무·노무 검토 후 확정)
function visibleTargets(viewer: Person, all: PresenceState[]): PresenceState[] {
  switch (viewer.type === 'staff' ? viewer.role : 'patient') {
    case 'patient':
      // 환자: 타인 위치 안 보임. 본인 + 같은 존 "익명 인원 수"만
      return [selfOnly(viewer, all)];
    case 'nurse':
      // 간호사: 담당구역 환자 + 같은 과 직원
      return all.filter(p => inChargeArea(viewer, p) || sameDept(viewer, p));
    case 'doctor':
    case 'manager':
      return all;   // 전체 열람
    default:
      return [];
  }
}
```

**환자 화면의 "위치"는 트래킹이 아니라 대기 정보**임에 유의: 본인 현재 위치 / 대기순번 / 예상시간 / 같은 대기실 익명 인원수만. 타 환자 좌표는 절대 전송 금지.

### 6.4 Social / Zone-object (존 기반 상호작용)
BLE 존을 그대로 채팅방 경계로 재사용.

```typescript
// 존 진입 시 해당 존의 Socket.IO room에 join → 그 존 안에서만 채팅/이모티콘
// 존 이탈 시 leave (물리공간 = 소셜공간 일치)
socket.join(`zone:${zoneId}`);

// 존 액션(오브젝트): 존 진입 시 서버가 "이 존에서 가능한 액션" 목록 push
// 예: 대기실 → [대기순번보기, 이모티콘, FAQ], 접수 → [체크인]
interface ZoneAction {
  actionId: string;
  zoneId: string;
  label: string;
  type: 'info' | 'reaction' | 'checkin' | 'faq';
}
```

**1단계에서는 이모티콘/정형 리액션만**, 자유채팅은 모더레이션(금칙어·신고) 갖춘 뒤 오픈 권장. 채팅은 익명 별칭 기본.

---

## 7. WebSocket 프로토콜

### namespace: `/patient` (환자용)
```
서버→클라 이벤트:
  presence:self      { zone, waitingRank, estimatedWaitSec }
  zone:occupancy     { zoneId, anonymousCount }     // 같은 존 인원수(익명)
  zone:actions       ZoneAction[]                    // 존 진입 시 가능 액션
  chat:message       { alias, text, ts }             // 같은 존 room 한정
  reaction           { alias, emoji, ts }

클라→서버 이벤트:
  chat:send          { text }
  reaction:send      { emoji }
  action:invoke      { actionId }
```

### namespace: `/staff` (직원용)
```
서버→클라 이벤트:
  presence:update    PresenceState[]   // 권한 필터링된 대상만
  presence:remove    { tagId }         // 자리비움/이탈
  waittime:update    { personId, zone, durationSec }

클라→서버 이벤트:
  person:locate      { personId }      // 특정 인원 위치 조회
  filter:set         { zoneId? , dept? }
```

---

## 8. 프론트엔드 (Phaser 2D 맵)

- **맵**: 강남 고트의원 6F 평면도를 Tiled로 타일맵(.tmj) 제작. 각 존을 타일 영역으로 정의, `Zone.tilePosition`과 매핑.
- **아바타**: 태그 소지자 = 아바타. 존 변경 이벤트 수신 시 해당 존 타일로 tween(부드러운 이동). 채터링 방지가 서버에서 되므로 아바타 떨림 없음.
- **직원 화면**: 전체(권한 내) 아바타 표시. 존 클릭 → 인원 리스트 팝업. 존 색상 = 상태(빈방/사용중/대기).
- **환자 화면**: 본인 아바타 + 대기정보 HUD + 같은 존 채팅/이모티콘 UI + 존 액션 버튼. 타 환자 아바타 미표시.
- **공통**: 맵 리소스는 공유, 데이터 레이어(아바타 집합)만 namespace별로 분기.

> ⚠️ 브라우저 localStorage/sessionStorage 사용 금지 환경 대비 — 상태는 서버·메모리로 관리.

---

## 9. DB 스키마 (SQLite 시작)

```sql
CREATE TABLE zones (
  zone_id TEXT PRIMARY KEY, name TEXT, type TEXT, category TEXT,
  tile_x INTEGER, tile_y INTEGER, social_enabled INTEGER
);
CREATE TABLE gateways (
  gateway_id TEXT PRIMARY KEY, zone_id TEXT, label TEXT
);
CREATE TABLE tags (
  tag_id TEXT PRIMARY KEY, person_id TEXT, person_type TEXT,
  assigned_at INTEGER, active INTEGER
);
CREATE TABLE persons (
  person_id TEXT PRIMARY KEY, type TEXT, display_name TEXT,
  role TEXT, dept TEXT
);
CREATE TABLE presence_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tag_id TEXT, person_id TEXT, zone_id TEXT,
  entered_at INTEGER, exited_at INTEGER, duration_sec INTEGER
);
CREATE INDEX idx_logs_person ON presence_logs(person_id);
CREATE INDEX idx_logs_zone ON presence_logs(zone_id);
```

---

## 10. 프로젝트 구조 (제안)

```
rtls/
├─ packages/
│  ├─ server/
│  │  ├─ src/
│  │  │  ├─ ingestion/        # MQTT 구독 + GatewayAdapter
│  │  │  ├─ zone-engine/      # 존 판정 (6.2)
│  │  │  ├─ presence/         # 상태 저장 + DB 로그
│  │  │  ├─ permission/       # 권한 필터 (6.3)
│  │  │  ├─ social/           # 존 채팅·존 액션
│  │  │  ├─ ws/               # Socket.IO (/patient, /staff)
│  │  │  ├─ auth/             # JWT
│  │  │  ├─ db/               # SQLite
│  │  │  └─ config/           # 존·게이트웨이 매핑, 튜닝 파라미터
│  │  └─ package.json
│  ├─ web-staff/              # 직원용 Phaser 앱
│  ├─ web-patient/            # 환자용 Phaser 앱
│  └─ shared/                 # 공용 타입(ScanEvent, Zone 등)
├─ maps/                      # Tiled .tmj + 타일셋
└─ docker-compose.yml         # Mosquitto 등 (선택)
```

---

## 11. 단계별 빌드 플랜

**Phase 0 — 개념 검증 (하드웨어 도착 전, 동글로)**
- BLE 동글/노트북으로 CP35·BP105N 스캔 → RSSI 수집 스크립트
- Zone Engine(6.2) 로직을 목(mock) 스캔 데이터로 단위 테스트
- 히스테리시스·CONFIRM_COUNT 파라미터 기본값 검증

**Phase 1 — 실장비 연동 (게이트웨이 도착 후)**
- 게이트웨이 MQTT 포맷 확인 → GatewayAdapter 구현
- 게이트웨이 1~2대 + 태그로 실제 존 판정 검증
- **상담실 밀집구역 옆방 신호 새는 정도 실측 → 파라미터·TX power 튜닝**

**Phase 2 — 서버 코어**
- Ingestion → Zone Engine → Presence/DB → 입퇴실 로그·대기시간 측정
- JWT 인증 + Permission Filter
- Socket.IO namespace 분리(/patient, /staff)

**Phase 3 — 프론트**
- Tiled로 평면도 맵 제작
- 직원 화면(전체 위치) → 환자 화면(대기+본인)
- 존 색상·인원 팝업

**Phase 4 — 상호작용**
- 존 기반 이모티콘/리액션 (1차)
- 존 액션(대기순번·체크인 등)
- (후속) 모더레이션 갖춘 채팅

---

## 12. 열린 이슈 / 확인 필요

- [ ] **게이트웨이 MQTT/HTTP 페이로드 포맷** — 판매자 확인 후 GatewayAdapter 확정
- [ ] **게이트웨이 전원** — PoE 아님(5V USB). 30개소 급전 방식 확정 → 배선 설계 영향
- [ ] **권한 매트릭스 최종 정책** — 직원 상호 위치 노출 범위, 환자 노출 범위 (법무·노무 검토)
- [ ] **개인정보 처리방침·동의 절차** — 환자 위치=민감정보, 직원 위치=근로 이슈
- [ ] **환자 채팅 오픈 범위** — 이모티콘만 vs 자유채팅(모더레이션 필요)
- [ ] **게이트웨이 실수량** — 테스트로 존별 1대 vs 2대 확정
- [ ] 태그 ↔ 사람 매핑 등록 UX (접수 시 지급·반납 워크플로우)

---

## 부록 A. 확정 제품 링크
- 게이트웨이 (White BLE Gateway gateway4): https://ko.aliexpress.com/item/1005006653055448.html
- 환자 태그 (DX-SMART CP35): https://ko.aliexpress.com/item/1005011966080344.html
- 직원 카드 (Feasycom FSC-BP105N): https://ko.aliexpress.com/item/1005003182634073.html

## 부록 B. 핵심 설계 불변식 (구현 중 절대 위반 금지)
1. 환자 소켓으로 타 환자·직원의 위치 좌표를 전송하지 않는다 (서버 필터링).
2. 환자용/직원용 코드 경로·소켓을 분리한다.
3. 존 판정은 상대 RSSI 비교 + 히스테리시스로 채터링을 억제한다.
4. 게이트웨이 벤더 종속 코드는 Ingestion 어댑터 안에만 존재한다.
5. 브라우저 스토리지(localStorage 등)에 의존하지 않는다.
