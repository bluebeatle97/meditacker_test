import { GROUPS, groupColor } from './tag-panel';
import { authFetch } from './api';
import { escapeHtml } from './format';
import type { TagGroup, Zone } from '@meditracker/shared';

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
  /** 팔찌에 인쇄되는 번호 (MAC 뒷 6자리) */
  pin: string;
  /** 이미 어느 기기가 QR 로 입장했나 — 폰을 바꾸면 풀어줘야 한다 */
  claimed: boolean;
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

/** 목적지 목록을 묶는 순서와 이름 — 방이 27개라 한 줄로 늘어놓으면 못 찾는다 */
const DEST_GROUPS: Array<[string, string]> = [
  ['consult', '상담'],
  ['surgery', '수술·시술'],
  ['laser', '레이저'],
  ['skincare', '피부관리'],
  ['recovery', '회복'],
  ['waiting', '대기'],
  ['reception', '접수'],
  ['etc', '기타'],
];

export class BeaconAdmin {
  private rows: BeaconRow[] = [];
  private filter: Filter = 'all';
  private timer?: ReturnType<typeof setInterval>;
  private box: HTMLElement;
  private list: HTMLElement;

  constructor(
    private serverUrl: string,
    private onChanged: () => void,
    /** 안내 목적지 후보 — 서버와 같은 규칙(isGuidableZone)으로 이미 걸러진 것 */
    private destinations: Zone[],
    /** 지금 안내 중인 방 (직원용 화면이 소켓으로 받아 둔 것) */
    private guidanceOf: (tagId: string) => string | null,
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
      const act = btn.dataset.act;
      if (act === 'assign') this.promptAssign(tagId);
      else if (act === 'reset') this.resetClaim(tagId);
      else if (act === 'guide-stop') void this.post('/guide', { tagId, zoneId: null });
      else this.release(tagId);
    });
    // 방 안내는 드롭다운 — 고르는 즉시 건다
    this.list.addEventListener('change', (e) => {
      const sel = (e.target as HTMLElement).closest<HTMLSelectElement>('select[data-tag]');
      if (!sel?.value) return;
      void this.post('/guide', { tagId: sel.dataset.tag, zoneId: sel.value });
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
      const res = await authFetch(`${this.serverUrl}/beacons`);
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

  /** 환자가 폰을 바꾸거나 기록을 지우면 다시 못 들어온다 — 데스크에서 풀어준다 */
  private resetClaim(tagId: string): void {
    const row = this.rows.find((r) => r.tagId === tagId);
    if (!window.confirm(`${row?.holder ?? tail(tagId)} — 입장을 초기화할까요?

팔찌 QR 을 다시 찍어야 들어옵니다.`)) {
      return;
    }
    void this.post('/reset-claim', { tagId });
  }

  private async post(path: string, body: unknown): Promise<void> {
    try {
      const res = await authFetch(`${this.serverUrl}${path}`, {
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

  /**
   * 목적지 27개를 종류별 묶음으로 — 펼침 목록이 아니라 드롭다운이다.
   * 줄마다 방 27개를 늘어놓으면 목록이 그것만으로 꽉 찬다.
   */
  private destOptions(tagId: string): string {
    let html = `<select class="badmin-gsel" data-tag="${escapeHtml(tagId)}">`;
    html += '<option value="">🧭 방 안내…</option>';
    for (const [type, label] of DEST_GROUPS) {
      const rooms = this.destinations.filter((z) => z.type === type);
      if (!rooms.length) continue;
      html += `<optgroup label="${label}">`;
      for (const z of rooms) {
        html += `<option value="${escapeHtml(z.zoneId)}">${escapeHtml(z.name)}</option>`;
      }
      html += '</optgroup>';
    }
    return html + '</select>';
  }

  private rowHtml(r: BeaconRow): string {
    /**
     * **비콘의 이름은 6자리 코드 하나다** (왼쪽 `badmin-id`). 별명을 따로 두지 않는다 —
     * 두 이름이 있으면 어느 쪽이 진짜인지 매번 헷갈리고, 실제로 목록에서 별명만 고쳐
     * 놓고 여기가 안 바뀐다고 헤맸다.
     *
     * 그래서 이 자리에는 **사람 이름만** 온다. 팔찌를 대조할 때는 6자리 코드를 본다
     * (비콘 목록에도 같은 코드가 회색으로 붙어 있다).
     */
    // 빈 문자열도 이름 없음이다 (`??` 만 쓰면 '' 가 그대로 통과해 빈 칸이 된다)
    const who = r.assigned
      ? `<b class="badmin-who">${escapeHtml(r.holder?.trim() || '이름 없음')}</b>`
      : `<span class="badmin-idle">창고 · ${lastSeenText(r.lastSeen)}</span>`;
    // 입장한 팔찌만 초기화가 의미 있다 (아직 안 찍었으면 그냥 찍으면 된다)
    const reset =
      r.assigned && r.claimed
        ? `<button class="badmin-btn rst" data-act="reset" data-tag="${escapeHtml(r.tagId)}" title="환자가 폰을 바꿨을 때">입장 초기화</button>`
        : '';
    // 방 안내는 **환자에게만**. 직원은 환자용 화면을 안 쓰므로 화살표를 볼 데가 없다
    const going = this.guidanceOf(r.tagId);
    const guide =
      r.assigned && r.group === 'patient'
        ? going
          ? `<span class="badmin-going">→ ${escapeHtml(this.nameOf(going))}</span>` +
            `<button class="badmin-btn gst" data-act="guide-stop" data-tag="${escapeHtml(r.tagId)}">안내 끝</button>`
          : this.destOptions(r.tagId)
        : '';
    const action = r.assigned
      ? `<button class="badmin-btn rel" data-act="release" data-tag="${escapeHtml(r.tagId)}">반납</button>`
      : `<button class="badmin-btn asg" data-act="assign" data-tag="${escapeHtml(r.tagId)}">환자 등록</button>`;
    return (
      `<div class="badmin-row">` +
      `<code class="badmin-id" title="${escapeHtml(r.tagId)}">${escapeHtml(r.pin ?? tail(r.tagId))}</code>` +
      who +
      guide +
      reset +
      action +
      `</div>`
    );
  }

  private nameOf(zoneId: string): string {
    return this.destinations.find((z) => z.zoneId === zoneId)?.name ?? zoneId;
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
