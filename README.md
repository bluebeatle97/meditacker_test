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

### 환자용 패널 (도트 그래픽)

직원용은 **실제 도면**을 그대로 쓰고(위치 정확성), 환자용은 같은 층을 **타일 도트맵**으로 다시 그린다 (포켓몬 골드류 타일 탑뷰 — 카메라가 본인 캐릭터를 따라가고, 화면 폭에 타일 14칸쯤 보이게 정수배 줌).

직원용 패널 우측 **🎮 환자용 패널** 버튼으로 진입한다 (별 앱이라 새 탭 · 기본 `http://localhost:5174`, `VITE_PATIENT_URL` 로 변경).

배경은 커밋된 생성물이고, 도면·통제구역이 바뀌면 다시 만든다:

```bash
python tools/build-pixel-map.py "<Modern tiles_Free 폴더>"
```

- 타일 1칸(16px) = 도면 32px ≈ **52cm**. 이 축척이 캐릭터(16×32 = 두 칸 키 ≈ 104cm)와 맞아야 도트맵으로 보인다 — 더 잘게 잡으면 바닥 무늬가 캐릭터보다 커진다.
- 방 구분은 좌표 추측이 아니라 `walkable.json` 에서 **방 사각형 실측**(`pathfinder.roomBoxAt` 과 같은 방식). 연결영역 BFS 는 문으로 색이 번져서 못 쓴다.
- 첫 진입 시 캐릭터를 고른다. 선택값은 **서버**(`patient_profiles`)에 저장한다 — 불변식 B-5(브라우저 스토리지 금지) 때문. 태그 반납(`releaseTag`) 시 초기화된다.

> ⚠️ **에셋 라이선스**: 지금 쓰는 LimeZu *Modern Interiors* 는 **무료판 = 비상업 프로젝트 전용**이다. 실제 병원 운영에 올리려면 유료(전체)판을 구매해야 한다 — 타일·가구 종류도 훨씬 많아진다. `packages/web-patient/public/characters/ASSET-LICENSE.txt` 참고.

### 실시간 관제 페이지 (하드웨어 디버깅/튜닝)

서버만 켜져 있으면 **`http://localhost:8080/monitor`** 로 바로 열린다 (서버 자체 서빙, 별도 Vite·CDN 불필요 — 폐쇄망 대응). 직원용 패널 우상단 **⚙ 관리자 모드** 버튼으로도 진입하고, 관제 페이지 **← 직원용 패널로** 버튼으로 복귀한다.

보여주는 것 (Phase 1 현장 튜닝의 핵심):
- **게이트웨이별 스캔 수신 상태** — 모든 게이트웨이가 온라인인지, 초당 몇 건 들어오는지
- **태그별 게이트웨이 RSSI** (센 순 정렬) — 존 판정의 원재료를 그대로 노출
- **실시간 스캔 피드** — gateway·tag·RSSI·시각 (어댑터 동작·신호세기 확인)
- **존 전환 로그** — 채터링 여부 확인

> ⚠️ 관제 페이지는 운영자 전용. 태그 위치 전부를 노출하므로 환자망 분리·인증 게이팅 후 배포.
> `/monitor`·`/tag-meta`·`/unknown-tags`·`/register-tag` 는 아직 **무인증**이다 — 한 번에 staff 토큰 뒤로 옮길 것.

### 태그 화이트리스트 (등록된 비콘만 추적)

**게이트웨이는 주변 BLE 광고를 가리지 않고 전부 올린다.** 우리 비콘뿐 아니라 환자·보호자 폰,
이어버드, 스마트워치, 옆 층 사람까지. 게다가 iOS·Android 는 프라이버시 때문에 **MAC 을 15분마다
바꾼다** — 폰 한 대가 하루에 서로 다른 식별자를 100개 가까이 만든다.

거르지 않으면 (1) 상태 Map 이 며칠 만에 수천 개로 불어나 서버가 죽고, (2) 직원 화면이 회색 유령
아바타로 덮이고, (3) **동의하지 않은 사람의 단말 식별자와 이동경로를 수집**하게 된다.

그래서 `tags` 테이블에 등록된 태그만 통과시킨다 (`ScanRouter`). **기본 on** — 끄려면 명시적으로
`TAG_WHITELIST=0` (디버깅 전용).

**비콘 등록** — 관제 페이지 좌상단 **미등록 신호** 패널:

1. 그룹(환자/의사/간호사/통역) + 이름 접두어를 한 번 정한다
2. 비콘을 아무 게이트웨이 코앞에 갖다 댄다 → RSSI 가 세져서 목록 맨 위로 올라온다
3. **등록** 클릭 → 그 즉시 추적 시작. 이름 번호는 자동 증가하므로 다음 비콘은 클릭 한 번

> 장비 도착 첫날 비콘 100개를 이 화면으로 올린다 (30분이면 끝난다). 미등록 ID 는 개수 200개·수명
> 60초로 제한된 임시 버퍼에만 담기고 판정·좌표·로그 어디에도 들어가지 않는다.

