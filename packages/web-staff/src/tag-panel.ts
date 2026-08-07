import type { TagGroup, Zone } from '@meditracker/shared';
import { agoText, escapeHtml } from './format';

/**
 * 왼쪽 비콘 목록 패널 (직원용 화면).
 *
 * 맵 위 아바타는 색 점이라 누가 누군지 알기 어렵다 — 여기서 태그별로
 * 비콘 아이콘 · 이름 · 현재 상태 · 메모를 한 줄로 보여주고 그 자리에서 고친다.
 *
 * 배치 규칙 (사용자 요구):
 * - 맵 위에 **겹쳐서** 뜬다 — 패널을 접고 펴도 맵 크기·위치가 흔들리지 않는다.
 * - 그룹 버튼(의사/간호사/통역/환자/미지정)은 **자리가 고정**이다.
 *   그룹을 열면 그 목록은 버튼들 **아래(맨밑)** 에 펼쳐지므로 버튼이 밀리지 않는다.
 *
 * Phaser 대신 DOM 으로 만든다: 입력 필드·스크롤·포커스는 브라우저가 잘 하는 일이다.
 * ⚠️ 불변식 B-5: 브라우저 스토리지 사용 금지 — 편집값은 서버(/tag-meta)로만 보낸다.
 */

/**
 * 표시 순서 = 버튼 순서. 화면 라벨·색은 프론트가 소유한다 (타입만 shared).
 * 색은 그룹에 못 박아 맵 위 점 · 목록 아이콘 · 그룹 버튼이 모두 같은 색을 쓴다.
 */
export const GROUPS: ReadonlyArray<{ id: TagGroup; label: string; color: number }> = [
  { id: 'doctor', label: '의사', color: 0x4aa3ff },
  { id: 'nurse', label: '간호사', color: 0x06d6a0 },
  { id: 'interpreter', label: '통역', color: 0xb98ce0 },
  { id: 'patient', label: '환자', color: 0xffd166 },
  { id: 'unassigned', label: '미지정', color: 0x8b98a8 },
];

/** 그룹 색 (모르는 값은 미지정 회색) */
export function groupColor(group: TagGroup | undefined): number {
  return GROUPS.find((g) => g.id === group)?.color ?? 0x8b98a8;
}

export interface TagRow {
  tagId: string;
  /** 맵 아바타와 같은 색 (0xRRGGBB) — 목록과 점을 눈으로 연결 */
  color: number;
  name: string;
  memo: string;
  group: TagGroup;
  /** null = 추적구역 밖(자리비움) */
  zoneName: string | null;
  /** 현재 존 진입 시각 (ms) */
  enteredAt: number;
  /** 마지막 신호 수신 시각 (ms) */
  lastSeen: number;
  /** 장기체류 경고 중 — 빨간 ! 를 깜빡인다 (맵 배지·경고창과 같은 표시) */
  alert: boolean;
  /** 안내 중인 목적지 방 (없으면 null). 환자 그룹에만 쓰인다 */
  guideZoneId: string | null;
}

/** 신호가 이 시간 안이면 '정상', 그 뒤로는 '지연' → 이후는 자리비움 판정(서버 15초) */
const FRESH_MS = 6000;
const STALE_MS = 15000;

const BEACON_SVG = `
<svg viewBox="0 0 24 24" aria-hidden="true">
  <path d="M6.4 6.6a8.5 8.5 0 0 0 0 10.8" />
  <path d="M17.6 6.6a8.5 8.5 0 0 1 0 10.8" />
  <path d="M9.4 9.6a4.5 4.5 0 0 0 0 4.8" opacity=".55" />
  <path d="M14.6 9.6a4.5 4.5 0 0 1 0 4.8" opacity=".55" />
  <circle cx="12" cy="12" r="3.1" />
</svg>`;

function hex(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}

interface RowEls {
  li: HTMLLIElement;
  /** 방 안내 줄 — 환자 그룹에만 내용이 찬다 */
  guide: HTMLDivElement;
  beacon: HTMLSpanElement;
  name: HTMLInputElement;
  memo: HTMLInputElement;
  group: HTMLSelectElement;
  status: HTMLDivElement;
}

/** 목적지 목록을 묶는 순서와 이름 */
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

export class TagPanel {
  private rows = new Map<string, RowEls>();
  private tabs = new Map<TagGroup, { btn: HTMLButtonElement; num: HTMLElement }>();
  private list: HTMLUListElement;
  private empty: HTMLElement;
  private countEl: HTMLElement;
  private groupTitle: HTMLElement;
  private root: HTMLElement;
  private openGroup: TagGroup | null = null;
  /** 지금 화면에 붙어 있는 줄 순서 — 바뀔 때만 DOM 을 다시 붙인다(한글 조합 끊김 방지) */
  private shown: string[] = [];
  private latest = new Map<string, TagRow>();

  /** 목적지 목록을 펼쳐 둔 비콘 (한 번에 하나만) */
  private guidePickFor: string | null = null;

