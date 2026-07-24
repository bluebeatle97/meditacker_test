# MediTracker — BLE 실내 위치추적 시스템 (RTLS)

강남 고트의원 6F 대상. BLE 비콘(태그)을 지닌 환자·직원의 위치를 게이트웨이가 스캔 → 서버가 **존(구역) 단위**로 판정 → 권한별로 필터링해 웹 화면(2D 평면도)에 실시간 표시.

> 상세 사양: `docs/RTLS_기술설계서.md` 참조 (원본 설계서)

## 구조

```
meditracker/
├─ packages/
│  ├─ server/          # Node.js(TS) — Ingestion·Zone Engine·Presence·권한필터·Socket.IO
│  ├─ web-staff/       # 직원용 Phaser 앱 (전체 위치, 포트 5173)
│  ├─ web-patient/     # 환자용 Phaser 앱 (본인+대기정보, 포트 5174)
│  └─ shared/          # 공용 타입 (ScanEvent, Zone, WS 프로토콜 등)
├─ maps/               # Tiled 타일맵 (.tmj)
├─ mosquitto/          # MQTT 브로커 설정
└─ docker-compose.yml  # Mosquitto
```

## 시작하기

```bash
npm install

# 1. MQTT 브로커 (Docker) — 또는 mosquitto 네이티브 설치
docker compose up -d

# 2. 서버 (포트 8080, ws: /patient, /staff)
npm run dev:server

# 3. 목 게이트웨이로 E2E 검증 (하드웨어 없이)
npm run mock:gw -w @meditracker/server

# 4. 프론트
npm run dev:staff     # http://localhost:5173
npm run dev:patient   # http://localhost:5174
```

### 실시간 관제 페이지 (하드웨어 디버깅/튜닝)

서버만 켜져 있으면 **`http://localhost:8080/monitor`** 로 바로 열린다 (서버 자체 서빙, 별도 Vite·CDN 불필요 — 폐쇄망 대응). 직원용 패널 우상단 **⚙ 관리자 모드** 버튼으로도 진입하고, 관제 페이지 **← 직원용 패널로** 버튼으로 복귀한다.

보여주는 것 (Phase 1 현장 튜닝의 핵심):
- **게이트웨이별 스캔 수신 상태** — 모든 게이트웨이가 온라인인지, 초당 몇 건 들어오는지
- **태그별 게이트웨이 RSSI** (센 순 정렬) — 존 판정의 원재료를 그대로 노출
- **실시간 스캔 피드** — gateway·tag·RSSI·시각 (어댑터 동작·신호세기 확인)
- **존 전환 로그** — 채터링 여부 확인

> ⚠️ 관제 페이지는 운영자 전용. 태그 위치 전부를 노출하므로 환자망 분리·인증 게이팅 후 배포.

## 테스트 (Phase 0 — Zone Engine 단위테스트)

```bash
npm test
```

히스테리시스·CONFIRM_COUNT·ABSENT_TIMEOUT 채터링 억제 로직을 목 스캔 데이터로 검증.

## 하드웨어 테스트 절차 (Phase 1 — 실장비 도착 후)

목(mock) 검증이 끝난 상태에서 실제 gateway4 + CP35/BP105N 태그를 연동하는 순서.
**게이트웨이 페이로드 포맷 확인(1단계)이 가장 중요** — 설계서 12장의 최대 미확정 항목이다.

### 0. 개봉 직후 — 태그 확인 (게이트웨이 없이)

노트북/폰 BLE 스캐너로 태그가 광고하는 **UUID/MAC** 을 먼저 확인한다. 이 값이 `tags` 테이블의 태그 ID가 된다.

- 도구: **nRF Connect**(모바일) 또는 Windows **Bluetooth LE Explorer**
- CP35(환자)·BP105N(직원) 각각 켜서 잡히는 MAC / iBeacon UUID 기록
- **태그 광고 주기(advertising interval)** 설정 가능 여부 확인 → 트래킹 반응속도 상한을 결정

### 1. 게이트웨이 페이로드 포맷 확인 ⭐

gateway4 가 MQTT 인지 HTTP 인지, JSON 구조가 뭔지 실물로 확인한다.

```bash
# 1) 브로커 기동 (로컬 aedes 또는 운영용 Mosquitto)
npm run dev:broker -w @meditracker/server

# 2) 게이트웨이 설정 화면에서 브로커 주소 = 이 PC IP:1883 지정

# 3) 스니퍼로 raw 토픽/페이로드 그대로 덤프
npm run sniff -w @meditracker/server
```

