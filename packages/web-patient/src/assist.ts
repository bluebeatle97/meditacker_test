import type { ZoneGender } from '@meditracker/shared';

/**
 * 환자가 **스스로 누르는** 두 버튼 — `화장실` 안내와 `통역 호출`.
 *
 * 지금까지 환자 화면의 안내는 전부 직원이 걸어야 나타났다(설계서 2.5). 이 둘은 그
 * 예외다: 화장실은 물어서 가는 곳이 아니고, 통역은 말이 안 통해서 부르는 것이라
 * 데스크까지 걸어가 말할 수 있으면 애초에 필요가 없다.
 *
 * Phaser 에 의존하지 않는 순수 DOM 으로 둔다 — 지도 렌더링이 실패한 기기(구형 폰·WebGL
 * 차단)에서도 버튼은 살아 있어야 하고, 브라우저 없이 규칙만 검증할 수 있어야 한다.
 *
 * ⚠️ 통역 호출은 **아직 서버에 붙지 않았다**. 화면 흐름만 먼저 세운 것이고, 그 사실을
 *    문구에서 숨기지 않는다(시연 배지와 같은 원칙 — 표시가 없으면 진짜로 오해한다).
 *    연동 지점: `POST /itp-request` + 액팅보드 수신 (액팅보드_구현지시서.md 5).
 */

/**
 * 통역 호출 재요청까지 기다리는 시간.
 *
 * 연동 후에는 서버가 정한다 — 지시서 5 의 운영값은 **5분**이다. 지금은 서버가 없어
 * 아무 일도 실제로 일어나지 않으므로, 눌러 보고 확인하는 데 5분을 기다리게 하지 않는다.
 */
const ITP_COOLDOWN_MS = 20_000;
/** 알림을 띄워 두는 시간 — 안내 도착 문구(GUIDE_DONE_MS)와 같은 감각으로 4초 */
const TOAST_MS = 4000;

export interface AssistHandlers {
  /**
   * 화장실을 고르고 눌렀다 — 안내를 켠다.
   * 목적지 방 이름을 돌려주면 버튼이 '안내 중' 이 되고, `null` 이면 실패로 본다
   * (길을 못 찾았거나 그 성별이 쓸 화장실이 없거나).
   */
  onToilet(gender: ZoneGender): string | null;
  /** 안내 중에 다시 눌렀다 — 끈다 */
  onToiletCancel(): void;
}

export interface AssistUi {
  /**
   * 화장실 안내 상태를 버튼에 반영한다.
   * 도착·직원 안내로의 교체처럼 **버튼 밖에서** 끝나는 경우가 있어 밖에서도 부른다.
   */
  setGuiding(on: boolean): void;
}

export function mountAssist(h: AssistHandlers): AssistUi {
  const toilet = document.getElementById('toilet-btn') as HTMLButtonElement | null;
  const pick = document.getElementById('toilet-pick');
  const itp = document.getElementById('itp-btn') as HTMLButtonElement | null;
  const toast = document.getElementById('itp-toast');

  let guiding = false;
  const setGuiding = (on: boolean): void => {
    guiding = on;
    if (!toilet) return;
    toilet.classList.toggle('guiding', on);
    label(toilet, on ? '안내 끄기' : '화장실');
  };
  const openPick = (on: boolean): void => {
    pick?.classList.toggle('show', on);
  };
  // NodeList 는 이 tsconfig(lib 에 dom.iterable 없음)에서 순회할 수 없다 — 배열로 받는다
  const picked = pick
    ? Array.from(pick.querySelectorAll<HTMLButtonElement>('[data-gender]'))
    : [];

  toilet?.addEventListener('click', (e) => {
    e.stopPropagation(); // 아래 '바깥을 누르면 닫는다' 가 방금 연 것을 바로 닫지 않게
    if (guiding) {
      h.onToiletCancel();
      setGuiding(false);
      return;
    }
    // 성별을 묻는다 — 이 도면은 공용 1곳·여자용 2곳이라 답이 갈린다
    openPick(!pick?.classList.contains('show'));
  });

  for (const btn of picked) {
    btn.addEventListener('click', (e: MouseEvent) => {
      e.stopPropagation();
      openPick(false);
      const to = h.onToilet(btn.dataset.gender as ZoneGender);
      setGuiding(to !== null);
      // 길을 못 찾는 경우가 실제로 있다(추적 구역 밖에서 입장, 도면 밖 좌표) —
      // 버튼이 아무 반응도 안 하면 고장으로 보인다
      if (to === null) {
        show(
          toast,
          '<b>화장실 안내를 못 만들었어요</b><span>가까운 직원에게 말씀해 주세요</span>',
        );
      }
    });
  }
  // 지도를 누르면 닫힌다 — 고르기 창은 한 번 누르면 끝나는 것이라 닫는 버튼을 따로 두지 않는다
  document.addEventListener('click', () => openPick(false));

  /**
   * 통역 호출 — 지금은 화면 흐름만 있다.
   *
   * 눌렀다는 사실이 남지 않으므로 **되돌아오는 상태가 없다**: 지시서의 "수락되면
   * 통역사가 가고 있어요" 는 소켓이 붙은 뒤에 온다. 그전에 그 문구를 흉내 내면
   * 오지 않는 통역사를 기다리게 된다 — 여기서는 '알렸다' 까지만 말한다.
   */
  itp?.addEventListener('click', () => {
    if (itp.disabled) return;
    itp.disabled = true;
    label(itp, '호출 중…');
    // 서버 왕복이 있는 것처럼 한 박자 둔다 — 즉시 바뀌면 눌렀는지조차 애매하다
    window.setTimeout(() => {
      label(itp, '호출했어요');
      show(
        toast,
        '<b>통역사에게 알렸어요</b><span>연동 준비 중인 기능입니다 — 실제로 호출되지 않습니다</span>',
      );
      window.setTimeout(() => {
        itp.disabled = false;
        label(itp, '통역 호출');
      }, ITP_COOLDOWN_MS);
    }, 700);
  });

  return { setGuiding };
}

/** 버튼 라벨만 바꾼다 (아이콘은 그대로 둬야 하므로 textContent 를 쓸 수 없다) */
function label(btn: HTMLElement, text: string): void {
  const el = btn.querySelector('.lbl');
  if (el) el.textContent = text;
}

let toastTimer = 0;
function show(el: HTMLElement | null, html: string): void {
  if (!el) return;
  el.innerHTML = html;
  el.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove('show'), TOAST_MS);
}
