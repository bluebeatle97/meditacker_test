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

## 테스트 (Phase 0 — Zone Engine 단위테스트)

```bash
npm test
```

히스테리시스·CONFIRM_COUNT·ABSENT_TIMEOUT 채터링 억제 로직을 목 스캔 데이터로 검증.

## 핵심 설계 불변식 (위반 금지 — 설계서 부록 B)

1. 환자 소켓으로 타 환자·직원의 위치 좌표를 전송하지 않는다 (서버 필터링 100%).
2. 환자용(/patient)/직원용(/staff) 코드 경로·소켓 namespace 를 분리한다.
3. 존 판정은 상대 RSSI 비교 + 히스테리시스로 채터링을 억제한다.
4. 게이트웨이 벤더 종속 코드는 `ingestion/adapters/` 안에만 둔다.
5. 브라우저 스토리지(localStorage 등)에 의존하지 않는다.

## 진행 상태 (설계서 11 빌드 플랜)

- [x] Phase 0 — 스캐폴딩 + Zone Engine 구현 + 목 데이터 단위테스트
- [ ] Phase 1 — 실장비 연동 (gateway4 MQTT 포맷 확정 → 어댑터 교체)
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
