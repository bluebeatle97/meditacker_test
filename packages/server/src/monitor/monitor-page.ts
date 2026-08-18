/**
 * 자체 서빙 모니터링 페이지 (GET /monitor).
 * socket.io 클라이언트는 서버가 자동 제공하는 /socket.io/socket.io.js 사용 — CDN 불필요(폐쇄망).
 */
export function monitorPageHtml(): string {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>MediTracker — 실시간 관제</title>
<style>
  :root {
    --bg: #0d1117; --panel: #161b22; --border: #30363d; --text: #c9d1d9;
    --muted: #8b949e; --accent: #58a6ff; --ok: #3fb950; --warn: #d29922; --bad: #f85149;
    --mono: ui-monospace, "Cascadia Code", "Consolas", monospace;
  }
  * { box-sizing: border-box; }
  /* 진입 핀 — 소켓에 붙기 전까지 화면을 덮는다 */
  #gate {
    position: fixed; inset: 0; z-index: 100; background: rgba(13, 17, 23, 0.94);
    display: flex; align-items: center; justify-content: center;
  }
  #gate[hidden] { display: none; }
  .gate-box {
    width: 280px; padding: 22px; background: var(--panel);
    border: 1px solid var(--border); border-radius: 10px; text-align: center;
  }
  .gate-box h2 { margin: 0 0 6px; font-size: 15px; }
  .gate-box p { margin: 0 0 14px; color: var(--muted); font-size: 12px; line-height: 1.5; }
  /* 입력창과 버튼은 **같은 폭·같은 높이**여야 한다. 한쪽이 삐져나오면 상자가 어긋나 보인다 */
  #gate-pin,
  #gate-ok {
    display: block; width: 100%; height: 38px; border-radius: 6px;
    font-family: var(--mono); font-size: 14px;
  }
  #gate-pin {
    padding: 0 10px; text-align: center; letter-spacing: 4px;
    background: var(--bg); color: var(--text); border: 1px solid var(--border);
  }
  #gate-ok {
    margin-top: 10px; cursor: pointer;
    border: 1px solid #4d5b8a; background: #1b2136; color: #b9c4e6;
  }
  /* 메시지 칸은 높이를 고정한다 — 글이 생겼다 없어질 때 상자가 들썩이면 안 된다 */
  #gate-msg { height: 18px; margin-top: 10px; font-size: 12px; color: var(--bad); }
  body { margin: 0; background: var(--bg); color: var(--text); font-family: var(--mono); font-size: 13px; }
  header {
    display: flex; align-items: center; gap: 20px; padding: 10px 16px;
    background: var(--panel); border-bottom: 1px solid var(--border); position: sticky; top: 0; z-index: 10;
  }
  header h1 { font-size: 15px; margin: 0; font-weight: 600; }
  .stat { color: var(--muted); }
  /* 테스트 장비 스위치 — 켠 상태가 '평소와 다름'(가짜가 섞였다) 이라 붉게 */
  #testgear-btn { border: 1px solid #4d5b8a; background: #1b2136; color: #b9c4e6; }
  #testgear-btn.on { border-color: #a84b3d; background: #33130f; color: #ffb3a7; }
  .stat b { color: var(--text); font-variant-numeric: tabular-nums; }
  #dot { width: 9px; height: 9px; border-radius: 50%; background: var(--bad); display: inline-block; margin-right: 6px; }
  #dot.on { background: var(--ok); }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; padding: 12px; align-items: start; }
  .panel { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
  .panel > h2 {
    font-size: 12px; text-transform: uppercase; letter-spacing: .5px; color: var(--muted);
    margin: 0; padding: 8px 12px; border-bottom: 1px solid var(--border); background: #1c2128;
  }
  .panel > .body { padding: 8px 12px; }
  .feed { max-height: 42vh; overflow-y: auto; }
  .feed .row { display: flex; gap: 8px; padding: 2px 0; white-space: nowrap; border-bottom: 1px solid #21262d; }
  /* 피드도 막대 길이를 눈으로 훑는 화면이라 시작점이 줄마다 달라지면 못 읽는다.
     시각·게이트웨이·dBm 은 글자수가 일정한데 이름만 들쭉날쭉하므로 그 칸만 고정하고,
     flex 가 남은 폭에 맞춰 칸을 줄이지 못하게 막는다. */
  .feed .row > span { flex: none; }
  .feed .tag { width: 80px; overflow: hidden; text-overflow: ellipsis; }
  /* 존 전환 로그: 방 이름 길이가 제각각이라 화살표가 줄마다 다른 자리에 선다.
     출발·도착 칸을 같은 폭으로 묶으면 화살표가 한 줄로 서서 훑기 쉬워진다. */
  .feed .zfrom, .feed .zto { width: 92px; overflow: hidden; text-overflow: ellipsis; }
  .feed .t { color: var(--muted); }
  .gw { color: var(--accent); }
  .tag { color: #e3b341; }
  .rssi-bar { display: inline-block; height: 8px; border-radius: 2px; vertical-align: middle; }
  table { width: 100%; border-collapse: collapse; }
  td, th { text-align: left; padding: 3px 6px; border-bottom: 1px solid #21262d; }
  th { color: var(--muted); font-weight: 500; }
  /* 숫자는 자릿수가 달라도 자리를 지키게 (13382 와 9 가 같은 폭을 쓴다) */
  td { font-variant-numeric: tabular-nums; }
  /* 게이트웨이 표는 칸 폭을 내용에 맡기지 않는다. 라벨·방 이름 길이가 바뀔 때마다
     열이 통째로 움직이면, 1초마다 다시 그려지는 표에서는 글자가 흔들리는 것처럼 보인다. */
  #gw-table { table-layout: fixed; }
  #gw-table th:nth-child(1), #gw-table td:nth-child(1) { width: 148px; }
  #gw-table th:nth-child(3), #gw-table td:nth-child(3) { width: 188px; }
  #gw-table th:nth-child(4), #gw-table td:nth-child(4) { width: 66px; }
  #gw-table th:nth-child(5), #gw-table td:nth-child(5) { width: 52px; }
  #gw-table td { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* 방 이름이 남은 폭을 다 먹게 해서 버튼을 열 오른쪽 끝에 고정한다 */
  .zonecell { display: flex; align-items: center; gap: 6px; }
  .zonecell > .zname { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .zonecell > select { flex: 1; min-width: 0; }
  .card { border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; margin-bottom: 8px; }
  /* 카드 머리줄: 이름 길이가 제각각이라(딸기 / 사원1 / 검증용 비콘) space-between 으로 두면
     그룹·구역·버튼이 줄마다 다른 자리에 선다. 1초마다 다시 그려지는 화면이라 그 어긋남이
     그대로 흔들림으로 보인다. 칸 폭을 고정해 세로로 줄을 맞춘다 (피드·게이트웨이 표와 같은 처리). */
  .card .hd { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .card .hd > * { flex: none; }
  .card .hd .tag { width: 92px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .card .hd .grp { width: 52px; text-align: center; }
  /* 가장 긴 방 이름이 'VIP 피부관리실 1'(11자) — 96px 면 대부분 들어가고, 넘치면 title 로 본다 */
  .card .hd .badge { width: 96px; text-align: center; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* 최근 수신 시각은 오른쪽 끝에 붙이고, 숫자가 늘어도(0s → 12s) 버튼이 안 밀리게 폭을 준다 */
  .card .hd .age { margin-left: auto; width: 62px; text-align: right; }
  .badge { padding: 1px 7px; border-radius: 10px; font-size: 11px; }
  .badge.zone { background: #1f6feb33; color: var(--accent); }
  .badge.absent { background: #f8514933; color: var(--bad); }
  .muted { color: var(--muted); }
  .empty { color: var(--muted); padding: 16px; text-align: center; }
  .edit { background: none; border: 1px solid var(--border); color: var(--muted); border-radius: 4px;
          cursor: pointer; font: 11px var(--mono); padding: 1px 6px; }
  .edit:hover { color: var(--accent); border-color: var(--accent); }
  .memo { color: var(--warn); font-size: 12px; margin: 2px 0 6px; white-space: pre-wrap; }
  /* 그룹 칩 — 색은 직원 화면 tag-panel.ts 의 GROUPS 와 같은 값을 쓴다 (두 화면이 달라 보이면 안 된다) */
  .grp { font-size: 11px; padding: 1px 6px; border-radius: 999px; color: #0d1117; font-weight: 700; }
  /* 이름/메모/그룹 편집 — 카드 밖에 띄운다. 카드는 1초마다 통째로 다시 그려져서
     그 안에 select 를 두면 고르는 도중에 사라진다. */
  #edit-back {
    position: fixed; inset: 0; background: #000a; z-index: 50;
    display: none; align-items: center; justify-content: center;
  }
  #edit-back.show { display: flex; }
  #edit-box {
    width: 340px; padding: 16px; border-radius: 10px;
    background: var(--panel); border: 1px solid var(--border);
  }
  #edit-box h3 { margin: 0 0 2px; font-size: 14px; }
  #edit-box .rawid { margin-bottom: 12px; }
  #edit-box label { display: block; margin: 10px 0 3px; color: var(--muted); font-size: 12px; }
  #edit-box input, #edit-box select {
    width: 100%; padding: 6px 8px; border-radius: 6px;
    background: var(--bg); border: 1px solid var(--border); color: var(--text);
    font-family: var(--mono); font-size: 13px;
  }
  #edit-box .req { color: var(--bad); }
  #edit-box #edit-sig { font-size: 12px; margin-bottom: 4px; }
  .warn-line { min-height: 16px; margin-top: 8px; color: var(--warn); font-size: 12px; }
  #edit-box .row { display: flex; gap: 8px; margin-top: 8px; }
  #edit-save:disabled { background: var(--border); color: var(--muted); cursor: not-allowed; }
  #edit-box button { flex: 1; padding: 7px; border-radius: 6px; cursor: pointer; font-family: var(--mono); }
  #edit-save { background: var(--accent); border: none; color: #04121f; font-weight: 700; }
  #edit-cancel { background: transparent; border: 1px solid var(--border); color: var(--text); }
  .rawid { color: var(--muted); font-size: 10px; }
  #back-btn {
    margin-left: auto; padding: 8px 14px; border: 1px solid var(--accent); border-radius: 6px;
    background: #1c2b45; color: var(--accent); font: 600 13px var(--mono); cursor: pointer; text-decoration: none;
  }
  #back-btn:hover { background: #234; }
  .bar { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-bottom: 8px; }
  .bar select, .bar input {
    background: #0d1117; border: 1px solid var(--border); color: var(--text);
    border-radius: 4px; font: 12px var(--mono); padding: 3px 6px;
  }
  .btn {
    background: #1c2b45; border: 1px solid var(--accent); color: var(--accent);
    border-radius: 4px; cursor: pointer; font: 600 11px var(--mono); padding: 2px 9px;
  }
  .btn:hover { background: #234; }
  .btn:disabled { opacity: .5; cursor: default; }
  .btn.warn { border-color: var(--warn); color: var(--warn); background: #2b2410; }
  #unknown-body { max-height: 30vh; overflow-y: auto; }
  .panel.alert > h2 { color: var(--warn); }
</style>
</head>
<body>
<header>
  <h1><span id="dot"></span>MediTracker 관제</h1>
  <span class="stat">태그 <b id="s-tags">0</b></span>
  <span class="stat">게이트웨이 <b id="s-gw">0</b>/<b id="s-gwtotal">0</b> 온라인</span>
  <span class="stat">스캔 <b id="s-rate">0</b>/s</span>
  <span class="stat">누적 <b id="s-total">0</b></span>
  <span class="stat" id="s-block-wrap">미등록 차단 <b id="s-blocked">0</b></span>
  <span class="stat" style="margin-left:auto">가동 <b id="s-uptime">0s</b></span>
  <!-- 테스트 장비 on/off — 끄면 게이트웨이 목록이 실장비로 바뀌고 목업 비콘이 막힌다 -->
  <button class="btn" id="testgear-btn" type="button">🧪 테스트 장비</button>
  <a id="back-btn" href="#">← 직원용 패널로</a>
</header>

<div class="grid">
  <div>
    <div class="panel" id="unknown-panel">
      <h2>미등록 신호 <span id="unknown-count" class="muted"></span></h2>
      <div class="body">
        <!-- 분류는 여기 두지 않는다. 공용 기본값이 있으면 그대로 눌러서 넘어가고,
             나중에 엉뚱한 그룹으로 등록된 비콘을 찾아다니게 된다. 줄마다 고른다. -->
        <!-- 이름 자동 채우기('비콘 1', '비콘 2'…)를 없앴다. 그 값이 **사람 이름**
             (persons.display_name)으로 들어가서, 등록/반납 화면이 환자 자리에
             '비콘 5' 를 띄웠다. 비콘을 가리키는 이름은 6자리 코드 하나면 된다. -->
        <div id="unknown-body"><div class="empty">미등록 신호 없음</div></div>
      </div>
    </div>
    <div style="height:12px"></div>
    <div class="panel">
      <h2>게이트웨이 (스캔 수신 상태)</h2>
      <div class="body"><table id="gw-table"><tbody></tbody></table></div>
    </div>
    <div style="height:12px"></div>
    <div class="panel" id="ugw-panel" style="display:none">
      <h2>미등록 게이트웨이 <span id="ugw-count" class="muted"></span></h2>
      <div class="body">
        <div class="bar">
          <span class="muted">설치한 구역</span>
          <select id="ugw-zone"></select>
          <span class="muted">를 고르고 등록</span>
        </div>
        <div id="ugw-body"></div>
      </div>
    </div>
    <div style="height:12px"></div>
    <div class="panel">
      <h2>태그 상태 (게이트웨이별 RSSI = 존 판정 원재료)</h2>
      <div class="body" id="tag-cards"><div class="empty">신호 대기 중…</div></div>
    </div>
  </div>
  <div>
    <div class="panel alert" id="rec-panel" style="display:none">
      <h2>● 녹화 중 — 정답 마크</h2>
      <div class="body">
        <div class="bar">
          <select id="mark-zone"></select>
          <button class="btn" id="mark-btn">지금 이 방에 들어옴</button>
          <button class="btn warn" id="mark-out">추적구역 이탈</button>
        </div>
        <div class="muted" id="rec-info"></div>
      </div>
    </div>
    <div id="rec-gap" style="height:12px;display:none"></div>
    <div class="panel">
      <h2>실시간 스캔 피드</h2>
      <div class="body feed" id="scan-feed"><div class="empty">스캔 대기 중…</div></div>
    </div>
    <div style="height:12px"></div>
    <div class="panel">
      <h2>존 전환 로그</h2>
      <div class="body feed" id="zone-feed" style="max-height:24vh"><div class="empty">전환 없음</div></div>
    </div>
  </div>
</div>

<!-- 등록·수정 공용 입력창. 카드/목록 밖에 둔다 — 둘 다 1초마다 다시 그려져서
     그 안에 select 나 input 을 두면 입력 도중에 사라진다. -->
<div id="edit-back">
  <div id="edit-box">
    <h3 id="edit-title">비콘 정보</h3>
    <div class="rawid" id="edit-id"></div>
    <div class="muted" id="edit-sig"></div>
    <label for="edit-group">분류 <span class="req">*</span></label>
    <select id="edit-group">
      <option value="">— 고르세요 —</option>
      <option value="patient">환자</option>
      <option value="doctor">의사</option>
      <option value="nurse">간호사</option>
      <option value="interpreter">통역</option>
      <option value="unassigned">미지정</option>
    </select>
    <label for="edit-name">이름 <span class="req">*</span></label>
    <input id="edit-name" autocomplete="off" placeholder="예: 김원장 / 손님 1" />
    <label for="edit-memo">설명 <span class="req">*</span></label>
    <input id="edit-memo" autocomplete="off" placeholder="예: 피부과 · 3층 상주" />
    <div class="warn-line" id="edit-warn"></div>
    <div class="row">
      <button id="edit-cancel" type="button">취소</button>
      <button id="edit-save" type="button">저장</button>
    </div>
  </div>
</div>

<div id="gate" hidden>
  <div class="gate-box">
    <h2>실시간 관제</h2>
    <p>직원 진입 핀을 입력하세요.</p>
    <input id="gate-pin" type="password" inputmode="numeric" autocomplete="off" placeholder="핀" />
    <button id="gate-ok" type="button">들어가기</button>
    <div id="gate-msg"></div>
  </div>
</div>

<script src="/socket.io/socket.io.js"></script>
<script>
  // 토큰을 받은 뒤에 붙는다 (autoConnect: false) — 핸들러 등록은 아래에서 그대로 한다
  var socket = io('/monitor', { autoConnect: false });

  // 진입 핀으로 받은 직원 토큰. 소켓과 아래 REST 호출이 같은 것을 쓴다
  var authToken = '';

  /**
   * 직원 전용 REST 는 토큰을 달고 가야 한다 (서버 index.ts 의 STAFF_ONLY).
   * 이걸 안 쓰고 fetch 를 그대로 부르면 그 기능만 조용히 401 이 된다.
   */
  function api(path, init) {
    init = init || {};
    init.headers = Object.assign(
      {},
      init.headers,
      authToken ? { Authorization: 'Bearer ' + authToken } : {},
    );
    return fetch(path, init);
  }
  var startedAt = Date.now();
  var scanCounter = 0, rate = 0;
  var gateways = [], zoneName = {};
  var meta = {};        // tagId → { name, memo }
  var lastState = null; // 이름 변경 시 즉시 재렌더용

  function nameOf(tagId) { return (meta[tagId] && meta[tagId].name) || tagShort(tagId); }
  function memoOf(tagId) { return (meta[tagId] && meta[tagId].memo) || ''; }

  // 그룹 표시 — 색·이름은 직원 화면 tag-panel.ts 의 GROUPS 와 같은 값
  var GROUPS = {
    doctor:      { label: '의사',   color: '#4aa3ff' },
    nurse:       { label: '간호사', color: '#06d6a0' },
    interpreter: { label: '통역',   color: '#b98ce0' },
    patient:     { label: '환자',   color: '#ffd166' },
    unassigned:  { label: '미지정', color: '#8b98a8' }
  };
  function groupChip(tagId) {
    var g = GROUPS[(meta[tagId] && meta[tagId].group) || 'unassigned'] || GROUPS.unassigned;
    return '<span class="grp" style="background:' + g.color + '">' + g.label + '</span>';
  }

  function ago(ms) {
    if (ms == null) return '-';
    var s = Math.round(ms / 1000);
    if (s < 60) return s + 's';
    return Math.floor(s / 60) + 'm' + (s % 60) + 's';
  }
  function rssiColor(r) { return r >= -60 ? 'var(--ok)' : r >= -80 ? 'var(--warn)' : 'var(--bad)'; }
  function rssiWidth(r) { return Math.max(2, Math.min(100, (r + 100) * 1.6)); } // -100..-40 → 0..96
  function esc(s) { return String(s).replace(/[&<>]/g, function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c];}); }
  function tagShort(t) { return t.length > 8 ? '…' + t.slice(-8) : t; }
  function clock(ts) { var d = new Date(ts); return d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3,'0'); }

  // 존 목록 <option> 묶음 — 게이트웨이 구역 변경 select 가 재사용한다 (init 에서 채움)
  var zoneOptionsHtml = '';
  /**
   * 구역을 편집 중인 게이트웨이 id. 게이트웨이 표는 상태가 올 때마다(≈1초) 통째로
   * 다시 그리는데, 편집 중에 갈아엎으면 고르던 select 가 사라진다. 그동안만 멈춘다.
   */
  var editingGw = null;

  // 복귀 버튼: ?back= 우선, 없으면 referrer, 그것도 없으면 기본 직원용 포트
  var backParam = new URLSearchParams(location.search).get('back');
  var backUrl = backParam || document.referrer || (location.protocol + '//' + location.hostname + ':5173');
  document.getElementById('back-btn').href = backUrl;

  var dot = document.getElementById('dot');
  socket.on('connect', function(){ dot.classList.add('on'); });
  socket.on('disconnect', function(){ dot.classList.remove('on'); });

  socket.on('init', function(d){
    gateways = d.gateways || [];
    (d.zones || []).forEach(function(z){ zoneName[z.zoneId] = z.name; });
    meta = d.tagMeta || {};
    // 정답 마크용 존 목록 (녹화 중일 때만 쓰이지만 미리 채워둔다)
    var zoneOptions = (d.zones || []).map(function(z){
      return '<option value="' + esc(z.zoneId) + '">' + esc(z.name || z.zoneId) + '</option>';
    }).join('');
    document.getElementById('mark-zone').innerHTML = zoneOptions;
    zoneOptionsHtml = zoneOptions;
    // 게이트웨이 등록용 — 첫 항목이 실수로 선택되지 않게 빈 값을 앞에 둔다
    document.getElementById('ugw-zone').innerHTML =
      '<option value="">— 구역 선택 —</option>' + zoneOptions;
    document.getElementById('s-gwtotal').textContent = gateways.length;
    if (d.startedAt) startedAt = d.startedAt;
    (d.recentScans || []).forEach(pushScan);
    (d.recentZoneChanges || []).forEach(pushZone);
  });

  socket.on('tagmeta', function(m){ meta = m || {}; if (lastState) renderState(lastState); });

  // ── 이름/메모/그룹 편집 ──────────────────────────────────────────────────
  // 등록할 때 그룹을 잘못 골랐어도 여기서 고칠 수 있어야 한다. 그 전에는 그룹을 바꿀
  // 방법이 직원 화면(:5173)뿐이었다.
  // ⚠️ 서버는 name·memo 를 보낸 값으로 덮어쓴다 — 그룹만 바꾸려 해도 셋을 다 보내야
  //    나머지가 지워지지 않는다. content-type 미지정으로 preflight 회피.
  var editing = null;    // 대상 tagId
  var editMode = 'edit'; // 'edit' | 'register'
  var back = document.getElementById('edit-back');
  var elGroup = document.getElementById('edit-group');
  var elName = document.getElementById('edit-name');
  var elMemo = document.getElementById('edit-memo');
  var elSave = document.getElementById('edit-save');
  var elWarn = document.getElementById('edit-warn');

  /**
   * 세 칸이 다 차야 저장된다.
   *
   * 특히 **분류는 기본값을 비워 둔다.** 기본값이 있으면 그냥 눌러서 넘어가고, 나중에
   * 엉뚱한 그룹으로 등록된 비콘을 찾아다니게 된다 — 100개를 등록하고 나서 알게 되면
   * 되돌리는 비용이 크다. 설명도 같이 받는다: 나중에 "이 비콘이 누구 거였지" 를 푸는
   * 단서는 이름 한 줄로는 부족하다.
   */
  function validate(){
    var missing = [];
    if (!elGroup.value) missing.push('분류');
    if (!elName.value.trim()) missing.push('이름');
    if (!elMemo.value.trim()) missing.push('설명');
    elWarn.textContent = missing.length ? missing.join(' · ') + ' 을(를) 입력하세요' : '';
    elSave.disabled = missing.length > 0;
    return missing.length === 0;
  }
  [elGroup, elName, elMemo].forEach(function(el){
    el.addEventListener('input', validate);
    el.addEventListener('change', validate);
  });

  function openDialog(mode, tagId, opts){
    editMode = mode;
    editing = tagId;
    var cur = (mode === 'edit' ? meta[tagId] : null) || {};
    document.getElementById('edit-title').textContent = mode === 'register' ? '비콘 등록' : '비콘 정보';
    document.getElementById('edit-id').textContent = tagId;
    // 등록할 때는 어느 비콘인지 확신이 서야 한다 — 신호 세기와 잡은 게이트웨이를 같이 보여준다
    document.getElementById('edit-sig').textContent =
      opts && opts.sig ? opts.sig : '';
    elGroup.value = cur.group || '';
    elName.value = cur.name || (opts && opts.suggestName) || '';
    elMemo.value = cur.memo || '';
    elSave.textContent = mode === 'register' ? '등록' : '저장';
    back.classList.add('show');
    validate();
    (elGroup.value ? elName : elGroup).focus();
  }

  function closeEdit(){ editing = null; back.classList.remove('show'); }

  function editMeta(tagId){ openDialog('edit', tagId); }

  function submitDialog(){
    if (!editing || !validate()) return;
    var payload = {
      tagId: editing,
      name: elName.value.trim(),
      memo: elMemo.value.trim(),
      group: elGroup.value
    };
    if (editMode === 'edit') {
      api('/tag-meta', { method: 'POST', body: JSON.stringify(payload) });
      closeEdit();
      return;
    }
    elSave.disabled = true;
    elSave.textContent = '…';
    api('/register-tag', { method: 'POST', body: JSON.stringify(payload) })
      .then(function(r){ return r.json(); })
      .then(function(d){
        elSave.textContent = '등록';
        if (!d.ok) { elWarn.textContent = '등록 실패: ' + (d.error || '알 수 없는 오류'); elSave.disabled = false; return; }
        closeEdit();
      })
      .catch(function(err){
        elSave.textContent = '등록';
        elSave.disabled = false;
        elWarn.textContent = '등록 실패: ' + err.message;
      });
  }

  elSave.addEventListener('click', submitDialog);
  document.getElementById('edit-cancel').addEventListener('click', closeEdit);
  // 배경을 눌러도 닫히게 (상자 안을 누른 것은 통과)
  back.addEventListener('click', function(e){ if (e.target === back) closeEdit(); });
  document.addEventListener('keydown', function(e){
    if (!editing) return;
    if (e.key === 'Escape') closeEdit();
    if (e.key === 'Enter') submitDialog();
  });
  document.getElementById('tag-cards').addEventListener('click', function(e){
    var btn = e.target.closest('.edit');
    if (btn) editMeta(btn.getAttribute('data-tag'));
  });

  // ── 미등록 신호 → 태그 등록 ──────────────────────────────────────────────
  // 비콘을 게이트웨이 코앞에 대면 RSSI 가 세져서 맨 위로 올라온다. 클릭 한 번에
  // 등록 → 다음 스캔부터 화이트리스트 통과. 이름은 접두어+번호가 자동 증가하므로
  // 100개를 연달아 올릴 때 타이핑이 없다.
  function renderUnknown(list, ing){
    var body = document.getElementById('unknown-body');
    var countEl = document.getElementById('unknown-count');
    if (ing && !ing.whitelistEnabled) {
      countEl.textContent = '(화이트리스트 OFF)';
      body.innerHTML = '<div class="empty">화이트리스트가 꺼져 있어 주변 BLE 를 전부 추적 중입니다 — 디버깅 전용 설정</div>';
      return;
    }
    countEl.textContent = ing ? '(고유 ' + ing.uniqueUnknownIds + ' · 등록 ' + ing.knownTags + ')' : '';
    if (!list || list.length === 0) {
      body.innerHTML = '<div class="empty">미등록 신호 없음</div>';
      return;
    }
    body.innerHTML = '<table><tbody>' + list.map(function(u){
      return '<tr>'
        + '<td style="width:50px;text-align:right">' + u.rssi + '</td>'
        + '<td style="width:110px"><span class="rssi-bar" style="width:' + rssiWidth(u.rssi) + 'px;background:' + rssiColor(u.rssi) + '"></span></td>'
        + '<td class="tag">' + esc(u.tagId) + '</td>'
        + '<td class="gw">' + esc(u.gatewayId) + '</td>'
        + '<td class="muted" style="text-align:right">' + u.count + '회</td>'
        + '<td style="text-align:right"><button class="btn reg" data-tag="' + esc(u.tagId) + '"'
        + ' data-sig="' + esc(u.rssi + ' dBm · ' + u.gatewayId + ' · ' + u.count + '회') + '">등록</button></td>'
        + '</tr>';
    }).join('') + '</tbody></table>';
  }

  // 등록은 줄마다 입력창을 거친다 — 분류·이름·설명을 그 비콘에 맞게 정하고 나서 등록된다.
  // (목록은 1초마다 다시 그려지므로 줄 안에 select·input 을 둘 수 없다. 그 자리에서
  //  고르게 하려면 입력창을 목록 밖에 띄우는 수밖에 없다.)
  document.getElementById('unknown-body').addEventListener('click', function(e){
    var btn = e.target.closest('.reg');
    if (!btn) return;
    openDialog('register', btn.getAttribute('data-tag'), {
      suggestName: '',
      sig: btn.getAttribute('data-sig') || ''
    });
  });

  // ── 미등록 게이트웨이 → 구역 배정 ────────────────────────────────────────
  // 게이트웨이를 달아도 gateways.json 에 없으면 판정에서 조용히 버려져 화면에 흔적이
  // 없다. 그래서 MAC 을 알아내려고 장비 웹페이지를 뒤져야 했다. 게다가 이 장비는
  // **네트워크 카드 MAC 과 페이로드에 실리는 MAC 이 끝자리가 다르다** — 스티커를 보고
  // 넣으면 영원히 안 맞는다. 여기 뜨는 값이 실제로 온 값이므로 이걸 그대로 쓰면 된다.
  function renderUnknownGateways(d){
    var panel = document.getElementById('ugw-panel');
    var list = (d && d.unknown) || [];
    if (list.length === 0) { panel.style.display = 'none'; return; }
    panel.style.display = '';
    document.getElementById('ugw-count').textContent = '(' + list.length + '대)';
    document.getElementById('ugw-body').innerHTML = '<table><tbody>'
      + '<tr><th>게이트웨이 MAC</th><th>스캔</th><th>들은 비콘</th><th>최근</th><th></th></tr>'
      + list.map(function(g){
          return '<tr><td class="gw">' + esc(g.gatewayId) + '</td>'
            + '<td style="text-align:right">' + g.scans + '</td>'
            + '<td style="text-align:right">' + g.beacons + '종</td>'
            + '<td class="muted" style="text-align:right">' + ago(Date.now() - g.lastSeen) + '</td>'
            + '<td style="text-align:right"><button class="btn ureg" data-gw="' + esc(g.gatewayId) + '">등록</button></td></tr>';
        }).join('') + '</tbody></table>';
  }

  document.getElementById('ugw-body').addEventListener('click', function(e){
    var btn = e.target.closest('.ureg');
    if (!btn) return;
    var zoneId = document.getElementById('ugw-zone').value;
    if (!zoneId) { alert('설치한 구역을 먼저 고르세요'); return; }
    btn.disabled = true; btn.textContent = '…';
    api('/register-gateway', { method: 'POST', body: JSON.stringify({
      gatewayId: btn.getAttribute('data-gw'), zoneId: zoneId
    }) })
      .then(function(r){ return r.json(); })
      .then(function(d){
        if (!d.ok) { btn.disabled = false; btn.textContent = '등록'; alert('등록 실패: ' + (d.error || '')); }
      })
      .catch(function(err){ btn.disabled = false; btn.textContent = '등록'; alert('등록 실패: ' + err.message); });
  });

  // ── 등록된 게이트웨이의 구역 변경 ────────────────────────────────────────
  // 배치를 정하는 동안에는 같은 장비를 이 방 저 방으로 계속 옮긴다. 그때마다 JSON 을
  // 고치고 서버를 재시작하면 측정 흐름이 끊기고, 무엇보다 옮긴 걸 반영하는 걸 잊는다 —
  // 그러면 화면이 조용히 거짓말을 한다. /register-gateway 가 이미 기존 항목 덮어쓰기를
  // 지원하므로(등록과 같은 경로) 여기서는 부르기만 한다.
  document.getElementById('gw-table').addEventListener('click', function(e){
    var move = e.target.closest('.gwmove');
    if (move) {
      editingGw = move.getAttribute('data-gw');
      var cell = move.parentNode;
      cell.innerHTML = '<select class="gwzone">' + zoneOptionsHtml + '</select>'
        + ' <button class="btn gwsave">저장</button>'
        + ' <button class="btn gwcancel">취소</button>';
      // 지금 존을 미리 골라 둔다 — 실수로 저장해도 값이 안 바뀌게
      cell.querySelector('.gwzone').value = move.getAttribute('data-zone') || '';
      return;
    }
    if (e.target.closest('.gwcancel')) { editingGw = null; return; }
    var save = e.target.closest('.gwsave');
    if (!save) return;
    var zoneId = save.parentNode.querySelector('.gwzone').value;
    var gatewayId = editingGw;
    save.disabled = true; save.textContent = '…';
    api('/register-gateway', { method: 'POST', body: JSON.stringify({
      gatewayId: gatewayId, zoneId: zoneId
    }) })
      .then(function(r){ return r.json(); })
      .then(function(d){
        // 성공하면 편집을 풀기만 한다 — 다음 상태 수신 때 새 존으로 다시 그려진다
        if (d.ok) { editingGw = null; return; }
        save.disabled = false; save.textContent = '저장';
        alert('구역 변경 실패: ' + (d.error || ''));
      })
      .catch(function(err){
        save.disabled = false; save.textContent = '저장';
        alert('구역 변경 실패: ' + err.message);
      });
  });

  // 저빈도 운영 동작이라 소켓에 태우지 않고 폴링한다
  function pollUnknownGateways(){
    if (!authToken) return; // 아직 핀을 안 넣었다 — 던져도 401 만 쌓인다
    api('/unknown-gateways').then(function(r){ return r.json(); }).then(renderUnknownGateways).catch(function(){});
  }
  setInterval(pollUnknownGateways, 2000);

  // ── 녹화 정답 마크 ───────────────────────────────────────────────────────
  // 걸으면서 방을 바꿀 때마다 찍는다. 이 마크가 replay 채점의 기준이 된다.
  function renderRecording(rec){
    var panel = document.getElementById('rec-panel');
    var gap = document.getElementById('rec-gap');
    if (!rec) { panel.style.display = 'none'; gap.style.display = 'none'; return; }
    panel.style.display = '';
    gap.style.display = '';
    var file = rec.path.split(/[\\\\/]/).pop();
    document.getElementById('rec-info').textContent = file + ' · ' + rec.lines + '줄' + lastMark;
  }
  var lastMark = '';
  function sendMark(zoneId){
    api('/record/mark', { method: 'POST', body: JSON.stringify({ zoneId: zoneId }) })
      .then(function(r){ return r.json(); })
      .then(function(d){
        lastMark = d.ok
          ? '  ✓ 마크: ' + (zoneId ? (zoneName[zoneId] || zoneId) : '이탈') + ' @ ' + new Date().toTimeString().slice(0,8)
          : '  ✗ ' + (d.error || '실패');
      });
  }
  document.getElementById('mark-btn').addEventListener('click', function(){
    sendMark(document.getElementById('mark-zone').value);
  });
  document.getElementById('mark-out').addEventListener('click', function(){ sendMark(null); });

  // ── 테스트 장비 on/off ──
  // 끄면 서버가 게이트웨이 목록을 실장비로 갈아끼우고 목업 비콘 스캔을 막는다.
  // 화면 필터가 아니라 판정 자체가 바뀌므로, 바꾼 뒤에는 새로 그린다.
  var tgBtn = document.getElementById('testgear-btn');
  var tgOn = true;
  function tgRender(gwCount){
    tgBtn.textContent = tgOn ? '🧪 테스트 장비 끄기' : '🧪 실장비만 (' + gwCount + '대)';
    tgBtn.classList.toggle('on', tgOn);
    tgBtn.title = tgOn
      ? '끄면 계획 배치 게이트웨이와 목업 비콘이 빠지고 실장비만 돕니다'
      : '실장비만 돌고 있습니다 — 게이트웨이 근처가 아니면 자리비움으로 뜹니다';
  }
  // 직원 전용 API 라 진입 핀을 받은 뒤에 읽는다 (openSocket 에서 부른다)
  function loadTestGear(){
    api('/test-gear').then(function(r){ return r.json(); }).then(function(d){
      tgOn = d.on; tgRender(d.gateways);
    }).catch(function(){});
  }
  tgBtn.addEventListener('click', function(){
    tgBtn.disabled = true;
    api('/test-gear', { method: 'POST', body: JSON.stringify({ on: !tgOn }) })
      .then(function(r){ return r.json(); })
      .then(function(d){ if (d.ok) location.reload(); else tgBtn.disabled = false; })
      .catch(function(){ tgBtn.disabled = false; });
  });

  // ── 스캔 피드 (배치 수신) ──
  var feed = document.getElementById('scan-feed');
  function pushScan(s){
    if (feed.querySelector('.empty')) feed.innerHTML = '';
    var w = rssiWidth(s.rssi), c = rssiColor(s.rssi);
    var row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = '<span class="t">' + clock(s.timestamp) + '</span>'
      + '<span class="gw">' + esc(s.gatewayId) + '</span>'
      + '<span class="tag">' + esc(nameOf(s.tagId)) + '</span>'
      + '<span style="width:60px;text-align:right">' + s.rssi + 'dBm</span>'
      + '<span class="rssi-bar" style="width:' + w + 'px;background:' + c + '"></span>';
    feed.insertBefore(row, feed.firstChild);
    while (feed.childNodes.length > 120) feed.removeChild(feed.lastChild);
  }
  socket.on('scans', function(batch){
    scanCounter += batch.length;
    batch.forEach(pushScan);
  });

  // ── 존 전환 로그 ──
  var zoneFeed = document.getElementById('zone-feed');
  function pushZone(c){
    if (zoneFeed.querySelector('.empty')) zoneFeed.innerHTML = '';
    var from = c.fromZone ? (zoneName[c.fromZone] || c.fromZone) : '(신규)';
    var to = c.toZone ? (zoneName[c.toZone] || c.toZone) : '자리비움';
    var row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = '<span class="t">' + clock(c.at) + '</span>'
      + '<span class="tag">' + esc(nameOf(c.tagId)) + '</span>'
      + '<span class="zfrom muted">' + esc(from) + '</span>'
      + '<span class="muted">→</span>'
      + '<span class="zto" style="color:' + (c.toZone ? 'var(--accent)' : 'var(--bad)') + '">' + esc(to) + '</span>';
    zoneFeed.insertBefore(row, zoneFeed.firstChild);
    while (zoneFeed.childNodes.length > 60) zoneFeed.removeChild(zoneFeed.lastChild);
  }
  socket.on('zone', pushZone);

  // ── 상태 스냅샷 (1초) ──
  socket.on('state', function(st){ lastState = st; renderState(st); });

  function renderState(st){
    document.getElementById('s-tags').textContent = st.tags.length;
    // 아래 태그 카드 렌더에는 early return 이 있다 — 등록 패널은 그보다 먼저 그린다.
    // 화이트리스트를 켠 직후엔 추적 태그가 0인데, 그때야말로 이 패널이 필요하다.
    renderUnknown(st.unknown, st.ingest);
    renderRecording(st.recording);
    if (st.ingest) document.getElementById('s-blocked').textContent = st.ingest.droppedScans;

    // 게이트웨이 테이블
    // 집계는 편집 중에도 계속 갱신한다 — 멈추는 건 표 다시 그리기뿐이다.
    var online = 0, total = 0;
    st.gateways.forEach(function(g){
      total += g.count;
      if (g.lastSeenMs != null && g.lastSeenMs < 10000) online++;
    });
    document.getElementById('s-gw').textContent = online;
    document.getElementById('s-total').textContent = total;
    if (!editingGw) {
      var rows = st.gateways.map(function(g){
        var alive = g.lastSeenMs != null && g.lastSeenMs < 10000;
        var color = g.lastSeenMs == null ? 'var(--muted)' : alive ? 'var(--ok)' : 'var(--bad)';
        return '<tr><td class="gw">' + esc(g.gatewayId) + '</td>'
          + '<td class="muted">' + esc(g.label || '') + '</td>'
          + '<td><span class="zonecell"><span class="zname">'
          + esc(zoneName[g.zoneId] || g.zoneId) + '</span>'
          + '<button class="btn gwmove" data-gw="' + esc(g.gatewayId) + '"'
          + ' data-zone="' + esc(g.zoneId || '') + '">구역 변경</button></span></td>'
          + '<td style="text-align:right">' + g.count + '</td>'
          + '<td style="color:' + color + ';text-align:right">' + ago(g.lastSeenMs) + '</td></tr>';
      });
      document.querySelector('#gw-table tbody').innerHTML =
        '<tr><th>ID</th><th>라벨</th><th>존</th><th>스캔</th><th>최근</th></tr>' + rows.join('');
    }

    // 태그 카드
    var cards = document.getElementById('tag-cards');
    if (st.tags.length === 0) { cards.innerHTML = '<div class="empty">추적 중인 태그 없음</div>'; return; }
    cards.innerHTML = st.tags.map(function(t){
      var absent = t.zone == null;
      var badge = absent
        ? '<span class="badge absent">자리비움</span>'
        : '<span class="badge zone" title="' + esc(zoneName[t.zone] || t.zone) + '">'
          + esc(zoneName[t.zone] || t.zone) + '</span>';
      // 막대 칸에 고정 너비를 준다. 카드마다 표가 따로라, 너비를 안 주면 그 카드에서
      // 제일 긴 막대에 맞춰 열이 잡히고 카드끼리 시작점이 어긋난다 — 세기를 눈으로
      // 비교하는 화면인데 기준선이 카드마다 다르면 비교가 안 된다. 막대 최대치가
      // 100px(rssiWidth)이므로 110px 이면 잘리지 않는다.
      var bars = t.readings.slice(0, 6).map(function(r){
        return '<tr><td class="gw">' + esc(r.gatewayId) + '</td>'
          + '<td style="width:55px;text-align:right">' + r.rssi + '</td>'
          + '<td style="width:110px"><span class="rssi-bar" style="width:' + rssiWidth(r.rssi) + 'px;background:' + rssiColor(r.rssi) + '"></span></td></tr>';
      }).join('') || '<tr><td class="muted" colspan="3">신호 없음</td></tr>';
      var named = meta[t.tagId] && meta[t.tagId].name;
      var memo = memoOf(t.tagId);
      return '<div class="card"><div class="hd">'
        + '<b class="tag">' + esc(nameOf(t.tagId)) + '</b>' + groupChip(t.tagId) + badge
        + '<button class="edit" data-tag="' + esc(t.tagId) + '">✎ 이름/그룹</button>'
        + '<span class="muted age">최근 ' + ago(t.ageMs) + '</span></div>'
        + (named ? '<div class="rawid">' + esc(t.tagId) + '</div>' : '')
        + (memo ? '<div class="memo">📝 ' + esc(memo) + '</div>' : '')
        + '<table>' + bars + '</table></div>';
    }).join('');
  }

  // ── 헤더 카운터 (1초) ──
  setInterval(function(){
    rate = scanCounter; scanCounter = 0;
    document.getElementById('s-rate').textContent = rate;
    document.getElementById('s-uptime').textContent = ago(Date.now() - startedAt);
  }, 1000);

  // ── 진입 핀 ──
  // 관제는 태그 위치·RSSI 전부를 노출한다. 이 HTML 은 누구나 받을 수 있어도 소켓은 직원
  // 토큰이 있어야 붙는다(ws/index.ts) — 그 토큰을 여기서 받는다.
  // 핀을 한 번 넣으면 서버가 HttpOnly 세션 쿠키를 발행하므로 2시간은 다시 묻지 않는다.
  // 토큰 사본은 이 변수(메모리)에만 둔다 — 불변식 B-5.
  var gate = document.getElementById('gate');
  var gatePin = document.getElementById('gate-pin');
  var gateMsg = document.getElementById('gate-msg');
  var gateBtn = document.getElementById('gate-ok');

  function openSocket(token) {
    authToken = token;
    socket.auth = { token: token };
    socket.connect();
    gate.hidden = true;
    // 토큰이 있어야 답이 오는 것들 — 여기서 처음 읽는다
    loadTestGear();
    pollUnknownGateways();
  }

  function askPin() {
    gate.hidden = false;
    gatePin.focus();
  }

  function submitPin() {
    var pin = (gatePin.value || '').trim();
    if (!pin) return;
    gateBtn.disabled = true;
    gateMsg.textContent = '확인 중…';
    fetch('/staff-token', { method: 'POST', body: JSON.stringify({ pin: pin }) })
      .then(function (r) {
        return r.json().then(function (d) { return { ok: r.ok, body: d }; });
      })
      .then(function (res) {
        if (res.ok && res.body.token) { openSocket(res.body.token); return; }
        gateMsg.textContent = res.body.error || '핀이 맞지 않습니다';
        gatePin.value = '';
        gatePin.focus();
      })
      .catch(function () { gateMsg.textContent = '서버에 연결할 수 없습니다'; })
      .then(function () { gateBtn.disabled = false; });
  }

  gateBtn.addEventListener('click', submitPin);
  gatePin.addEventListener('keydown', function (e) { if (e.key === 'Enter') submitPin(); });

  var urlToken = new URLSearchParams(location.search).get('token');
  if (urlToken) {
    openSocket(urlToken);
  } else {
    // 개발 서버는 핀 없이 내준다. 운영은 401 → 핀 입력
    fetch('/staff-token')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d && d.token) openSocket(d.token); else askPin(); })
      .catch(askPin);
  }
</script>
</body>
</html>`;
}
