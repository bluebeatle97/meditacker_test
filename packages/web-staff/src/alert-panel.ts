import { agoText, escapeHtml } from './format';

/**
 * 환자 장기체류 경고창 (직원용 화면).
 *
 * 환자 비콘이 같은 구역에서 `STUCK_ALERT_MS` 넘게 안 움직이면 — 대기가 밀렸거나
 * 시술 뒤 회복실에 방치됐을 수 있다 — 화면 위 가운데에 경고를 띄운다.
 * 직원이 다른 일을 보다가도 알아채야 하므로 **빨간 ! 표가 깜빡인다**
 * (맵 아바타 위 배지 · 비콘 목록 · 이 창이 모두 같은 표시를 쓴다).
 *
 * ⚠️ 불변식 B-5: 브라우저 스토리지 사용 금지 — '확인' 상태는 메모리에만 둔다.
 *    새로고침하면 다시 뜬다. 놓치는 것보다 다시 뜨는 편이 안전하다.
 */

/** 같은 자리에 이 시간 이상 머문 환자 비콘은 경고 대상 */
export const STUCK_ALERT_MS = 10 * 60 * 1000;

export interface StuckAlert {
  tagId: string;
  /** 화면에 보이는 이름 (지정 전이면 태그 뒷자리) */
  label: string;
  /** 머무르고 있는 구역 이름 */
  zoneName: string;
  /** 그 구역에 머문 시간 (ms) */
  heldMs: number;
}

interface RowEls {
  li: HTMLLIElement;
  who: HTMLButtonElement;
  sub: HTMLElement;
}

export class AlertPanel {
  private list: HTMLUListElement;
  private countEl: HTMLElement;
  private rows = new Map<string, RowEls>();
  /** 지금 붙어 있는 줄 순서 — 바뀔 때만 DOM 을 다시 붙인다 */
  private shown: string[] = [];

  constructor(
    private box: HTMLElement,
    /** 이름을 누르면 맵에서 그 비콘으로 이동·강조 */
    private onPick: (tagId: string) => void,
    /** '확인' — 지금 그 자리에 대해서만 경고를 끈다 */
    private onAck: (tagId: string) => void,
  ) {
    this.list = box.querySelector('#alerts-list') as HTMLUListElement;
    this.countEl = box.querySelector('#alerts-n') as HTMLElement;
  }

  /** 경고 목록 갱신 — 비어 있으면 창 자체가 사라진다 */
  render(alerts: StuckAlert[]): void {
    this.box.hidden = alerts.length === 0;
    this.countEl.textContent = String(alerts.length);

    for (const a of alerts) {
      const els = this.rows.get(a.tagId) ?? this.createRow(a.tagId);
      els.who.textContent = a.label;
      els.sub.innerHTML =
        `<b>${escapeHtml(a.zoneName)}</b> · ${escapeHtml(agoText(a.heldMs))}째 같은 자리`;
    }

    const keys = alerts.map((a) => a.tagId);
    if (keys.join('|') === this.shown.join('|')) return;
    for (const k of keys) this.list.appendChild(this.rows.get(k)!.li);
    for (const [tagId, els] of this.rows) {
      if (keys.includes(tagId)) continue;
      els.li.remove();
      this.rows.delete(tagId);
    }
    this.shown = keys;
  }

  private createRow(tagId: string): RowEls {
    const li = document.createElement('li');
    li.className = 'alert-row';
    li.innerHTML = `
      <div class="top">
        <i class="bang">!</i>
        <button class="who" type="button" title="맵에서 이 비콘 찾기"></button>
        <button class="ack" type="button" title="이 자리에 대해서는 그만 알리기">확인</button>
      </div>
      <div class="sub"></div>`;
    const els: RowEls = {
      li,
      who: li.querySelector('.who') as HTMLButtonElement,
      sub: li.querySelector('.sub') as HTMLElement,
    };
    els.who.addEventListener('click', () => this.onPick(tagId));
    (li.querySelector('.ack') as HTMLButtonElement).addEventListener('click', () =>
      this.onAck(tagId),
    );

    this.rows.set(tagId, els);
    return els;
  }
}