  constructor(
    root: HTMLElement,
    private onSave: (tagId: string, name: string, memo: string, group: TagGroup) => void,
    private onPick: (tagId: string) => void,
    /** 안내 목적지 후보 — 서버와 같은 규칙(isGuidableZone)으로 걸러진 것 */
    private destinations: Zone[] = [],
    /** 방 안내 걸기/끄기. zoneId 가 null 이면 해제 */
    private onGuide: (tagId: string, zoneId: string | null) => void = () => {},
  ) {
    this.root = root;
    this.list = root.querySelector('#tag-list') as HTMLUListElement;
    this.empty = root.querySelector('#tag-empty') as HTMLElement;
    this.countEl = root.querySelector('#tag-count') as HTMLElement;
    this.groupTitle = root.querySelector('#group-title') as HTMLElement;

    // 패널 접기/펴기 — 맵은 그대로 두고 이 패널만 접힌다
    const toggle = root.querySelector('#panel-toggle') as HTMLButtonElement;
    toggle.addEventListener('click', () => root.classList.toggle('collapsed'));

    this.buildTabs(root.querySelector('#group-tabs') as HTMLElement);
    this.renderOpenState();
  }

  /** 목록 갱신 — 편집 중인 칸은 건드리지 않는다 */
  render(data: TagRow[]): void {
    this.latest = new Map(data.map((d) => [d.tagId, d]));
    this.countEl.textContent = String(data.length);

    // 그룹별 개수는 항상 모두 갱신 (닫힌 그룹도 몇 개인지 보여야 한다)
    for (const g of GROUPS) {
      const tab = this.tabs.get(g.id);
      const inGroup = data.filter((d) => d.group === g.id);
      if (tab) {
        tab.num.textContent = String(inGroup.length);
        tab.btn.classList.toggle('has', inGroup.length > 0);
        // 그룹을 접어 둔 채로도 경고는 알아채야 한다 — 버튼에도 ! 를 띄운다
        tab.btn.classList.toggle('alert', inGroup.some((d) => d.alert));
      }
    }

    const visible = this.openGroup ? data.filter((d) => d.group === this.openGroup) : [];
    const keys = visible.map((d) => d.tagId);

    for (const d of visible) this.paintRow(d);

    // 순서·구성이 바뀐 경우에만 다시 붙인다
    if (keys.join('|') !== this.shown.join('|')) {
      for (const k of keys) this.list.appendChild(this.rows.get(k)!.li);
      for (const [tagId, els] of this.rows) {
        if (!keys.includes(tagId)) els.li.remove();
      }
      this.shown = keys;
    }
    // 목록에서 완전히 사라진 태그의 캐시 정리
    for (const [tagId, els] of this.rows) {
      if (!this.latest.has(tagId)) {
        els.li.remove();
        this.rows.delete(tagId);
      }
    }

    this.empty.textContent = this.openGroup
      ? '이 그룹에 배정된 비콘이 없습니다.'
      : '그룹을 눌러 비콘을 펼쳐보세요.';
    this.empty.style.display = visible.length > 0 ? 'none' : '';
  }

  /** 맵에서 아바타를 클릭했을 때 — 그 태그가 든 그룹을 열고 이름 편집 상태로 */
  focusRow(tagId: string): void {
    const row = this.latest.get(tagId);
    if (!row) return;
    this.root.classList.remove('collapsed');
    if (this.openGroup !== row.group) {
      this.openGroup = row.group;
      this.renderOpenState();
      this.render([...this.latest.values()]);
    }
    const els = this.rows.get(tagId);
    if (!els) return;
    els.li.scrollIntoView({ block: 'nearest' });
    els.name.focus();
    els.name.select();
  }

  private buildTabs(host: HTMLElement): void {
    for (const g of GROUPS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'group-btn';
      btn.innerHTML =
        `<span class="chev">▸</span><i class="swatch" style="background:${hex(g.color)}"></i>` +
        `<span class="lbl">${g.label}</span><i class="bang">!</i><span class="n">0</span>`;
      btn.addEventListener('click', () => {
        this.openGroup = this.openGroup === g.id ? null : g.id;
        this.renderOpenState();
        this.render([...this.latest.values()]);
      });
      host.appendChild(btn);
      this.tabs.set(g.id, { btn, num: btn.querySelector('.n') as HTMLElement });
    }
  }

  private renderOpenState(): void {
    for (const [id, tab] of this.tabs) tab.btn.classList.toggle('open', id === this.openGroup);
    const label = GROUPS.find((g) => g.id === this.openGroup)?.label;
    this.groupTitle.textContent = label ? `${label} 비콘` : '';
    this.groupTitle.style.display = label ? '' : 'none';
  }

