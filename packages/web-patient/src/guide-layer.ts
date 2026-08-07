import Phaser from 'phaser';
import type { Zone } from '@meditracker/shared';
import type { Pathfinder } from './pathfinder';

/**
 * 방 안내 — 목적지까지 바닥에 빨간 화살표를 깔아 준다.
 *
 * **화면의 캐릭터를 따라간다.** 화살표 줄의 머리가 매 프레임 캐릭터 발밑에 붙고,
 * 지나온 자리는 남기지 않는다. 위치 추정값(실좌표)이 아니라 **눈에 보이는 캐릭터**가
 * 기준이다 — 어차피 위치가 틀리면 캐릭터도 같이 틀리므로, 보이는 것과 어긋나 있는
 * 편이 더 나쁘다.
 *
 * 경로는 **가로·세로 직선 + 90도 꺾임**으로만 그린다 (`Pathfinder.orthogonalize`).
 * 방을 비스듬히 가로지르는 선은 지저분하고 방향이 덜 읽힌다.
 *
 * 길찾기(A*)는 매 프레임 하지 않는다. 경로 **모양**은 잘 안 바뀌므로 한 번 잡아 두고,
 * 캐릭터가 그 길에서 {@link OFF_ROUTE_PX} 이상 벗어났을 때만 다시 잡는다. 매 프레임
 * 하는 것은 꺾은선 위에 화살표를 다시 놓는 것뿐이라 A* 가 도는 것과 값이 다르다.
 *
 * 복도에는 게이트웨이가 없어 '이동 중'이 되지만, 캐릭터는 계속 움직이므로 화살표도
 * 그대로 따라온다.
 */

/** 화살표 간격 (화면 픽셀). 촘촘하면 선이 되고, 성기면 어디로 가는지 안 읽힌다 */
const STEP_PX = 13;
/** 첫 화살표를 발끝보다 조금 앞에 — 발밑에 두면 캐릭터에 가려 안 보인다 */
const LEAD_PX = 9;
/** 이만큼 길에서 벗어나면 경로를 다시 잡는다 */
const OFF_ROUTE_PX = 26;
const COLOR = 0xff3b30;
const ALPHA = 0.9;
/** 흐르는 느낌을 주는 밝기 파동의 주기 */
const FLOW_MS = 1100;

export interface GuideDeps {
  scene: Phaser.Scene;
  pf: Pathfinder;
  zones: Map<string, Zone>;
  /** 도면 좌표 ↔ 화면 좌표 배율 */
  scale: number;
  /** 그리기 층 — 바닥(0) 위, 사람(1) 아래 */
  depth: number;
}

export class GuideLayer {
  private d: GuideDeps;
  /** 화살표 객체 풀 — 매 프레임 새로 만들면 쓰레기만 쌓인다 */
  private pool: Phaser.GameObjects.Triangle[] = [];
  private used = 0;
  private target: string | null = null;
  /** 지금 따라가는 경로 (화면 좌표 꺾은선) */
  private route: Array<{ x: number; y: number }> = [];

  constructor(deps: GuideDeps) {
    this.d = deps;
  }

  /** 지금 안내 중인 방 (없으면 null) */
  get zoneId(): string | null {
    return this.target;
  }

  /** 안내 시작·변경·해제. 해제는 `null` */
  setTarget(zoneId: string | null): void {
    if (zoneId === this.target) return;
    this.target = zoneId;
    this.route = []; // 다음 갱신에서 새로 잡는다
    if (!zoneId) this.hideFrom(0);
  }

  /** 매 프레임 호출 — 캐릭터 발밑에서 목적지까지 화살표를 다시 놓는다 */
  update(selfX: number, selfY: number, time: number): void {
    if (!this.target) return;

    // 길에서 벗어났으면(또는 아직 길이 없으면) 새로 찾는다
    const on = this.route.length >= 2 ? this.project(selfX, selfY) : null;
    if (!on || on.dist > OFF_ROUTE_PX) {
      this.reroute(selfX, selfY);
      if (this.route.length < 2) {
        this.hideFrom(0);
        return;
      }
    }
    this.lay(this.project(selfX, selfY)!, time);
  }

