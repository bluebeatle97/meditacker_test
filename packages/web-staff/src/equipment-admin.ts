import { GROUPS } from './tag-panel';
import { authFetch } from './api';
import { agoText, escapeHtml } from './format';
import type { Gateway, TagGroup, Zone } from '@meditracker/shared';

/**
 * 장비 관리 — 게이트웨이·비콘의 신규 등록 / 수정 / 삭제.
 *
 * **왜 관제(/monitor)가 아니라 여기인가.** 관제 화면은 RSSI·스캔 피드를 보는 디버깅
 * 창구고, 장비를 다는 사람은 직원용 패널을 띄워 둔 채 천장을 오간다. 등록 하나 하려고
 * 다른 화면으로 넘어갔다 돌아오면 보고 있던 도면·확대 상태가 날아간다.
 *
 * **관제와 겹치는 부분이 있다** (미등록 게이트웨이 → 구역 배정, 미등록 비콘 → 등록).
 * 그쪽은 그대로 두고 여기에도 뒀다 — 같은 API 를 부르므로 갈라질 여지가 없고,
 * 관제에는 없는 **수정·삭제**가 여기에만 있다.
 *
 * ⚠️ 자동 갱신을 안 한다. 이 화면은 칸에 글자를 치는 화면이라, 5초마다 다시 그리면
 *    입력하던 MAC 이 중간에 날아간다 (환자 등록/반납 화면과 다른 점). 목록은 열 때와
 *    저장·삭제 직후에만 다시 읽는다.
 */

type Tab = 'gateway' | 'beacon';

/**
 * 설치 좌표가 "딴 방에 있다" 고 볼 거리 (도면 px ≈ 1m).
 *
 * 방 라벨은 방 중앙이 아니라 도면에 글자가 적힌 자리라 정상 설치도 옆방 라벨에 조금 더
 * 가까울 수 있다. 그 정도로 경고를 띄우면 늘 켜져 있는 경고가 되어 아무도 안 읽는다 —
 * 옛 방 좌표가 통째로 남은 경우(수백 px)만 잡히게 문턱을 둔다.
 */
const MISMATCH_PX = 120;

/** 목록에 나오는 비콘 한 줄 — 서버 `/beacons` 응답 중 이 화면이 쓰는 것만 */
export interface EqBeaconRow {
  tagId: string;
  pin: string;
  assigned: boolean;
  holder: string | null;
  group: TagGroup;
  memo: string | null;
  lastSeen: number | null;
}

/** 도면에서 찍은 지점 — 좌표와 그 자리가 어느 방인지 */
export interface PickedPoint {
  x: number;
  y: number;
  zoneId: string | null;
  zoneName: string | null;
}

export interface EquipmentAdminHooks {
  /** 도면에서 한 지점을 찍게 한다. 취소하면 null */
  pickOnMap: (who: string) => Promise<PickedPoint | null>;
  /** 게이트웨이 목록이 바뀌었다 — 도면의 마커를 다시 세우라고 알린다 */
  onGateways: (list: Gateway[]) => void;
}

interface UnknownGateway {
  gatewayId: string;
  lastSeen: number;
  scans: number;
  beacons: number;
}

interface UnknownTag {
  tagId: string;
  rssi: number;
  gatewayId: string;
  count: number;
  lastSeen: number;
}

export class EquipmentAdmin {
  private tab: Tab = 'gateway';
  private gateways: Gateway[] = [];
  private unknownGw: UnknownGateway[] = [];
  private beacons: EqBeaconRow[] = [];
  private unknownTags: UnknownTag[] = [];
  private box: HTMLElement;
  private body: HTMLElement;

