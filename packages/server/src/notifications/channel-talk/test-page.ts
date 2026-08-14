/**
 * 채널톡 연동 수동 테스트 페이지 (GET /channeltalk-test).
 *
 * 키를 발급받은 사람이 코드 없이 순서대로 눌러 보며 확인하는 용도:
 *   ① 키 인식됐나 → ② 매니저/그룹 목록이 오나 → ③ 버튼 눌러 실제 메시지가 뜨나.
 * 채널톡 호출은 전부 서버 경유다 — 키를 브라우저에 주면 안 되고, api.channel.io 는
 * CORS 로도 막혀 있다. 관제 페이지(/monitor)와 같은 팔레트.
 */
export function channelTalkTestPageHtml(): string {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>MediTracker — 채널톡 알림 테스트</title>
<style>
  :root {
    --bg: #0d1117; --panel: #161b22; --border: #30363d; --text: #c9d1d9;
    --muted: #8b949e; --accent: #58a6ff; --ok: #3fb950; --warn: #d29922; --bad: #f85149;
    --mono: ui-monospace, "Cascadia Code", "Consolas", monospace;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font-family: var(--mono); font-size: 13px; }
  header { padding: 12px 16px; background: var(--panel); border-bottom: 1px solid var(--border); }
  header h1 { font-size: 15px; margin: 0; font-weight: 600; }
  header .sub { color: var(--muted); margin-top: 4px; }
  main { max-width: 860px; margin: 0 auto; padding: 12px; display: grid; gap: 12px; }
  .panel { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; }
  .panel > h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .5px; color: var(--muted);
    margin: 0; padding: 8px 12px; border-bottom: 1px solid var(--border); background: #1c2128; }
  .panel > .body { padding: 10px 12px; }
  button { background: #21262d; color: var(--text); border: 1px solid var(--border); border-radius: 6px;
    padding: 6px 12px; font-family: var(--mono); font-size: 13px; cursor: pointer; }
  button:hover { border-color: var(--accent); }
  button.primary { background: #1f6feb; border-color: #1f6feb; color: #fff; font-weight: 600; }
  button.primary:hover { background: #388bfd; }
  button:disabled { opacity: .45; cursor: not-allowed; }
  input[type=text] { width: 100%; background: #0d1117; border: 1px solid var(--border); border-radius: 6px;
    color: var(--text); padding: 7px 9px; font-family: var(--mono); font-size: 13px; }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .list { margin-top: 8px; max-height: 220px; overflow-y: auto; border: 1px solid var(--border); border-radius: 6px; }
  .list:empty { display: none; }
  .item { display: flex; gap: 10px; align-items: center; padding: 6px 10px; border-bottom: 1px solid #21262d; cursor: pointer; }
  .item:last-child { border-bottom: none; }
  .item:hover { background: #1c2128; }
  .item.sel { background: #10233d; outline: 1px solid #1f6feb; }
  .item .nm { min-width: 140px; }
  .item .id { color: var(--warn); }
  .item .mail, .item .meta { color: var(--muted); overflow: hidden; text-overflow: ellipsis; }
  .badge { display: inline-block; padding: 1px 8px; border-radius: 10px; border: 1px solid var(--border); color: var(--muted); }
  .badge.on { color: var(--ok); border-color: var(--ok); }
  .badge.off { color: var(--bad); border-color: var(--bad); }
  .hint { color: var(--muted); margin-top: 6px; line-height: 1.6; }
  .hint code { color: var(--accent); }
  pre { margin: 8px 0 0; padding: 10px; background: #0d1117; border: 1px solid var(--border); border-radius: 6px;
    max-height: 260px; overflow: auto; white-space: pre-wrap; word-break: break-all; }
  #result-line { margin-top: 8px; font-weight: 600; }
  #result-line.ok { color: var(--ok); } #result-line.bad { color: var(--bad); }
  .steps b { color: var(--text); }
</style>
</head>
<body>
<header>
  <h1>채널톡(채널 웍스) 알림 테스트</h1>
  <div class="sub">버튼 → 서버(/channeltalk/*) → 채널톡 Open API. 키는 서버 밖으로 나가지 않는다.</div>
</header>
<main>

  <div class="panel">
    <h2>0. 연결 상태</h2>
    <div class="body">
      <div class="row">
        <span id="conf-badge" class="badge">확인 중…</span>
        <span id="conf-desc" class="hint"></span>
      </div>
      <div id="setup-help" class="hint" style="display:none">
        채널 데스크 → <b>설정 → API 키 관리</b>에서 키를 만들고,
        <code>packages/server/.env</code> 에 아래를 넣고 서버를 재시작:<br/>
        <code>CHANNELTALK_ACCESS_KEY=…</code> / <code>CHANNELTALK_ACCESS_SECRET=…</code>
        (예시는 <code>.env.example</code>)<br/>
        ⚠️ 오픈 API 는 요금제에 따라 막혀 있을 수 있다 — 401/403 이 계속 나오면 플랜부터 확인.
      </div>
    </div>
  </div>

  <div class="panel">
    <h2>1. 받을 사람 (매니저)</h2>
    <div class="body">
      <div class="row">
        <button id="btn-managers">매니저 목록 불러오기</button>
        <span class="hint">멘션·다이렉트 공지가 갈 사람을 클릭해서 선택</span>
      </div>
      <div id="managers" class="list"></div>
    </div>
  </div>

  <div class="panel">
    <h2>2. 팀챗 그룹 (그룹 멘션 방식일 때만)</h2>
    <div class="body">
      <div class="row">
        <button id="btn-groups">그룹 목록 불러오기</button>
        <span class="hint">다이렉트 공지만 테스트하면 건너뛰어도 됨</span>
      </div>
      <div id="groups" class="list"></div>
    </div>
  </div>

  <div class="panel">
    <h2>3. 전송</h2>
    <div class="body">
      <input type="text" id="msg" value="🧭 [테스트] 메디트래커 알림 연동 확인 — 이 메시지가 보이면 성공" />
      <div class="row" style="margin-top:8px">
        <button id="btn-group" class="primary" disabled>그룹에 멘션으로 보내기</button>
        <button id="btn-announce" class="primary" disabled>이 사람에게 다이렉트 공지</button>
        <span class="hint steps">선택: <b id="sel-mgr">매니저 없음</b> · <b id="sel-grp">그룹 없음</b></span>
      </div>
      <div id="result-line"></div>
      <pre id="result" style="display:none"></pre>
    </div>
  </div>

</main>
<script>
  const $ = (id) => document.getElementById(id);
  let managerId = '', managerName = '', groupPick = '';

  function refreshButtons() {
    $('sel-mgr').textContent = managerId ? managerName + ' (' + managerId + ')' : '매니저 없음';
    $('sel-grp').textContent = groupPick || '그룹 없음(.env 기본값 사용)';
    $('btn-announce').disabled = !managerId;
    $('btn-group').disabled = !managerId; // 그룹 미선택이면 서버가 .env 기본값을 쓴다
  }

  async function jget(url) { return (await fetch(url)).json(); }

  async function loadStatus() {
    try {
      const s = await jget('/channeltalk/status');
      const badge = $('conf-badge');
      if (s.configured) {
        badge.textContent = '키 설정됨'; badge.className = 'badge on';
        $('conf-desc').textContent = '봇 이름: ' + s.botName + (s.group ? ' · 기본 그룹: ' + s.group : '');
        if (s.managerId) { managerId = s.managerId; managerName = '(.env 기본값)'; }
        if (s.group) groupPick = '';
      } else {
        badge.textContent = '키 미설정'; badge.className = 'badge off';
        $('setup-help').style.display = 'block';
      }
      refreshButtons();
    } catch (e) {
      $('conf-badge').textContent = '서버 응답 없음'; $('conf-badge').className = 'badge off';
    }
  }

  function renderList(el, rows, render, onPick) {
    el.innerHTML = '';
    if (!rows.length) { el.innerHTML = '<div class="item"><span class="meta">목록이 비어 있음</span></div>'; return; }
    for (const r of rows) {
      const div = document.createElement('div');
      div.className = 'item';
      div.innerHTML = render(r);
      div.onclick = () => {
        el.querySelectorAll('.item').forEach((n) => n.classList.remove('sel'));
        div.classList.add('sel');
        onPick(r);
        refreshButtons();
      };
      el.appendChild(div);
    }
  }

  function showResult(r, extraHint) {
    const line = $('result-line'), pre = $('result');
    const hints = {
      0: '서버가 채널톡까지 못 갔다 — 키 미설정이거나 네트워크 문제',
      401: '키가 틀렸다 — Access Key/Secret 재확인',
      403: '권한 없음 — 요금제(오픈 API 포함 여부)나 키 권한 확인',
      404: '대상 없음 — 그룹 이름/ID 확인',
      422: '요청 형식 문제 — 응답 본문 참고',
      429: '요청 제한 초과 — 잠시 후 재시도',
    };
    line.className = r.ok ? 'ok' : 'bad';
    line.textContent = r.ok
      ? '✅ 전송 성공 (HTTP ' + r.status + ') — 채널톡에서 확인!'
      : '❌ 실패 (HTTP ' + r.status + ') ' + (hints[r.status] || '') + (extraHint || '');
    pre.style.display = 'block';
    pre.textContent = JSON.stringify(r.body, null, 2);
  }

  $('btn-managers').onclick = async () => {
    const r = await jget('/channeltalk/managers');
    if (!r.ok) return showResult(r);
    renderList($('managers'), (r.body.managers || []),
      (m) => '<span class="nm">' + m.name + '</span><span class="id">' + m.id + '</span><span class="mail">' + (m.email || '') + '</span>',
      (m) => { managerId = m.id; managerName = m.name; });
  };

  $('btn-groups').onclick = async () => {
    const r = await jget('/channeltalk/groups');
    if (!r.ok) return showResult(r);
    renderList($('groups'), (r.body.groups || []),
      (g) => '<span class="nm">' + g.name + '</span><span class="id">' + g.id + '</span><span class="meta">' + (g.scope || '') + '</span>',
      (g) => { groupPick = g.name; });
  };

  async function send(kind) {
    $('result-line').textContent = '전송 중…'; $('result-line').className = '';
    const res = await fetch('/channeltalk/send', {
      method: 'POST',
      body: JSON.stringify({ kind, managerId, managerName, text: $('msg').value, group: groupPick }),
    });
    showResult(await res.json(), kind === 'group' ? ' (그룹 미선택이면 CHANNELTALK_GROUP 필요)' : '');
  }
  $('btn-group').onclick = () => send('group');
  $('btn-announce').onclick = () => send('announce');

  loadStatus();
</script>
</body>
</html>`;
}
