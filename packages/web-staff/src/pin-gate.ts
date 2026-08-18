/**
 * 직원용 패널 진입 핀.
 *
 * **왜 필요한가.** 이 화면은 전원의 실명과 위치를 띄운다. 예전에는 화면이 열릴 때 서버가
 * 토큰을 그냥 내줬다(`/dev-token`) — 링크를 아는 사람은 곧 전원의 위치를 보는 사람이었다.
 * 이제 서버가 핀을 받고 토큰을 준다(`POST /staff-token`).
 *
 * **서버가 없으면 묻지 않는다.** 정적 호스팅 시연판에는 물어볼 상대가 없다. 그때는 빈
 * 문자열을 돌려주고 화면은 시연 모드로 간다 — 핀 상자가 떠 있는데 아무 핀도 안 통하는
 * 화면이 되면 안 된다.
 *
 * **한 번 넣으면 2시간은 다시 묻지 않는다.** 서버가 `HttpOnly` 세션 쿠키를 발행한다
 * (`POST /staff-token` → `Set-Cookie`). 새로고침하면 `GET /staff-token` 이 그 쿠키를 보고
 * 토큰을 돌려주므로 핀 상자가 안 뜬다 — 테스트 장비 토글이 화면을 새로고침해서 그때마다
 * 핀을 묻던 것이 이것 때문에 사라졌다.
 *
 * ⚠️ 불변식 B-5(브라우저 스토리지 금지)와 부딪히지 않는다. B-5 가 막는 것은 **앱 상태**를
 *    브라우저에 두는 것이다 — 서버 값과 어긋나고 기기가 바뀌면 사라지기 때문이다. 이 쿠키는
 *    서버가 발행하고 서버가 검증하는 **인증 세션**이고, `HttpOnly` 라 화면 스크립트는 값을
 *    읽지도 못한다. 토큰 사본은 여전히 메모리에만 둔다.
 */

/** 이 시간 안에 답이 없으면 서버가 없는 것으로 본다 (demo-mode 의 탐지와 같은 기준) */
const PROBE_TIMEOUT_MS = 3500;

interface TokenReply {
  token?: string;
  error?: string;
}

/**
 * 진입 토큰을 구한다.
 *
 * 1. 주소에 `?token=` 이 있으면 그것 (개발·딥링크용)
 * 2. `GET /staff-token` — 개발 서버는 핀 없이 내준다
 * 3. 401 이면 핀을 묻는다. 서버 자체가 없으면 `''`
 */
export async function resolveStaffToken(serverUrl: string): Promise<string> {
  const urlToken = new URLSearchParams(window.location.search).get('token');
  if (urlToken) return urlToken;

  try {
    const res = await fetch(`${serverUrl}/staff-token`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (res.ok) return ((await res.json()) as TokenReply).token ?? '';
    // 401 = 핀이 필요하다. 그 밖의 응답(500 등)은 물어봐도 소용없다
    if (res.status !== 401) return '';
  } catch {
    return ''; // 서버가 없다 — 시연 모드로 간다
  }

  return askPin(serverUrl);
}

/** 핀 상자를 띄우고, 맞을 때까지 기다린다 */
function askPin(serverUrl: string): Promise<string> {
  const { overlay, input, button, message } = buildBox();
  document.body.appendChild(overlay);
  input.focus();

  return new Promise<string>((resolve) => {
    const submit = async (): Promise<void> => {
      const pin = input.value.trim();
      if (!pin) return;
      button.disabled = true;
      message.textContent = '확인 중…';
      message.style.color = '#8b949e';
      try {
        const res = await fetch(`${serverUrl}/staff-token`, {
          method: 'POST',
          body: JSON.stringify({ pin }),
        });
        const body = (await res.json()) as TokenReply;
        if (res.ok && body.token) {
          overlay.remove();
          resolve(body.token);
          return;
        }
        message.textContent = body.error ?? '핀이 맞지 않습니다';
        message.style.color = '#f85149';
        input.value = '';
        input.focus();
      } catch {
        message.textContent = '서버에 연결할 수 없습니다';
        message.style.color = '#f85149';
      } finally {
        button.disabled = false;
      }
    };

    button.addEventListener('click', () => void submit());
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void submit();
    });
  });
}

/**
 * 상자를 코드로 만든다 — `index.html` 을 건드리지 않는다.
 *
 * ⚠️ 칸 크기를 다 고정한다. 메시지가 생겼다 없어질 때 상자가 늘었다 줄면 누르려던 버튼이
 *    움직인다.
 *
 * ⚠️ 입력창과 버튼은 `box-sizing:border-box` 로 **폭·높이를 같게** 맞춘다. 기본값
 *    (content-box)에서는 `width:100%` 에 좌우 padding 과 테두리가 더해져 입력창만
 *    22px 넓어진다 — 상자 안에서 한 칸이 삐져나와 보인다.
 */
function buildBox(): {
  overlay: HTMLDivElement;
  input: HTMLInputElement;
  button: HTMLButtonElement;
  message: HTMLDivElement;
} {
  const overlay = document.createElement('div');
  overlay.style.cssText = [
    'position:fixed',
    'inset:0',
    'z-index:9999',
    'background:rgba(13,17,23,0.94)',
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'font-family:system-ui,-apple-system,"Malgun Gothic",sans-serif',
  ].join(';');

  const box = document.createElement('div');
  box.style.cssText = [
    'width:300px',
    'padding:24px',
    'background:#161b22',
    'border:1px solid #30363d',
    'border-radius:10px',
    'text-align:center',
    'color:#c9d1d9',
  ].join(';');

  const title = document.createElement('div');
  title.textContent = 'MediTracker 직원용';
  title.style.cssText = 'font-size:15px;font-weight:600;margin-bottom:6px';

  const hint = document.createElement('div');
  hint.textContent = '진입 핀을 입력하세요.';
  hint.style.cssText = 'font-size:12px;color:#8b949e;margin-bottom:14px';

  /** 입력창과 버튼이 공유하는 상자 — 이 값이 어긋나면 한 칸이 삐져나온다 */
  const FIELD = [
    'box-sizing:border-box',
    'display:block',
    'width:100%',
    'height:38px',
    'border-radius:6px',
    'font-family:inherit',
    'font-size:14px',
  ];

  const input = document.createElement('input');
  input.type = 'password';
  input.inputMode = 'numeric';
  input.autocomplete = 'off';
  input.placeholder = '핀';
  input.style.cssText = [
    ...FIELD,
    'padding:0 10px',
    'text-align:center',
    'letter-spacing:4px',
    'background:#0d1117',
    'color:#c9d1d9',
    'border:1px solid #30363d',
  ].join(';');

  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = '들어가기';
  button.style.cssText = [
    ...FIELD,
    'margin-top:10px',
    'border:1px solid #4d5b8a',
    'background:#1b2136',
    'color:#b9c4e6',
    'cursor:pointer',
  ].join(';');

  // 높이 고정 — 오류 문구가 떠도 상자가 들썩이지 않게
  const message = document.createElement('div');
  message.style.cssText = 'height:18px;margin-top:10px;font-size:12px;color:#f85149';

  box.append(title, hint, input, button, message);
  overlay.appendChild(box);
  return { overlay, input, button, message };
}
