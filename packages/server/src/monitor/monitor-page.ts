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
  #back-btn {
    margin-left: auto; padding: 8px 14px; border: 1px solid var(--accent); border-radius: 6px;
    background: #1c2b45; color: var(--accent); font: 600 13px var(--mono); cursor: pointer; text-decoration: none;
  }
  #back-btn:hover { background: #234; }
</style>
</head>
<body>
<header>
  <h1><span id="dot"></span>MediTracker 관제</h1>
  <span class="stat">태그 <b id="s-tags">0</b></span>
  <span class="stat">게이트웨이 <b id="s-gw">0</b>/<b id="s-gwtotal">0</b> 온라인</span>
  <span class="stat">스캔 <b id="s-rate">0</b>/s</span>
  <span class="stat">누적 <b id="s-total">0</b></span>
  <span class="stat" style="margin-left:auto">가동 <b id="s-uptime">0s</b></span>
  <a id="back-btn" href="#">← 직원용 패널로</a>
</header>

<div class="grid">
  <div>
    <div class="panel">
      <h2>게이트웨이 (스캔 수신 상태)</h2>
      <div class="body"><table id="gw-table"><tbody></tbody></table></div>
    </div>
    <div style="height:12px"></div>
    <div class="panel">
      <h2>태그 상태 (게이트웨이별 RSSI = 존 판정 원재료)</h2>
      <div class="body" id="tag-cards"><div class="empty">신호 대기 중…</div></div>
    </div>
  </div>
  <div>
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
    document.getElementById('s-gwtotal').textContent = gateways.length;
    if (d.startedAt) startedAt = d.startedAt;
    (d.recentScans || []).forEach(pushScan);
    (d.recentZoneChanges || []).forEach(pushZone);
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
      + '<span class="tag">' + esc(tagShort(s.tagId)) + '</span>'
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
      + '<span class="tag">' + esc(tagShort(c.tagId)) + '</span>'
      + '<span class="muted">' + esc(from) + ' → </span>'
      + '<span style="color:' + (c.toZone ? 'var(--accent)' : 'var(--bad)') + '">' + esc(to) + '</span>';
    zoneFeed.insertBefore(row, zoneFeed.firstChild);
    while (zoneFeed.childNodes.length > 60) zoneFeed.removeChild(zoneFeed.lastChild);
  }
  socket.on('zone', pushZone);

  // ── 상태 스냅샷 (1초) ──
  socket.on('state', function(st){
    document.getElementById('s-tags').textContent = st.tags.length;

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
      return '<div class="card"><div class="hd">'
        + '<b class="tag">' + esc(tagShort(t.tagId)) + '</b>' + badge
        + '<span class="muted">최근 ' + ago(t.ageMs) + '</span></div>'
        + '<table>' + bars + '</table></div>';
    }).join('');
  });

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