  constructor(
    private serverUrl: string,
    /** 구역 드롭다운 — 게이트웨이는 안내 목적지가 아닌 방(화장실·직원구역)에도 달린다 */
    private zones: Zone[],
    private hooks: EquipmentAdminHooks,
  ) {
    this.box = document.getElementById('eqadmin')!;
    this.body = document.getElementById('eqadmin-body')!;

    document.getElementById('eqadmin-close')!.addEventListener('click', () => this.close());
    this.box.addEventListener('click', (e) => {
      if (e.target === this.box) this.close();
    });
    for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>('#eqadmin-tabs button'))) {
      b.addEventListener('click', () => {
        this.tab = b.dataset.tab as Tab;
        this.renderTabs();
        this.render();
      });
    }
    // 줄은 매번 다시 그려지므로 위임으로 받는다
    this.body.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-act]');
      if (btn) void this.onAction(btn);
    });
    /**
     * 구역을 바꾸면 **설치 좌표를 그 자리에서 같이 옮긴다.**
     *
     * 이게 없어서 실제로 당했다 — 상담실 4 → 대기공간 2 로 바꿔 저장했는데 도면의
     * 게이트웨이는 상담실 4 에 그대로 있었다. 존 판정은 `zoneId` 로 하지만 **도면 마커와
     * 커버리지는 `tile` 로 그린다.** 좌표 칸에는 옛 방 좌표가 채워져 있으니, 저장할 때
     * 그 값이 같이 실려 가서 좌표만 옛 방에 남는다.
     *
     * 옮긴 방의 좌표를 **저장 전에 칸에 보여준다** — 무엇이 저장될지 눈으로 확인하고,
     * 실측 지점을 아는 사람은 거기서 다시 고칠 수 있다.
     */
    this.body.addEventListener('change', (e) => {
      const sel = (e.target as HTMLElement).closest<HTMLSelectElement>('select[data-gwzone]');
      if (sel) this.moveToZone(sel.dataset.gwzone!, sel.value);
    });
  }

  open(): void {
    this.box.hidden = false;
    this.renderTabs();
    void this.refresh();
  }

  /**
   * 닫기. **새로고침하지 않는다.**
   *
   * 예전엔 게이트웨이를 고치면 닫을 때 페이지를 새로 읽었다 — 도면 레이어에 목록을
   * 갈아끼울 방법이 없었기 때문이다. 지금은 저장할 때마다 `onGateways` 로 마커가 바로
   * 따라가므로 새로고침할 이유가 없고, 방을 돌며 한 대씩 실측하는 동안 **매번 화면이
   * 처음부터 다시 뜨는 것**이 이 화면에서 제일 거슬리는 일이 된다.
   */
  close(): void {
    this.box.hidden = true;
  }

  private renderTabs(): void {
    for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>('#eqadmin-tabs button'))) {
      b.classList.toggle('on', b.dataset.tab === this.tab);
    }
  }

  private async refresh(): Promise<void> {
    try {
      if (this.tab === 'gateway') {
        const [list, unknown] = await Promise.all([
          authFetch(`${this.serverUrl}/gateways`).then((r) => r.json() as Promise<Gateway[]>),
          authFetch(`${this.serverUrl}/unknown-gateways`)
            .then((r) => r.json() as Promise<{ unknown: UnknownGateway[] }>)
            .then((d) => d.unknown ?? []),
        ]);
        this.gateways = list;
        this.unknownGw = unknown;
      } else {
        const [rows, unknown] = await Promise.all([
          authFetch(`${this.serverUrl}/beacons`).then((r) => r.json() as Promise<EqBeaconRow[]>),
          authFetch(`${this.serverUrl}/unknown-tags`)
            .then((r) => r.json() as Promise<{ sightings: UnknownTag[] }>)
            .then((d) => d.sightings ?? []),
        ]);
        this.beacons = rows;
        this.unknownTags = unknown;
      }
      this.render();
    } catch {
      this.body.innerHTML = '<div class="eq-empty">서버에 연결할 수 없습니다</div>';
    }
  }

  /** 버튼 하나가 하는 일 — 성공하면 목록을 다시 읽는다 (실패하면 친 값이 그대로 남는다) */
  private async onAction(btn: HTMLButtonElement): Promise<void> {
    const act = btn.dataset.act!;
    const id = btn.dataset.id ?? '';

    if (act === 'gw-add') {
      const gatewayId = this.value('#eq-gw-mac');
      const zoneId = this.value('#eq-gw-zone');
      if (!gatewayId) return this.warn('게이트웨이 MAC 을 입력하세요');
      if (!zoneId) return this.warn('구역을 고르세요');
      await this.post('/register-gateway', {
        gatewayId,
        zoneId,
        label: this.value('#eq-gw-label'),
      });
      return;
    }
    if (act === 'gw-save') {
      const row = this.gateways.find((g) => g.gatewayId === id);
      const mac = this.value(`#eq-gw-mac-${cssId(id)}`);
      const zoneId = this.value(`#eq-gw-zone-${cssId(id)}`);
      if (!mac) return this.warn('MAC 이 비었습니다');
      await this.post('/register-gateway', {
        gatewayId: mac,
        prevGatewayId: id,
        zoneId,
        label: this.value(`#eq-gw-label-${cssId(id)}`),
        // 설치 좌표는 사람이 실측해 넣는 값이다 — 비워 두면 서버가 지금 값을 유지한다
        tile: this.tileInput(id) ?? row?.tile,
      });
      return;
    }
    if (act === 'gw-del') {
      if (!window.confirm(`게이트웨이 ${id} 를 목록에서 지울까요?\n\n이 게이트웨이가 잡던 신호는 존 판정에서 빠집니다.`)) {
        return;
      }
      await this.post('/delete-gateway', { gatewayId: id });
      return;
    }
    // 좌표를 지금 고른 방으로 — 실측 지점을 모를 때, 그리고 옛 방 좌표가 남았을 때
    if (act === 'gw-here') {
      this.moveToZone(id, this.value(`#eq-gw-zone-${cssId(id)}`));
      return;
    }
    // 도면에서 설치 지점 찍기 — 좌표를 손으로 넣는 것보다 이쪽이 사람이 할 수 있는 일이다
    if (act === 'gw-pick') {
      await this.pickTile(id);
      return;
    }
    // 미등록 게이트웨이 한 줄에서 바로 등록 — MAC 을 손으로 옮겨 치지 않게
    if (act === 'gw-claim') {
      const zoneId = this.value(`#eq-ugw-zone-${cssId(id)}`);
      if (!zoneId) return this.warn('구역을 고르세요');
      await this.post('/register-gateway', { gatewayId: id, zoneId });
      return;
    }

    if (act === 'bc-add') {
      const tagId = this.value('#eq-bc-mac');
      if (!tagId) return this.warn('비콘 MAC 을 입력하세요');
      await this.post('/register-beacon', {
        tagId,
        group: this.value('#eq-bc-group'),
        memo: this.value('#eq-bc-memo'),
      });
      return;
    }
    if (act === 'bc-save') {
      // 이름은 안 보낸다 — 이 화면은 장비를 고치는 곳이고, 이름 칸은 지금 든 사람의 자리다
      await this.post('/tag-meta', {
        tagId: id,
        group: this.value(`#eq-bc-group-${cssId(id)}`),
        memo: this.value(`#eq-bc-memo-${cssId(id)}`),
      });
      return;
    }
    if (act === 'bc-del') {
      const row = this.beacons.find((b) => b.tagId === id);
      const who = row?.assigned ? `\n\n⚠️ 지금 ${row.holder ?? '누군가'} 에게 배정돼 있습니다 — 배정도 같이 닫힙니다.` : '';
      if (!window.confirm(`비콘 ${row?.pin ?? id} 을(를) 폐기할까요?${who}\n\n추적이 멈추고 목록에서 사라집니다. 지난 기록은 남습니다.`)) {
        return;
      }
      await this.post('/delete-beacon', { tagId: id });
      return;
    }
    // 미등록 신호에서 MAC 만 입력칸으로 옮긴다 (그룹·메모는 사람이 정한다)
    if (act === 'bc-pick') {
      const input = this.body.querySelector<HTMLInputElement>('#eq-bc-mac');
      if (input) {
        input.value = id;
        input.focus();
      }
      return;
    }
  }

  /**
   * 도면에서 설치 지점을 찍어 **그 자리로 저장한다.**
   *
   * 찍는 동안 이 창을 감춘다 — 도면의 절반을 덮고 있어서 창을 띄운 채로는 가려진 방을
   * 고를 수 없다. 감추기만 하고 닫지는 않는다 (닫으면 새로고침이 걸린다).
   *
   * 찍은 자리가 **지금 고른 구역과 다른 방이면 물어본다.** 좌표와 구역이 어긋나면
   * 존 판정은 이 방, 도면 마커는 저 방이 되어 화면이 조용히 거짓말을 한다 — 지난번에
   * 실제로 그렇게 됐다.
   */
  private async pickTile(gatewayId: string): Promise<void> {
    const k = cssId(gatewayId);
    let zoneId = this.value(`#eq-gw-zone-${k}`);
    const label = this.value(`#eq-gw-label-${k}`);
    const mac = this.value(`#eq-gw-mac-${k}`);

    this.box.hidden = true;
    const hit = await this.hooks.pickOnMap(`${gatewayId}${label ? ` · ${label}` : ''}`);
    this.box.hidden = false;
    if (!hit) return; // 취소 — 아무것도 안 바꾼다

    if (hit.zoneId && hit.zoneId !== zoneId) {
      const now = this.zones.find((z) => z.zoneId === zoneId)?.name ?? '없음';
      const ok = window.confirm(
        `찍은 자리는 「${hit.zoneName}」 입니다. 지금 구역은 「${now}」 입니다.\n\n`
          + `구역도 「${hit.zoneName}」 로 바꿀까요?\n`
          + '(취소를 누르면 구역은 그대로 두고 좌표만 옮깁니다)',
      );
      if (ok) zoneId = hit.zoneId;
    }

    await this.post('/register-gateway', {
      gatewayId: mac || gatewayId,
      prevGatewayId: gatewayId,
      zoneId,
      label,
      tile: { x: hit.x, y: hit.y },
    });
  }

  private value(sel: string): string {
    return this.body.querySelector<HTMLInputElement | HTMLSelectElement>(sel)?.value.trim() ?? '';
  }

  private el(sel: string): HTMLInputElement | null {
    return this.body.querySelector<HTMLInputElement>(sel);
  }

  /**
   * 이 게이트웨이의 좌표(와 자동 라벨)를 고른 방으로 옮긴다 — 칸의 값만 바꾸고 저장은 안 한다.
   * 다시 그리지 않는 이유는 여기가 **입력 중인 화면**이라서다 (다시 그리면 치던 값이 날아간다).
   */
  private moveToZone(gatewayId: string, zoneId: string): void {
    const zone = this.zones.find((z) => z.zoneId === zoneId);
    if (!zone) return;
    const k = cssId(gatewayId);
    const x = this.el(`#eq-gw-x-${k}`);
    const y = this.el(`#eq-gw-y-${k}`);
    if (x) x.value = String(zone.tilePosition.x);
    if (y) y.value = String(zone.tilePosition.y);
    /**
     * 라벨이 **서버가 자동으로 지어 준 이름**(`상담실 4 게이트웨이`)이면 같이 따라간다.
     * 사람이 손으로 쓴 라벨('대기공간 천장 A')은 그 사람의 말이라 건드리지 않는다.
     */
    const label = this.el(`#eq-gw-label-${k}`);
    if (label && this.isAutoLabel(label.value)) label.value = `${zone.name} 게이트웨이`;
    this.renderNote(gatewayId);
  }

  /** 서버가 만든 자리표시 라벨인가 — `${방 이름} 게이트웨이` 꼴 */
  private isAutoLabel(label: string): boolean {
    const s = label.trim();
    return s === '' || this.zones.some((z) => s === `${z.name} 게이트웨이`);
  }

  /**
   * 좌표가 고른 방과 어긋났나 — 옛 방 좌표가 남아 도면 마커가 딴 방에 서 있는 상태를 잡는다.
   *
   * 존 라벨 위치까지의 거리로 본다. 방 라벨은 방 중앙이 아니라 도면에 적힌 자리라
   * 조금씩 어긋나므로, **다른 방이 뚜렷하게 더 가까울 때만**(1칸 이상 차이) 알린다.
   */
  private mismatch(zoneId: string, tile: { x: number; y: number } | undefined): string | null {
    const zone = this.zones.find((z) => z.zoneId === zoneId);
    if (!zone || !tile) return null;
    const d = (z: Zone): number => Math.hypot(tile.x - z.tilePosition.x, tile.y - z.tilePosition.y);
    const here = d(zone);
    const nearest = this.zones.reduce((best, z) => (d(z) < d(best) ? z : best), zone);
    return nearest.zoneId !== zoneId && here - d(nearest) > MISMATCH_PX ? nearest.name : null;
  }

  /** 한 줄의 안내문만 다시 쓴다 (구역·좌표를 고치는 즉시 따라오게) */
  private renderNote(gatewayId: string): void {
    const note = this.body.querySelector<HTMLElement>(`#eq-gw-note-${cssId(gatewayId)}`);
    if (!note) return;
    note.innerHTML = this.noteHtml(
      this.value(`#eq-gw-zone-${cssId(gatewayId)}`),
      this.tileInput(gatewayId),
    );
  }

  /** 설치 좌표에 대한 경고·주의 (없으면 빈 칸 — CSS 가 접는다) */
  private noteHtml(zoneId: string, tile: { x: number; y: number } | undefined): string {
    const off = this.mismatch(zoneId, tile);
    if (off) {
      return `⚠️ 설치 좌표가 「${escapeHtml(off)}」 쪽에 있습니다 — 도면의 마커도 거기 그려집니다.`
        + ' 「🖱 도면에서 찍기」 로 실제 설치 지점을 짚거나, 「📍 이 방으로」 로 맞추세요.';
    }
    const zone = this.zones.find((z) => z.zoneId === zoneId);
    return zone && tile && zone.tilePosition.x === tile.x && zone.tilePosition.y === tile.y
      ? `설치 좌표가 「${escapeHtml(zone.name)}」 이름표 위치 그대로 — 실측 지점이 아닙니다.`
      : '';
  }

  /** 설치 좌표 두 칸. 둘 다 숫자일 때만 값으로 친다 (한쪽만 지운 상태를 좌표로 보내지 않는다) */
  private tileInput(id: string): { x: number; y: number } | undefined {
    const x = Number(this.value(`#eq-gw-x-${cssId(id)}`));
    const y = Number(this.value(`#eq-gw-y-${cssId(id)}`));
    return Number.isFinite(x) && Number.isFinite(y) && this.value(`#eq-gw-x-${cssId(id)}`) !== ''
      ? { x, y }
      : undefined;
  }

  private warn(msg: string): void {
    const el = this.body.querySelector<HTMLElement>('.eq-warn');
    if (el) el.textContent = msg;
    else window.alert(msg);
  }

  private async post(path: string, body: unknown): Promise<void> {
    try {
      const res = await authFetch(`${this.serverUrl}${path}`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      const d = (await res.json()) as { ok: boolean; error?: string };
      if (!d.ok) {
        this.warn(`실패: ${d.error ?? '알 수 없는 오류'}`);
        return;
      }
      const gw = path.includes('gateway');
      await this.refresh();
      // 도면의 마커를 바로 다시 세운다 — 저장했는데 화면이 그대로면 안 된 줄 안다
      if (gw && this.tab === 'gateway') this.hooks.onGateways(this.gateways);
    } catch (err) {
      this.warn(`실패: ${(err as Error).message}`);
    }
  }

  private render(): void {
    this.body.innerHTML = this.tab === 'gateway' ? this.gatewayHtml() : this.beaconHtml();
  }

  private zoneOptions(selected: string, placeholder: string): string {
    // 첫 항목이 실수로 선택되지 않게 빈 값을 앞에 둔다 (관제 등록창과 같은 이유)
    let html = `<option value="">${escapeHtml(placeholder)}</option>`;
    for (const z of [...this.zones].sort((a, b) => a.name.localeCompare(b.name, 'ko'))) {
      const on = z.zoneId === selected ? ' selected' : '';
      html += `<option value="${escapeHtml(z.zoneId)}"${on}>${escapeHtml(z.name)}</option>`;
    }
    return html;
  }

  private gatewayHtml(): string {
    let html = '<div class="eq-warn"></div>';

    // ── 신규 등록 ──
    html +=
      '<div class="eq-new">' +
      '<div class="eq-new-t">＋ 게이트웨이 등록</div>' +
      '<div class="eq-new-r">' +
      '<input id="eq-gw-mac" class="eq-mac" placeholder="MAC (28:56:2F:79:B4:20)" />' +
      `<select id="eq-gw-zone">${this.zoneOptions('', '구역 선택…')}</select>` +
      '<input id="eq-gw-label" placeholder="설치 위치 메모 (선택)" />' +
      '<button class="eq-btn ok" data-act="gw-add">등록</button>' +
      '</div>' +
      '<div class="eq-hint">MAC 은 장비 스티커가 아니라 <b>페이로드에 실려 오는 값</b>이다 —' +
      ' 끝자리가 다를 수 있으니 아래 「지금 신호가 오는 미등록 게이트웨이」에서 고르는 쪽이 확실하다.' +
      ' 등록하면 그 방 이름표 자리에 놓이고, <b>실제 설치 지점은 아래 목록에서 「🖱 도면에서 찍기」</b> 로 정한다.</div>' +
      '</div>';

    // ── 미등록 (설치했는데 아직 목록에 없는 것) ──
    if (this.unknownGw.length > 0) {
      html += `<div class="eq-gh">📡 지금 신호가 오는 미등록 게이트웨이 <b>${this.unknownGw.length}</b></div>`;
      for (const u of this.unknownGw) {
        html +=
          '<div class="eq-row">' +
          `<code class="eq-id">${escapeHtml(u.gatewayId)}</code>` +
          `<span class="eq-sub">스캔 ${u.scans} · 비콘 ${u.beacons} · ${agoText(Date.now() - u.lastSeen)} 전</span>` +
          `<select id="eq-ugw-zone-${cssId(u.gatewayId)}">${this.zoneOptions('', '구역 선택…')}</select>` +
          `<button class="eq-btn ok" data-act="gw-claim" data-id="${escapeHtml(u.gatewayId)}">등록</button>` +
          '</div>';
      }
    }

    // ── 등록된 것 ──
    html += `<div class="eq-gh">등록된 게이트웨이 <b>${this.gateways.length}</b></div>`;
    if (this.gateways.length === 0) {
      html += '<div class="eq-empty">등록된 게이트웨이가 없습니다</div>';
      return html;
    }
    for (const g of this.gateways) {
      const k = cssId(g.gatewayId);
      html +=
        '<div class="eq-card">' +
        '<div class="eq-row">' +
        `<input id="eq-gw-mac-${k}" class="eq-mac" value="${escapeHtml(g.gatewayId)}" />` +
        `<select id="eq-gw-zone-${k}" data-gwzone="${escapeHtml(g.gatewayId)}">${this.zoneOptions(g.zoneId, '구역 선택…')}</select>` +
        `<button class="eq-btn ok" data-act="gw-save" data-id="${escapeHtml(g.gatewayId)}">저장</button>` +
        `<button class="eq-btn del" data-act="gw-del" data-id="${escapeHtml(g.gatewayId)}">삭제</button>` +
        '</div>' +
        '<div class="eq-row">' +
        `<input id="eq-gw-label-${k}" class="eq-grow" value="${escapeHtml(g.label ?? '')}" placeholder="설치 위치 메모" />` +
        `<span class="eq-xy">설치 좌표` +
        `<input id="eq-gw-x-${k}" class="eq-num" value="${g.tile?.x ?? ''}" placeholder="x" />` +
        `<input id="eq-gw-y-${k}" class="eq-num" value="${g.tile?.y ?? ''}" placeholder="y" />` +
        // 도면 마커가 읽는 값이 이 두 칸이다. 천장을 짚는 일이라 도면 클릭이 제 모양이고,
        // 「이 방으로」 는 설치 지점을 아직 모를 때 쓰는 자리표시자다
        `<button class="eq-btn pick" data-act="gw-pick" data-id="${escapeHtml(g.gatewayId)}" title="도면에서 설치 지점을 클릭해 정합니다">🖱 도면에서 찍기</button>` +
        `<button class="eq-btn" data-act="gw-here" data-id="${escapeHtml(g.gatewayId)}" title="좌표를 고른 방의 이름표 위치로">📍 이 방으로</button>` +
        '</span>' +
        '</div>' +
        `<div class="eq-note" id="eq-gw-note-${k}">${this.noteHtml(g.zoneId, g.tile)}</div>` +
        '</div>';
    }
    return html;
  }

  private beaconHtml(): string {
    let html = '<div class="eq-warn"></div>';

    html +=
      '<div class="eq-new">' +
      '<div class="eq-new-t">＋ 비콘 입고</div>' +
      '<div class="eq-new-r">' +
      '<input id="eq-bc-mac" class="eq-mac" placeholder="MAC (AA:BB:CC:00:00:01)" />' +
      `<select id="eq-bc-group">${GROUPS.map(
        (g) => `<option value="${g.id}"${g.id === 'patient' ? ' selected' : ''}>${escapeHtml(g.label)}</option>`,
      ).join('')}</select>` +
      '<input id="eq-bc-memo" placeholder="메모 (선택)" />' +
      '<button class="eq-btn ok" data-act="bc-add">등록</button>' +
      '</div>' +
      '<div class="eq-hint">입고하면 <b>창고</b>에 들어간다 — 사람은 안 붙는다.' +
      ' 환자에게 넘기는 건 「👥 환자 등록/반납」이 한다.</div>' +
      '</div>';

    // 등록 안 된 채 신호를 쏘는 것들 — 비콘을 게이트웨이 코앞에 대면 맨 위로 올라온다
    if (this.unknownTags.length > 0) {
      html += `<div class="eq-gh">📡 지금 신호가 오는 미등록 비콘 <b>${this.unknownTags.length}</b> <span class="eq-sub">눌러서 위 칸에 넣기</span></div>`;
      for (const u of this.unknownTags.slice(0, 12)) {
        html +=
          '<div class="eq-row">' +
          `<code class="eq-id">${escapeHtml(u.tagId)}</code>` +
          `<span class="eq-sub eq-grow">${u.rssi} dBm · ${u.count}회 · ${escapeHtml(u.gatewayId)}</span>` +
          `<button class="eq-btn" data-act="bc-pick" data-id="${escapeHtml(u.tagId)}">고르기</button>` +
          '</div>';
      }
    }

    html += `<div class="eq-gh">등록된 비콘 <b>${this.beacons.length}</b></div>`;
    if (this.beacons.length === 0) {
      html += '<div class="eq-empty">등록된 비콘이 없습니다</div>';
      return html;
    }
    for (const b of this.beacons) {
      const k = cssId(b.tagId);
      const state = b.assigned
        ? `<span class="eq-on">배정중 · ${escapeHtml(b.holder?.trim() || '이름 없음')}</span>`
        : `<span class="eq-sub">창고 · ${b.lastSeen ? `${agoText(Date.now() - b.lastSeen)} 전` : '신호 없음'}</span>`;
      html +=
        '<div class="eq-card">' +
        '<div class="eq-row">' +
        `<code class="eq-pin" title="${escapeHtml(b.tagId)}">${escapeHtml(b.pin)}</code>` +
        `<code class="eq-id eq-grow">${escapeHtml(b.tagId)}</code>` +
        state +
        '</div>' +
        '<div class="eq-row">' +
        `<select id="eq-bc-group-${k}">${GROUPS.map(
          (g) => `<option value="${g.id}"${g.id === b.group ? ' selected' : ''}>${escapeHtml(g.label)}</option>`,
        ).join('')}</select>` +
        `<input id="eq-bc-memo-${k}" class="eq-grow" value="${escapeHtml(b.memo ?? '')}" placeholder="메모" />` +
        `<button class="eq-btn ok" data-act="bc-save" data-id="${escapeHtml(b.tagId)}">저장</button>` +
        `<button class="eq-btn del" data-act="bc-del" data-id="${escapeHtml(b.tagId)}">폐기</button>` +
        '</div>' +
        '</div>';
    }
    /**
     * MAC 은 못 고친다 — 비콘의 tag_id 는 체류 기록·안내 이력이 가리키는 값이라,
     * 고치면 지난 기록이 주인 없는 값이 된다. 잘못 넣었으면 폐기하고 다시 입고한다.
     */
    html += '<div class="eq-note">비콘 MAC 은 고칠 수 없다 (지난 기록이 이 값을 가리킨다) — 잘못 넣었으면 폐기하고 다시 입고한다.</div>';
    return html;
  }
}

/** id 속성/선택자에 넣을 수 있게 MAC 의 콜론을 뺀다 */
function cssId(id: string): string {
  return id.replace(/[^0-9A-Za-z]/g, '');
}