찍힌 페이로드 몇 줄을 근거로 `packages/server/src/ingestion/adapters/` 에 **실제 어댑터**를 작성한다
(현재는 `GenericJsonAdapter` 가정치). Zone Engine 이하는 손대지 않는다 — 불변식 4.

> 게이트웨이가 MQTT 미지원, HTTP POST 만 되면 → 브로커 대신 서버에 수신 엔드포인트 추가.
> 어댑터 패턴이라 파이프라인 나머지는 그대로.

### 2. 존 매핑 + 1~2대로 판정 검증

- `packages/server/src/config/gateways.json` 의 `gatewayId` 를 **실제 게이트웨이 MAC** 으로 교체
- `zoneId` / `tile`(설치 타일좌표)을 실제 배치대로 수정
- 게이트웨이 1~2대 + 태그 1개로 존 판정 확인 (`curl localhost:8080/health`, 직원 화면)

### 3. 현장 튜닝 ⭐ (체감 품질의 90%)

**상담실 밀집 구역(벽 얇음)에서 옆방 신호가 새는 정도**를 실측하고 `config/index.ts` 파라미터 조정.
연속 위치 시각화(`pos:update`, 직원 화면)로 아바타가 실제로 어디로 끌려가는지 보면서 튜닝한다.

| 증상 | 조정 |
|---|---|
| 존 경계에서 아바타 깜빡임 (A↔B) | `HYSTERESIS_DB` ↑ (8→12), `CONFIRM_COUNT` ↑ |
| 존 이동 반응이 느림 | `CONFIRM_COUNT` ↓, 태그 광고 주기 ↓ |
| 옆방 신호가 너무 셈 | 직원 태그 **TX power 낮추기**(BP105N), 게이트웨이 위치 조정 |
| 자꾸 자리비움 뜸 | `ABSENT_TIMEOUT_MS` ↑ |

### 4. 게이트웨이 실수량 확정

존별 1대 vs 2대를 3번 실측으로 결정. 넓은 대기실은 2대 필요 가능성 높음.

> ⚠️ **전원**: gateway4 는 PoE 아님 — 5V USB 급전. 30개소 배선이 별도 이슈이니 설치 일정에 미리 반영 (설계서 12장, 소프트웨어 무관).

## 핵심 설계 불변식 (위반 금지 — 설계서 부록 B)

1. 환자 소켓으로 타 환자·직원의 위치 좌표를 전송하지 않는다 (서버 필터링 100%).
2. 환자용(/patient)/직원용(/staff) 코드 경로·소켓 namespace 를 분리한다.
3. 존 판정은 상대 RSSI 비교 + 히스테리시스로 채터링을 억제한다.
4. 게이트웨이 벤더 종속 코드는 `ingestion/adapters/` 안에만 둔다.
5. 브라우저 스토리지(localStorage 등)에 의존하지 않는다.

## 진행 상태 (설계서 11 빌드 플랜)

- [x] Phase 0 — 스캐폴딩 + Zone Engine 구현 + 목 데이터 단위테스트
- [ ] Phase 1 — 실장비 연동 (sniff 로 gateway4 포맷 확정 → 어댑터 교체 → 현장 튜닝) · 절차는 위 "하드웨어 테스트 절차"
- [ ] Phase 2 — 대기열·JWT 로그인·태그 지급/반납 워크플로우
- [ ] Phase 3 — Tiled 평면도 맵 + 아바타 렌더링
- [ ] Phase 4 — 존 이모티콘·존 액션·(후속) 모더레이션 채팅

## 튜닝 파라미터 (현장 실측으로 조정)

`packages/server/src/config/index.ts` — `ZONE_ENGINE_CONFIG`

| 파라미터 | 기본값 | 의미 |
|---|---|---|
| `RSSI_WINDOW_MS` | 3000 | 이 시간 내 스캔만 유효 |
| `HYSTERESIS_DB` | 8 | 새 존이 현재 존보다 이만큼 세야 전환 후보 |
| `CONFIRM_COUNT` | 3 | 후보존 연속 N회 최강 시 전환 확정 |
| `ABSENT_TIMEOUT_MS` | 15000 | 무신호 시 자리비움 처리 |
