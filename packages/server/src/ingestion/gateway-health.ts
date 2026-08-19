import type { GatewayHealthSample } from './adapter.js';

/**
 * 게이트웨이 생사·재부팅 기록.
 *
 * **왜 필요한가.** 게이트웨이가 통째로 사라지는 일이 반복되는데, 사라진 사실이 아무 데도
 * 안 남아서 매번 현장을 덮쳐야만 원인을 좁힐 수 있었다. 실제로 2026-08-19 관측에서
 * 6대 중 3대가 **1초 안에 같이** 끊겼고(378.4·378.8·379.3초 무신호), 셋 다 도면
 * 오른쪽(x 1045~1328)에 몰려 있었다 — 공용 AP나 전원 계통을 의심할 근거였지만,
 * 그걸 알아내려고 사람이 붙어서 지켜봐야 했다.
 *
 * **스캔 수로는 판별할 수 없다.** 게이트웨이는 비콘을 들었을 때만 스캔을 올리므로,
 * 근처에 아무도 없으면 멀쩡해도 조용하다. 반면 상태 메시지(`mid`·`time`)는 들은 게
 * 없어도 온다 — 그래서 이 기록의 근거는 스캔이 아니라 상태 메시지다.
 */

/** 이 시간 상태 메시지가 없으면 죽은 것으로 본다. 정상은 1초에 한 번씩 온다 */
const DEAD_AFTER_MS = 15_000;
/** 이력 보관 상한 — 오래 돌아도 메모리가 단조 증가하면 안 된다 */
const MAX_EVENTS = 200;

export interface GatewayHealthRow {
  gatewayId: string;
  alive: boolean;
  /** 마지막 상태 메시지로부터 경과 초. 한 번도 안 온 게이트웨이는 null */
  silentSec: number | null;
  uptimeSec: number | null;
  uptimeMin: number | null;
  msgs: number;
  reboots: number;
  lostMsgs: number;
  outages: number;
  neverSeen: boolean;
}

export interface GatewayEvent {
  gatewayId: string;
  at: number;
  kind: 'died' | 'back' | 'reboot' | 'loss';
  /** died→ 없음, back→ 끊겨 있던 시간(초), reboot→ 직전 가동시간(초), loss→ 건너뛴 메시지 수 */
  value?: number;
}

interface GwState {
  gatewayId: string;
  lastAt: number;
  firstAt: number;
  msgs: number;
  uptimeSec: number | null;
  mid: number | null;
  reboots: number;
  lostMsgs: number;
  outages: number;
  /** 지금 죽은 것으로 표시돼 있나 (같은 죽음을 매 sweep 마다 다시 세지 않기 위해) */
  dead: boolean;
  deadSince: number | null;
}

export class GatewayHealthMonitor {
  private gw = new Map<string, GwState>();
  private events: GatewayEvent[] = [];

  constructor(
    /** 등록돼 있는데 한 번도 안 나타난 게이트웨이도 알아야 한다 */
    private registered: () => string[],
    private now: () => number = () => Date.now(),
    private log: (msg: string) => void = (m) => console.log(m),
  ) {}

  /** 상태 메시지 한 건 (어댑터가 꺼낸 것) */
  note(s: GatewayHealthSample): void {
    const st = this.gw.get(s.gatewayId) ?? {
      gatewayId: s.gatewayId,
      lastAt: s.at,
      firstAt: s.at,
      msgs: 0,
      uptimeSec: null,
      mid: null,
      reboots: 0,
      lostMsgs: 0,
      outages: 0,
      dead: false,
      deadSince: null,
    };
    st.msgs++;

    if (st.dead) {
      const outSec = Math.round((s.at - st.lastAt) / 1000);
      st.dead = false;
      st.deadSince = null;
      this.push({ gatewayId: s.gatewayId, at: s.at, kind: 'back', value: outSec });
      this.log(`[gw-health] 복구: ${s.gatewayId} — ${outSec}초 만에 돌아옴`);
    }

    /**
     * 가동시간이 **되감기면** 그 사이에 재부팅한 것이다. 끊김 없이 재부팅하는 경우도
     * 있어서(전원이 잠깐 흔들리고 바로 복구) 무신호 감지와 따로 센다.
     */
    if (st.uptimeSec !== null && s.uptimeSec !== null && s.uptimeSec < st.uptimeSec) {
      st.reboots++;
      this.push({ gatewayId: s.gatewayId, at: s.at, kind: 'reboot', value: st.uptimeSec });
      this.log(
        `[gw-health] 재부팅: ${s.gatewayId} — 직전 가동 ${Math.round(st.uptimeSec / 60)}분 뒤 껐다 켜짐`,
      );
    }

    // 일련번호 건너뜀 = 전송 중 유실. 재부팅하면 번호가 초기화되므로 그때는 세지 않는다
    if (st.mid !== null && s.mid !== null && s.mid > st.mid + 1) {
      const lost = s.mid - st.mid - 1;
      st.lostMsgs += lost;
      this.push({ gatewayId: s.gatewayId, at: s.at, kind: 'loss', value: lost });
    }

    st.lastAt = s.at;
    st.uptimeSec = s.uptimeSec;
    st.mid = s.mid;
    this.gw.set(s.gatewayId, st);
  }

  /**
   * 무신호 검사 — 주기적으로 부른다.
   *
   * 죽는 순간을 **로그에 남기는 것**이 이 함수의 존재 이유다. 화면만 보고 있으면
   * 아무도 안 볼 때 죽은 것은 영원히 모른다.
   */
  sweep(): void {
    const now = this.now();
    for (const st of this.gw.values()) {
      if (st.dead) continue;
      const silent = now - st.lastAt;
      if (silent >= DEAD_AFTER_MS) {
        st.dead = true;
        st.deadSince = st.lastAt;
        st.outages++;
        this.push({ gatewayId: st.gatewayId, at: now, kind: 'died' });
        this.log(`[gw-health] ⚠️ 끊김: ${st.gatewayId} — ${Math.round(silent / 1000)}초째 무신호`);
      }
    }
  }

  /** 관제·API 용 스냅샷. 등록만 되고 한 번도 안 온 게이트웨이도 함께 낸다 */
  snapshot(): { at: number; gateways: GatewayHealthRow[]; events: GatewayEvent[] } {
    const now = this.now();
    const rows: GatewayHealthRow[] = [...this.gw.values()].map((st) => ({
      gatewayId: st.gatewayId,
      alive: !st.dead,
      silentSec: Math.round((now - st.lastAt) / 1000),
      uptimeSec: st.uptimeSec,
      uptimeMin: st.uptimeSec === null ? null : Math.round(st.uptimeSec / 60),
      msgs: st.msgs,
      reboots: st.reboots,
      lostMsgs: st.lostMsgs,
      outages: st.outages,
      neverSeen: false,
    }));
    for (const id of this.registered()) {
      if (this.gw.has(id)) continue;
      rows.push({
        gatewayId: id,
        alive: false,
        silentSec: null,
        uptimeSec: null,
        uptimeMin: null,
        msgs: 0,
        reboots: 0,
        lostMsgs: 0,
        outages: 0,
        neverSeen: true,
      });
    }
    return { at: now, gateways: rows, events: [...this.events].reverse() };
  }

  private push(e: GatewayEvent): void {
    this.events.push(e);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
  }
}
