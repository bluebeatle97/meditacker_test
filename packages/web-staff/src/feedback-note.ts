import { authFetch } from './api';
import { agoText, escapeHtml } from './format';
import type { FeedbackKind, FeedbackNote } from '@meditracker/shared';

/**
 * 피드백 노트 — 직원이 보던 화면에서 그대로 버그·개선안을 남긴다.
 *
 * **왜 이슈 트래커가 아닌가.** 신고하는 사람은 현장 직원이고 트래커 계정이 없다. 지금은
 * 구두나 메신저로 넘어오는데, 그때 늘 빠지는 게 "언제 어느 화면이었나" 다. 화면 안에서
 * 받으면 그 맥락을 **사람이 적지 않아도** 같이 담을 수 있다 (`hooks.context`).
 *
 * ⚠️ 처리된 메모도 목록에 남긴다(흐리게). 숨기면 이미 고친 것을 계속 다시 신고받는다.
 *
 * ⚠️ 자동 갱신을 안 한다 — 글을 치는 화면이라 5초마다 다시 그리면 입력 중인 내용이
 *    날아간다 (장비 관리 화면과 같은 이유). 열 때와 저장·상태변경 직후에만 다시 읽는다.
 */

export interface FeedbackHooks {
  /**
   * 지금 화면 상태 한 줄. 신고자가 적을 수 없거나 적기 귀찮은 것만 넣는다
   * (확대 배율·추적 태그 수·선택한 비콘 등).
   */
  context: () => string;
  /** 미처리 건수가 바뀌었다 — 버튼 배지를 고치라고 알린다 */
  onCount?: (open: number) => void;
}

const KIND_LABEL: Record<FeedbackKind, string> = { bug: '버그', idea: '개선', etc: '기타' };

export class FeedbackNotes {
  private root = document.getElementById('fb') as HTMLElement | null;
  private listEl = document.getElementById('fb-list') as HTMLElement | null;
  private bodyEl = document.getElementById('fb-body') as HTMLTextAreaElement | null;
  private authorEl = document.getElementById('fb-author') as HTMLInputElement | null;
  private sendEl = document.getElementById('fb-send') as HTMLButtonElement | null;
  private msgEl = document.getElementById('fb-msg') as HTMLElement | null;
  private kind: FeedbackKind = 'bug';
  private wired = false;

  constructor(
    private serverUrl: string,
    private hooks: FeedbackHooks,
  ) {}

  async open(): Promise<void> {
    if (!this.root) return;
    this.wire();
    this.root.hidden = false;
    this.bodyEl?.focus();
    await this.refresh();
  }

  close(): void {
    if (this.root) this.root.hidden = true;
  }

  /** 열지 않고 배지만 채운다 (화면 뜰 때 한 번) */
  async pollCount(): Promise<void> {
    try {
      const r = await authFetch(`${this.serverUrl}/feedback?limit=1`);
      const d = (await r.json()) as { open: number };
      this.hooks.onCount?.(d.open);
    } catch {
      /* 서버가 아직 안 떴을 수 있다 — 배지는 다음 기회에 */
    }
  }

  private wire(): void {
    if (this.wired) return;
    this.wired = true;

    document.getElementById('fb-close')?.addEventListener('click', () => this.close());
    // 바깥을 눌러도 닫힌다. 단, 창 안쪽 클릭이 새어 나온 경우는 제외
    this.root?.addEventListener('click', (e) => {
      if (e.target === this.root) this.close();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.root && !this.root.hidden) this.close();
    });

    document.querySelectorAll<HTMLButtonElement>('#fb-kinds button').forEach((b) => {
      b.addEventListener('click', () => {
        this.kind = (b.dataset.kind as FeedbackKind) ?? 'etc';
        document
          .querySelectorAll('#fb-kinds button')
          .forEach((o) => o.classList.toggle('on', o === b));
      });
    });