로컬에서 이 상황을 재현하려면 목 게이트웨이 노이즈 모드를 쓴다:

```bash
# 등록 안 된 남의 단말 30대를 섞어 쏜다 (MAC 은 주기적으로 교체)
MOCK_NOISE_MACS=30 npm run mock:gw -w @meditracker/server

# 이미 돌고 있는 스택을 안 건드리고 노이즈만 겹쳐 던지기
MOCK_NOISE_ONLY=1 MOCK_NOISE_MACS=30 MOCK_SPEED=60 npm run mock:gw -w @meditracker/server
```

`curl localhost:8080/health` 의 `scans.droppedScans` 가 올라가고 `tags` 는 그대로면 정상이다.

### 스캔 녹화 → 리플레이 (파라미터 튜닝) ⭐

파라미터 하나 바꾸려고 매번 복도를 걷지 않는다. **한 번 녹화해두고 오프라인에서 수십 가지를 몇 초에**
돌린다. 같은 입력이라 비교가 성립한다 — 매번 걷는 속도·경로가 다르면 애초에 비교가 안 된다.

```bash
# 1) 녹화하며 서버 기동 → data/recordings/walk-1.ndjson
RECORD_SCANS=walk-1 npm run dev:server

# 2) 비콘 들고 걸으면서, 방을 옮길 때마다 관제 페이지 "정답 마크" 에서 지금 방을 찍는다
#    (이 마크가 채점 기준. 없으면 재생은 되는데 좋아졌는지 나빠졌는지 알 수 없다)

# 3) 현재 파라미터로 채점
npm run replay -w @meditracker/server -- walk-1

# 4) 격자 탐색 — 36조합이 3초
npm run replay -w @meditracker/server -- walk-1 --grid --hys 4,6,8,12 --confirm 2,3,4 --window 2000,3000,5000
```

출력: **정확도**(정답과 일치한 시간 비율) · **전환지연**(음수면 마크보다 먼저 바뀜) · **오탐** · **놓침** · 전환 횟수.

- 재생은 서버와 **같은 루프**로 돈다 (수신값을 쌓고 `zoneEvalIntervalMs` 주기로 묶어 평가 + 자리비움
  스윕). 안 그러면 여기서 좋게 나온 값이 실제 서버에서 다르게 동작한다.
- 녹화 파일 첫 줄에 **그때의 게이트웨이→존 매핑**을 박아둔다. 나중에 게이트웨이를 옮겨도 옛 녹화가
  그대로 재생된다.
- 마크 앞뒤 5초는 관용 범위다 — 사람이 버튼을 누르는 시차도 있고, 신호는 문을 통과하기 **전부터**
  옆방으로 기울기 때문. 이걸 안 두면 멀쩡한 설정이 전부 낙제한다.
- 녹화 파일은 그대로 **회귀 테스트**가 된다. 판정 로직을 고친 뒤 같은 파일로 "정확도 87%→94%" 를
  숫자로 보일 수 있다.

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

### 2.5. 비콘 100개 등록

게이트웨이가 붙는 순간 주변 BLE 가 전부 들어오지만 **화이트리스트가 기본 on 이라 아무것도 안 뜬다.**
이게 정상이다 — 관제 페이지 **미등록 신호** 패널에서 비콘을 하나씩 등록한다 (위 "태그 화이트리스트").

게이트웨이 자체에 MAC 프리픽스/UUID 필터가 있으면 같이 켠다 (와이파이 대역폭·게이트웨이 CPU 절약).
다만 게이트웨이 필터는 30대 각각의 설정이라 한 대만 교체·초기화돼도 조용히 구멍이 된다 —
**서버 화이트리스트가 보안 경계이고 게이트웨이 필터는 최적화**다. 둘 다 켠다.

### 3. 현장 튜닝 ⭐ (체감 품질의 90%)

**한 번 걷고 녹화해서 오프라인에서 돌린다** — 위 "스캔 녹화 → 리플레이" 참고. 눈으로 보며 파라미터를
바꾸는 방식은 조합당 10분씩 걸리고, 매번 걷는 속도가 달라 비교 자체가 신뢰할 수 없다.

**상담실 밀집 구역(벽 얇음)에서 옆방 신호가 새는 정도**를 실측하고 `config/index.ts` 파라미터 조정.
연속 위치 시각화(`pos:update`, 직원 화면)로 아바타가 실제로 어디로 끌려가는지 보면서 확인한다.

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
| `EVICT_AFTER_MS` | 600000 | 무신호 시 상태를 **메모리에서 삭제** (자리비움과 다름 — 반납·이탈 태그 정리) |

환경변수: `TAG_WHITELIST=0` (화이트리스트 해제, 디버깅 전용) · `RECORD_SCANS=<이름>` (스캔 녹화) ·
`ZONE_EVAL_MS` (판정 주기, 기본 200) · `PATIENT_SEES_EVERYONE=0` (환자 화면에서 타인 좌표 차단)