  /**
   * 캐릭터를 경로 위로 내린다 — 어느 구간의 어디쯤인지와 그 지점까지의 거리.
   * 이 값이 곧 "지금까지 온 만큼" 이라, 화살표를 여기서부터 놓으면 줄의 머리가
   * 캐릭터를 따라온다.
   */
  private project(x: number, y: number): { along: number; dist: number } | null {
    let best: { along: number; dist: number } | null = null;
    let acc = 0;
    for (let i = 1; i < this.route.length; i++) {
      const a = this.route[i - 1];
      const b = this.route[i];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const seg = Math.hypot(dx, dy);
      if (seg < 0.01) continue;
      // 선분 위로의 정사영 (구간 밖으로 나가지 않게 0~1 로 자른다)
      const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / (seg * seg)));
      const dist = Math.hypot(a.x + dx * t - x, a.y + dy * t - y);
      if (!best || dist < best.dist) best = { along: acc + seg * t, dist };
      acc += seg;
    }
    return best;
  }

  /** 경로 위 거리 `along` 지점의 좌표와 진행 방향 */
  private pointAt(along: number): { x: number; y: number; angle: number } | null {
    let acc = 0;
    for (let i = 1; i < this.route.length; i++) {
      const a = this.route[i - 1];
      const b = this.route[i];
      const seg = Math.hypot(b.x - a.x, b.y - a.y);
      if (seg < 0.01) continue;
      if (along <= acc + seg) {
        const t = (along - acc) / seg;
        return {
          x: a.x + (b.x - a.x) * t,
          y: a.y + (b.y - a.y) * t,
          angle: Math.atan2(b.y - a.y, b.x - a.x),
        };
      }
      acc += seg;
    }
    return null;
  }

  /** 캐릭터가 있는 지점부터 목적지까지 화살표를 놓는다 (지나온 자리는 비운다) */
  private lay(on: { along: number }, time: number): void {
    this.used = 0;
    for (let at = on.along + LEAD_PX; ; at += STEP_PX) {
      const p = this.pointAt(at);
      if (!p) break;
      const a = this.take();
      a.setPosition(p.x, p.y).setRotation(p.angle);
      // 목적지 쪽으로 밝기가 흘러가게 — 정지 화살표는 방향이 잘 안 읽힌다
      const phase = (time / FLOW_MS - this.used * 0.16) % 1;
      a.setAlpha(ALPHA * (0.55 + 0.45 * Math.sin(phase * Math.PI * 2)));
      this.used++;
    }
    this.hideFrom(this.used);
  }

  private reroute(selfX: number, selfY: number): void {
    this.route = [];
    const to = this.target ? this.d.zones.get(this.target) : undefined;
    if (!to) return;

    // 길찾기는 도면 좌표로 한다 — 화면 좌표를 그대로 넣으면 격자를 벗어난다
    const fx = selfX / this.d.scale;
    const fy = selfY / this.d.scale;
    // 안내 경로만 직원 전용 구역을 피해 돌아간다 (환자를 직원실로 보낼 수는 없다)
    const found = this.d.pf.findPath(fx, fy, to.tilePosition.x, to.tilePosition.y, {
      avoidStaff: true,
    });
    if (!found || found.length < 1) return;

    // ⚠️ findPath 는 **꺾이는 지점만** 돌려준다 — 출발점은 안 들어 있다. 걸을 때는
    //    캐릭터가 이미 그 자리라 상관없지만, 길을 그릴 때 그대로 쓰면 화살표가 내
    //    발밑이 아니라 첫 모퉁이에서 시작한다. 여기서 출발점을 앞에 붙인다.
    //    (단순화가 출발점에서 첫 지점까지 가시선을 보장하므로 벽을 뚫지 않는다)
    // 대각선 구간을 ㄱ자로 펴서 가로·세로 직선으로만 만든다 — 바닥에 깔리는
    // 화살표는 비스듬하면 어디로 가라는 건지 덜 읽힌다
    this.route = this.d.pf.orthogonalize([{ x: fx, y: fy }, ...found]).map((p) => ({
      x: p.x * this.d.scale,
      y: p.y * this.d.scale,
    }));
  }

  /** 풀에서 하나 꺼낸다 (모자라면 새로 만든다) */
  private take(): Phaser.GameObjects.Triangle {
    let a = this.pool[this.used];
    if (!a) {
      a = this.d.scene.add
        .triangle(0, 0, 0, 0, 0, 7, 7, 3.5, COLOR)
        .setOrigin(0.5, 0.5)
        .setDepth(this.d.depth);
      this.pool.push(a);
    }
    a.setVisible(true);
    return a;
  }

  private hideFrom(n: number): void {
    for (let i = n; i < this.pool.length; i++) this.pool[i].setVisible(false);
  }

  destroy(): void {
    for (const a of this.pool) a.destroy();
    this.pool = [];
  }
}