  private paintRow(d: TagRow): void {
    const els = this.rows.get(d.tagId) ?? this.createRow(d.tagId);
    els.beacon.style.color = hex(d.color);

    // 포커스가 있는 입력은 사용자가 타이핑 중 → 값 덮어쓰기 금지
    if (document.activeElement !== els.name) els.name.value = d.name;
    if (document.activeElement !== els.memo) els.memo.value = d.memo;
    if (document.activeElement !== els.group) els.group.value = d.group;
    els.name.placeholder = d.tagId.slice(-5);

    const now = Date.now();
    const absent = d.zoneName === null;
    const gap = now - d.lastSeen;
    const level = absent || gap > STALE_MS ? 'off' : gap > FRESH_MS ? 'warn' : 'ok';
    const dwell = !absent && d.enteredAt > 0 ? ` · ${agoText(now - d.enteredAt)} 체류` : '';
    els.status.innerHTML =
      (d.alert ? '<i class="bang">!</i>' : '') +
      `<i class="sig ${level}"></i><b>${escapeHtml(absent ? '자리비움' : d.zoneName ?? '')}</b>` +
      `<span class="dim">${escapeHtml(dwell)}</span>`;
    els.status.title = d.lastSeen > 0 ? `마지막 신호 ${agoText(gap)} 전` : '신호 없음';
    els.li.classList.toggle('absent', absent);
    els.li.classList.toggle('alerted', d.alert);
    this.paintGuide(els, d);
  }

  /**
   * 방 안내 줄 — **환자에게만**. 직원은 환자용 화면을 안 써서 화살표를 볼 데가 없다.
   *
   * 도면에서 비콘을 누르면 이 줄로 오게 돼 있다(focusRow). 안내를 여기 두는 이유가
   * 그것이다 — 지도에서 사람을 짚고 바로 "저 방으로" 가 이어져야 한다.
   */
  private paintGuide(els: RowEls, d: TagRow): void {
    if (d.group !== 'patient') {
      if (els.guide.innerHTML) els.guide.innerHTML = '';
      return;
    }
    const open = this.guidePickFor === d.tagId;
    let html = '';
    if (d.guideZoneId) {
      const name = this.destinations.find((z) => z.zoneId === d.guideZoneId)?.name ?? d.guideZoneId;
      html =
        `<span class="going">→ ${escapeHtml(name)}</span>` +
        `<button class="gbtn stop" type="button" data-act="stop">안내 끝</button>`;
    } else {
      html = `<button class="gbtn go${open ? ' on' : ''}" type="button" data-act="open">🧭 방 안내</button>`;
    }
    if (open && !d.guideZoneId) html += this.destHtml();
    // 편집 중 입력을 건드리지 않으려고 내용이 같으면 다시 안 그린다
    if (els.guide.innerHTML !== html) els.guide.innerHTML = html;
  }

  /** 목적지 목록 — 방이 27개라 종류별로 묶지 않으면 못 찾는다 */
  private destHtml(): string {
    let html = '<div class="dests">';
    for (const [type, label] of DEST_GROUPS) {
      const rooms = this.destinations.filter((z) => z.type === type);
      if (!rooms.length) continue;
      html += `<div class="dl">${label}</div><div class="dg">`;
      for (const z of rooms) {
        html += `<button class="dbtn" type="button" data-zone="${escapeHtml(z.zoneId)}">${escapeHtml(z.name)}</button>`;
      }
      html += '</div>';
    }
    return html + '</div>';
  }

  private createRow(tagId: string): RowEls {
    const li = document.createElement('li');
    li.className = 'tag-row';
    li.innerHTML = `
      <span class="beacon" title="맵에서 이 비콘 강조">${BEACON_SVG}</span>
      <div class="info">
        <div class="line">
          <input class="name" type="text" spellcheck="false" />
          <select class="grp" title="그룹">
            ${GROUPS.map((g) => `<option value="${g.id}">${g.label}</option>`).join('')}
          </select>
        </div>
        <div class="status"></div>
        <input class="memo" type="text" spellcheck="false" placeholder="메모" />
        <div class="guide"></div>
      </div>`;
    const els: RowEls = {
      li,
      beacon: li.querySelector('.beacon') as HTMLSpanElement,
      name: li.querySelector('.name') as HTMLInputElement,
      memo: li.querySelector('.memo') as HTMLInputElement,
      group: li.querySelector('.grp') as HTMLSelectElement,
      status: li.querySelector('.status') as HTMLDivElement,
      guide: li.querySelector('.guide') as HTMLDivElement,
    };

    // 버튼은 다시 그려질 때마다 새로 생기므로 위임으로 받는다
    els.guide.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('button');
      if (!btn) return;
      if (btn.dataset.act === 'open') {
        this.guidePickFor = this.guidePickFor === tagId ? null : tagId;
        this.render([...this.latest.values()]);
      } else if (btn.dataset.act === 'stop') {
        this.onGuide(tagId, null);
      } else if (btn.dataset.zone) {
        this.guidePickFor = null;
        this.onGuide(tagId, btn.dataset.zone);
      }
    });

    const save = (): void =>
      this.onSave(tagId, els.name.value, els.memo.value, els.group.value as TagGroup);
    for (const input of [els.name, els.memo]) {
      input.addEventListener('change', save); // 포커스 빠질 때 / Enter
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === 'Escape') input.blur();
      });
    }
    els.group.addEventListener('change', save);
    els.beacon.addEventListener('click', () => this.onPick(tagId));

    this.rows.set(tagId, els);
    return els;
  }
}
