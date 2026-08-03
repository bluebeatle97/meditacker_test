/**
 * 데모 배포용 **단일 프로세스** 실행 — 하드웨어 없이 통째로 띄운다.
 *
 *   npm run start:demo
 *
 * `tools/dev-all.mjs` 는 프로세스를 5개 띄우지만, 무료 호스팅(Render·Railway 등)은
 * 컨테이너당 프로세스 하나에 포트 하나만 준다. 그래서 여기서는 브로커·시드·서버·목
 * 게이트웨이를 **한 프로세스 안에서** 순서대로 올린다.
 *
 * 각 모듈은 import 되는 순간 동작을 시작한다(스크립트로 쓰이도록 만들어졌다).
 * 따라서 순서 자체가 곧 기동 순서다:
 *
 *   1) MQTT 브로커  — 목 게이트웨이가 붙을 곳
 *   2) 시드         — 태그 화이트리스트가 켜져 있어 등록 안 하면 전부 걸러진다
 *   3) 서버         — DB·존엔진·소켓·화면 서빙
 *   4) 목 게이트웨이 — 가상 환자·직원이 도면을 걸어다니게 만드는 신호원
 *
 * ⚠️ 시연 전용이다. `/dev-token` 이 살아 있어 링크를 아는 사람은 누구나 전원의 위치를
 *    본다. 실제 환자 데이터에는 절대 쓰지 말 것 (Phase 2 로그인 후에나 가능).
 */

export {}; // 정적 import 가 없어도 모듈로 취급되게 (최상위 await 를 쓴다)

// 브로커도 이 프로세스 안에 있으므로 루프백으로 붙는다 (호스트에서 열어 줄 필요 없음)
process.env.MQTT_URL ??= 'mqtt://127.0.0.1:1883';

console.log('[demo] 1/4 MQTT 브로커');
await import('./dev-broker.js');

console.log('[demo] 2/4 목 태그 시드 (이름·그룹·화이트리스트 등록)');
await import('./dev-seed.js');

console.log('[demo] 3/4 서버');
await import('../index.js');

console.log('[demo] 4/4 목 게이트웨이 — 가상 인원이 걸어다니기 시작');
await import('./mock-gateway.js');
