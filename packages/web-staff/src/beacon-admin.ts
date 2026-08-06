import { GROUPS, groupColor } from './tag-panel';
import { escapeHtml } from './format';
import type { TagGroup } from '@meditracker/shared';

/**
 * 환자 등록 / 반납 — 인포 데스크가 쓰는 화면.
 *
 * **왜 별도 화면인가.** 왼쪽 비콘 목록은 *지금 추적 중인* 것만 보여준다(좌표가 오는 것만).
 * 그런데 등록할 대상은 **아무도 안 들고 있는 창고 비콘**이라 거기엔 애초에 안 나온다.
 * 그래서 재고 전체(`/beacons`)를 보는 화면이 따로 있어야 한다.
 *
 * 이름은 사람이 손으로 친다 — 베가스 CRM 연동은 나중이고, 붙어도 이 칸을 대신 채워주는
 * 것뿐이다.
 */

/** 목록 자동 갱신 주기. 입력 중 글자가 날아가지 않게 느슨하게 잡는다 */
const REFRESH_MS = 5000;

export interface BeaconRow {
  tagId: string;
  assigned: boolean;
  holder: string | null;
  name: string | null;
  group: TagGroup;
  assignedAt: number | null;
  lastSeen: number | null;
  lastGateway: string | null;
  lastRssi: number | null;
}

type Filter = 'all' | 'assigned' | 'idle';

export class BeaconAdmin {
  private rows: BeaconRow[] = [];
  private filter: Filter = 'all';
  private timer?: ReturnType<typeof setInterval>;
  private box: HTMLElement;
  private list: HTMLElement;

  constructor(
    private serverUrl: string,
    private onChanged: () => void,
  ) {
    this.box = document.getElementById('badmin')!;
    this.list = document.getElementById('badmin-list')!;

    document.getElementById('badmin-close')!.addEventListener('click', () => this.close());
    this.box.addEventListener('click', (e) => {
      if (e.target === this.box) this.close();
    });
    for (const b of Array.from(
      document.querySelectorAll<HTMLButtonElement>('#badmin-filter button'),
    )) {
      b.addEventListener('click', () => {
        this.filter = b.dataset.f as Filter;
        for (const o of Array.from(document.querySelectorAll('#badmin-filter button'))) {
          o.classList.toggle('on', o === b);
        }
        this.render();
      });
    }
    // 목록 버튼은 매번 다시 그려지므로 위임으로 받는다
    this.list.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-act]');
      if (!btn) return;
      const tagId = btn.dataset.tag!;
      if (btn.dataset.act === 'assign') this.promptAssign(tagId);
      else this.release(tagId);
    });
  }

  open(): void {
    this.box.hidden = false;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS);
  }

  close(): void {
    this.box.hidden = true;
    if (this.timer) clearInterval(this.timer);
  }

  private async refresh(): Promise<void> {
    try {
      const res = await fetch(`${this.serverUrl}/beacons`);
      this.rows = (await res.json()) as BeaconRow[];
      this.render();
    } catch {
      this.list.innerHTML = '<div class="badmin-empty">서버에 연결할 수 없습니다</div>';
    }
  }

  /** 이름을 받아 등록. 이름이 비면 등록하지 않는다 — 누가 들고 있는지 모르는 배정은 의미가 없다 */
  private promptAssign(tagId: string): void {
    const name = window.prompt(`비콘 ${tail(tagId)}\n\n환자 이름:`, '');
    if (name === null) return;
    if (!name.trim()) {
      window.alert('이름을 입력하세요');
      return;
    }
    void this.post('/assign', { tagId, name: name.trim() });
  }

  private release(tagId: string): void {
    const row = this.rows.find((r) => r.tagId === tagId);
    if (!window.confirm(`${row?.holder ?? tail(tagId)} — 반납할까요?\n\n추적이 멈추고 캐릭터 설정이 초기화됩니다.`)) {
      return;
    }
    void this.post('/release', { tagId });
  }

  private async post(path: string, body: unknown): Promise<void> {
    try {
      const res = await fetch(`${this.serverUrl}${path}`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      const d = (await res.json()) as { ok: boolean; error?: string };
      if (!d.ok) {
        window.alert(`실패: ${d.error ?? '알 수 없는 오류'}`);
        return;
      }
      await this.refresh();
      this.onChanged();
    } catch (err) {
      window.alert(`실패: ${(err as Error).message}`);
    }
  }

  private render(): void {
    const shown = this.rows.filter((r) =>
      this.filter === 'all' ? true : this.filter === 'assigned' ? r.assigned : !r.assigned,
    );
    const counts = {
      all: this.rows.length,
      assigned: this.rows.filter((r) => r.assigned).length,
      idle: this.rows.filter((r) => !r.assigned).length,
    };
    for (const b of Array.from(
      document.querySelectorAll<HTMLButtonElement>('#badmin-filter button'),
    )) {
      const n = counts[b.dataset.f as Filter];
      b.textContent = `${b.dataset.label} ${n}`;
    }

    if (shown.length === 0) {
      this.list.innerHTML = '<div class="badmin-empty">해당하는 비콘이 없습니다</div>';
      return;
    }

    // 직무별로 묶는다 — 인포는 '환자' 무리만 보면 되는 경우가 대부분이다
    let html = '';
    for (const g of GROUPS) {
      const inGroup = shown.filter((r) => (r.group ?? 'unassigned') === g.id);
      if (inGroup.length === 0) continue;
      html +=
        `<div class="badmin-gh"><i style="background:${hex(groupColor(g.id))}"></i>` +
        `${g.label} <b>${inGroup.length}</b></div>`;
      for (const r of inGroup) html += this.rowHtml(r);
    }
    this.list.innerHTML = html;
  }

  private rowHtml(r: BeaconRow): string {
    const who = r.assigned
      ? `<b class="badmin-who">${escapeHtml(r.holder ?? r.name ?? '이름 없음')}</b>`
      : `<span class="badmin-idle">창고 · ${lastSeenText(r.lastSeen)}</span>`;
    const action = r.assigned
      ? `<button class="badmin-btn rel" data-act="release" data-tag="${escapeHtml(r.tagId)}">반납</button>`
      : `<button class="badmin-btn asg" data-act="assign" data-tag="${escapeHtml(r.tagId)}">환자 등록</button>`;
    return (
      `<div class="badmin-row">` +
      `<code class="badmin-id" title="${escapeHtml(r.tagId)}">${tail(r.tagId)}</code>` +
      who +
      action +
      `</div>`
    );
  }
}

/** 비콘 식별용 뒷자리 — 팔찌에 인쇄될 번호와 같은 자리 */
function tail(tagId: string): string {
  return tagId.replace(/[^0-9A-Fa-f]/g, '').slice(-6).toUpperCase();
}

function hex(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}

/**
 * 마지막 신호. 창고 비콘은 이것만이 생사 확인 수단이라 **오래됐을수록 눈에 띄게** 쓴다 —
 * 배터리가 죽으면 꺼내 볼 때까지 모르는 게 제일 나쁘다.
 */
function lastSeenText(lastSeen: number | null): string {
  if (!lastSeen) return '<span class="badmin-dead">신호 없음</span>';
  const min = Math.floor((Date.now() - lastSeen) / 60000);
  if (min < 2) return '방금';
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  return `<span class="badmin-dead">${Math.floor(hr / 24)}일 전</span>`;
}