    this.sendEl?.addEventListener('click', () => void this.send());
    // Ctrl+Enter 로 보내기 — 여러 줄을 적는 칸이라 Enter 는 줄바꿈이어야 한다
    this.bodyEl?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void this.send();
    });
  }

  private say(text: string, isError = false): void {
    if (!this.msgEl) return;
    this.msgEl.textContent = text;
    this.msgEl.classList.toggle('err', isError);
  }

  private async send(): Promise<void> {
    const body = (this.bodyEl?.value ?? '').trim();
    if (!body) {
      this.say('내용을 입력하세요', true);
      this.bodyEl?.focus();
      return;
    }
    if (this.sendEl) this.sendEl.disabled = true;
    try {
      const r = await authFetch(`${this.serverUrl}/feedback`, {
        method: 'POST',
        // Content-Type 을 붙이지 않는다. 원래는 프리플라이트(OPTIONS)를 피하려는 것이었는데,
        // 이제 authFetch 가 Authorization 헤더를 붙이므로 프리플라이트는 어차피 뜬다
        // (서버에 OPTIONS 핸들러가 생겼다 — index.ts 맨 위). 서버는 본문을 JSON.parse 로
        // 읽으니 헤더가 필요 없어 그대로 둔다.
        body: JSON.stringify({
          kind: this.kind,
          body,
          author: this.authorEl?.value ?? '',
          context: this.hooks.context(),
        }),
      });
      const d = (await r.json()) as { ok: boolean; error?: string; open?: number };
      if (!d.ok) throw new Error(d.error ?? '저장 실패');
      // 이름은 남겨 둔다 — 같은 사람이 연달아 적는 경우가 대부분이다
      if (this.bodyEl) this.bodyEl.value = '';
      this.say('남겼습니다. 고맙습니다.');
      if (d.open !== undefined) this.hooks.onCount?.(d.open);
      await this.refresh();
    } catch (e) {
      this.say((e as Error).message, true);
    } finally {
      if (this.sendEl) this.sendEl.disabled = false;
    }
  }

  private async post(path: string, payload: unknown): Promise<void> {
    try {
      const r = await authFetch(`${this.serverUrl}${path}`, {
        method: 'POST',
        // 헤더를 붙이지 않는 이유는 send() 의 주석 참고 (프리플라이트 회피)
        body: JSON.stringify(payload),
      });
      const d = (await r.json()) as { ok: boolean; error?: string; open?: number };
      if (!d.ok) throw new Error(d.error ?? '실패');
      if (d.open !== undefined) this.hooks.onCount?.(d.open);
      await this.refresh();
    } catch (e) {
      this.say((e as Error).message, true);
    }
  }

  private async refresh(): Promise<void> {
    if (!this.listEl) return;
    let notes: FeedbackNote[] = [];
    try {
      const r = await authFetch(`${this.serverUrl}/feedback?limit=200`);
      const d = (await r.json()) as { notes: FeedbackNote[]; open: number };
      notes = d.notes;
      this.hooks.onCount?.(d.open);
    } catch {
      this.listEl.innerHTML = '<div id="fb-empty">목록을 불러오지 못했습니다.</div>';
      return;
    }

    if (notes.length === 0) {
      this.listEl.innerHTML = '<div id="fb-empty">아직 남긴 메모가 없습니다.</div>';
      return;
    }

    const now = Date.now();
    this.listEl.innerHTML = notes
      .map((n) => {
        const who = [n.author, agoText(now - n.createdAt)].filter(Boolean).join(' · ');
        return `<div class="fb-row${n.status === 'done' ? ' done' : ''}">
          <div class="fb-top">
            <span class="fb-kind ${n.kind}">${KIND_LABEL[n.kind] ?? '기타'}</span>
            <span class="fb-who">${escapeHtml(who)}</span>
            <button class="fb-act" data-act="${n.status === 'done' ? 'open' : 'done'}" data-id="${n.id}">${
              n.status === 'done' ? '되돌리기' : '처리함'
            }</button>
            <button class="fb-act del" data-act="del" data-id="${n.id}">삭제</button>
          </div>
          <p class="fb-text">${escapeHtml(n.body)}</p>
          ${n.context ? `<div class="fb-ctx">${escapeHtml(n.context)}</div>` : ''}
        </div>`;
      })
      .join('');

    this.listEl.querySelectorAll<HTMLButtonElement>('.fb-act').forEach((b) => {
      b.addEventListener('click', () => {
        const id = Number(b.dataset.id);
        if (b.dataset.act === 'del') {
          // 지우면 못 되살린다 — 처리 완료(되돌릴 수 있음)와 다르므로 한 번 묻는다
          if (!confirm('이 메모를 지울까요? 되돌릴 수 없습니다.')) return;
          void this.post('/feedback/delete', { id });
        } else {
          void this.post('/feedback/status', { id, status: b.dataset.act });
        }
      });
    });
  }
}
