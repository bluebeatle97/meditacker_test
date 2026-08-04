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
  body { margin: 0; background: var(--bg); color: var(--text); font-family: var(--mono); font-size: 13px; }
  header {
    display: flex; align-items: center; gap: 20px; padding: 10px 16px;
    background: var(--panel); border-bottom: 1px solid var(--border); position: sticky; top: 0; z-index: 10;
  }
  header h1 { font-size: 15px; margin: 0; font-weight: 600; }
  .stat { color: var(--muted); }
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
  .feed .t { color: var(--muted); }
  .gw { color: var(--accent); }
  .tag { color: #e3b341; }
  .rssi-bar { display: inline-block; height: 8px; border-radius: 2px; vertical-align: middle; }
  table { width: 100%; border-collapse: collapse; }
  td, th { text-align: left; padding: 3px 6px; border-bottom: 1px solid #21262d; }
  th { color: var(--muted); font-weight: 500; }
  .card { border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; margin-bottom: 8px; }
  .card .hd { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
  .badge { padding: 1px 7px; border-radius: 10px; font-size: 11px; }
  .badge.zone { background: #1f6feb33; color: var(--accent); }
  .badge.absent { background: #f8514933; color: var(--bad); }
  .muted { color: var(--muted); }
  .empty { color: var(--muted); padding: 16px; text-align: center; }
  .edit { background: none; border: 1px solid var(--border); color: var(--muted); border-radius: 4px;
          cursor: pointer; font: 11px var(--mono); padding: 1px 6px; }
  .edit:hover { color: var(--accent); border-color: var(--accent); }
  .memo { color: var(--warn); font-size: 12px; margin: 2px 0 6px; white-space: pre-wrap; }
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
  <a id="back-btn" href="#">← 직원용 패널로</a>
</header>

<div class="grid">
  <div>
    <div class="panel" id="unknown-panel">
      <h2>미등록 신호 <span id="unknown-count" class="muted"></span></h2>
      <div class="body">
        <div class="bar">
          <span class="muted">등록 설정</span>
          <select id="reg-group">
            <option value="patient">환자</option>
            <option value="doctor">의사</option>
            <option value="nurse">간호사</option>
            <option value="interpreter">통역</option>
            <option value="unassigned">미지정</option>
          </select>
          <input id="reg-prefix" value="비콘" style="width:80px" />
          <input id="reg-next" type="number" value="1" style="width:56px" />
          <span class="muted">이름 = 접두어 + 번호 (등록할 때마다 자동 증가)</span>
        </div>
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

<script src="/socket.io/socket.io.js"></script>
<script>
  var socket = io('/monitor');
  var startedAt = Date.now();
  var scanCounter = 0, rate = 0;
  var gateways = [], zoneName = {};
  var meta = {};        // tagId → { name, memo }
  var lastState = null; // 이름 변경 시 즉시 재렌더용

  function nameOf(tagId) { return (meta[tagId] && meta[tagId].name) || tagShort(tagId); }
  function memoOf(tagId) { return (meta[tagId] && meta[tagId].memo) || ''; }

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
    // 게이트웨이 등록용 — 첫 항목이 실수로 선택되지 않게 빈 값을 앞에 둔다
    document.getElementById('ugw-zone').innerHTML =
      '<option value="">— 구역 선택 —</option>' + zoneOptions;
    document.getElementById('s-gwtotal').textContent = gateways.length;
    if (d.startedAt) startedAt = d.startedAt;
    (d.recentScans || []).forEach(pushScan);
    (d.recentZoneChanges || []).forEach(pushZone);
  });

  socket.on('tagmeta', function(m){ meta = m || {}; if (lastState) renderState(lastState); });

  // 이름/메모 편집 (프롬프트 → POST). content-type 미지정으로 preflight 회피.
  function editMeta(tagId){
    var cur = meta[tagId] || {};
    var name = prompt('태그 ' + tagId + '\\n\\n이름:', cur.name || '');
    if (name === null) return;
    var memo = prompt('메모 (선택):', cur.memo || '');
    fetch('/tag-meta', { method: 'POST', body: JSON.stringify({ tagId: tagId, name: name, memo: memo || '' }) });
  }
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
        + '<td style="text-align:right"><button class="btn reg" data-tag="' + esc(u.tagId) + '">등록</button></td>'
        + '</tr>';
    }).join('') + '</tbody></table>';
  }

  document.getElementById('unknown-body').addEventListener('click', function(e){
    var btn = e.target.closest('.reg');
    if (!btn) return;
    var tagId = btn.getAttribute('data-tag');
    var nextEl = document.getElementById('reg-next');
    var prefix = document.getElementById('reg-prefix').value.trim();
    var name = (prefix ? prefix + ' ' : '') + nextEl.value;
    btn.disabled = true;
    btn.textContent = '…';
    fetch('/register-tag', { method: 'POST', body: JSON.stringify({
      tagId: tagId, name: name, group: document.getElementById('reg-group').value
    }) })
      .then(function(r){ return r.json(); })
      .then(function(d){
        if (d.ok) { nextEl.value = String(Number(nextEl.value) + 1); return; }
        btn.disabled = false; btn.textContent = '등록';
        alert('등록 실패: ' + (d.error || '알 수 없는 오류'));
      })
      .catch(function(err){
        btn.disabled = false; btn.textContent = '등록';
        alert('등록 실패: ' + err.message);
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
    fetch('/register-gateway', { method: 'POST', body: JSON.stringify({
      gatewayId: btn.getAttribute('data-gw'), zoneId: zoneId
    }) })
      .then(function(r){ return r.json(); })
      .then(function(d){
        if (!d.ok) { btn.disabled = false; btn.textContent = '등록'; alert('등록 실패: ' + (d.error || '')); }
      })
      .catch(function(err){ btn.disabled = false; btn.textContent = '등록'; alert('등록 실패: ' + err.message); });
  });

  // 저빈도 운영 동작이라 소켓에 태우지 않고 폴링한다
  setInterval(function(){
    fetch('/unknown-gateways').then(function(r){ return r.json(); }).then(renderUnknownGateways).catch(function(){});
  }, 2000);

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
    fetch('/record/mark', { method: 'POST', body: JSON.stringify({ zoneId: zoneId }) })
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
      + '<span class="muted">' + esc(from) + ' → </span>'
      + '<span style="color:' + (c.toZone ? 'var(--accent)' : 'var(--bad)') + '">' + esc(to) + '</span>';
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
    var online = 0, total = 0;
    var rows = st.gateways.map(function(g){
      total += g.count;
      var alive = g.lastSeenMs != null && g.lastSeenMs < 10000;
      if (alive) online++;
      var color = g.lastSeenMs == null ? 'var(--muted)' : alive ? 'var(--ok)' : 'var(--bad)';
      return '<tr><td class="gw">' + esc(g.gatewayId) + '</td>'
        + '<td class="muted">' + esc(g.label || '') + '</td>'
        + '<td>' + (zoneName[g.zoneId] || g.zoneId) + '</td>'
        + '<td style="text-align:right">' + g.count + '</td>'
        + '<td style="color:' + color + ';text-align:right">' + ago(g.lastSeenMs) + '</td></tr>';
    });
    document.querySelector('#gw-table tbody').innerHTML =
      '<tr><th>ID</th><th>라벨</th><th>존</th><th>스캔</th><th>최근</th></tr>' + rows.join('');
    document.getElementById('s-gw').textContent = online;
    document.getElementById('s-total').textContent = total;

    // 태그 카드
    var cards = document.getElementById('tag-cards');
    if (st.tags.length === 0) { cards.innerHTML = '<div class="empty">추적 중인 태그 없음</div>'; return; }
    cards.innerHTML = st.tags.map(function(t){
      var absent = t.zone == null;
      var badge = absent
        ? '<span class="badge absent">자리비움</span>'
        : '<span class="badge zone">' + esc(zoneName[t.zone] || t.zone) + '</span>';
      var bars = t.readings.slice(0, 6).map(function(r){
        return '<tr><td class="gw">' + esc(r.gatewayId) + '</td>'
          + '<td style="width:55px;text-align:right">' + r.rssi + '</td>'
          + '<td><span class="rssi-bar" style="width:' + rssiWidth(r.rssi) + 'px;background:' + rssiColor(r.rssi) + '"></span></td></tr>';
      }).join('') || '<tr><td class="muted" colspan="3">신호 없음</td></tr>';
      var named = meta[t.tagId] && meta[t.tagId].name;
      var memo = memoOf(t.tagId);
      return '<div class="card"><div class="hd">'
        + '<b class="tag">' + esc(nameOf(t.tagId)) + '</b>' + badge
        + '<button class="edit" data-tag="' + esc(t.tagId) + '">✎ 이름/메모</button>'
        + '<span class="muted">최근 ' + ago(t.ageMs) + '</span></div>'
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
</script>
</body>
</html>`;
}
