import Phaser from 'phaser';
import type { Zone } from '@meditracker/shared';
import type { Pathfinder } from './pathfinder';

/**
 * 방 안내 — 목적지까지 바닥에 빨간 화살표를 깔아 준다.
 *
 * **왜 발밑이 아니라 방 기준으로 그리나.** 게이트웨이가 2대뿐이라 위치는 방 단위로만
 * 안다. 매 좌표마다 경로를 다시 잡으면 신호가 튈 때마다 화살표가 통째로 흔들린다.
 * 그래서 **지금 있는 방 → 목적지 방** 으로 한 번 그리고, 방이 바뀔 때만 다시 그린다.
 * 게이트웨이를 더 깔면 방 판정이 촘촘해지면서 저절로 정밀해진다.
 *
 * 복도에는 게이트웨이가 없어 '이동 중'(zone = null)이 된다. 그동안 경로를 지우면
 * 복도에 들어서는 순간 화살표가 사라진다 — 마지막 경로를 그대로 둔다.
 */

/** 화살표 간격 (도면 픽셀). 촘촘하면 선이 되고, 성기면 어디로 가는지 안 읽힌다 */
const STEP_PX = 13;
const COLOR = 0xff3b30;
/** 지나온 화살표는 지우지 않고 흐리게 — 어디서 왔는지가 남아야 방향이 읽힌다 */
const ALPHA_PASSED = 0.16;
const ALPHA_AHEAD = 0.9;
/** 흐르는 느낌을 주는 밝기 파동의 주기 */
const FLOW_MS = 1100;

export interface GuideDeps {
  scene: Phaser.Scene;
  pf: Pathfinder;
  zones: Map<string, Zone>;
  /** 도면 좌표 → 화면 좌표 */
  m: (v: number) => number;
  /** 그리기 층 — 바닥(0) 위, 사람(1) 아래 */
  depth: number;
}

export class GuideLayer {
  private d: GuideDeps;
  private arrows: Phaser.GameObjects.Triangle[] = [];
  private target: string | null = null;
  /** 경로를 뽑을 때 기준이 된 방 — 여기가 바뀌어야 다시 그린다 */
  private routedFrom: string | null = null;

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
    this.routedFrom = null; // 다음 갱신에서 새로 그린다
    if (!zoneId) this.clear();
  }

  /**
   * 매 프레임 호출. 방이 바뀌었으면 경로를 다시 깔고, 지나온 화살표를 흐리게 한다.
   * `zone` 이 null(복도 이동 중)이면 마지막 경로를 유지한다.
   */
  update(selfX: number, selfY: number, zone: string | null, time: number): void {
    if (!this.target) return;
    if (zone && zone !== this.routedFrom) this.draw(zone);
    if (!this.arrows.length) return;

    // 내 위치에서 가장 가까운 화살표 — 그 앞은 흐리게, 뒤는 진하게
    let nearest = 0;
    let best = Infinity;
    for (let i = 0; i < this.arrows.length; i++) {
      const a = this.arrows[i];
      const dist = (a.x - selfX) ** 2 + (a.y - selfY) ** 2;
      if (dist < best) {
        best = dist;
        nearest = i;
      }
    }
    for (let i = 0; i < this.arrows.length; i++) {
      if (i < nearest) {
        this.arrows[i].setAlpha(ALPHA_PASSED);
        continue;
      }
      // 목적지 쪽으로 밝기가 흘러가게 — 정지 화살표는 방향이 잘 안 읽힌다
      const phase = (time / FLOW_MS - (i - nearest) * 0.16) % 1;
      this.arrows[i].setAlpha(ALPHA_AHEAD * (0.55 + 0.45 * Math.sin(phase * Math.PI * 2)));
    }
  }

  private draw(fromZone: string): void {
    this.clear();
    this.routedFrom = fromZone;
    const from = this.d.zones.get(fromZone);
    const to = this.target ? this.d.zones.get(this.target) : undefined;
    if (!from || !to) return;

    const route = this.d.pf.findPath(
      from.tilePosition.x,
      from.tilePosition.y,
      to.tilePosition.x,
      to.tilePosition.y,
    );
    if (!route || route.length < 2) return;

    // 경로 꺾은선을 일정 간격으로 훑으며 진행 방향으로 돌린 화살표를 놓는다
    let carry = 0;
    for (let i = 1; i < route.length; i++) {
      const ax = this.d.m(route[i - 1].x);
      const ay = this.d.m(route[i - 1].y);
      const bx = this.d.m(route[i].x);
      const by = this.d.m(route[i].y);
      const seg = Math.hypot(bx - ax, by - ay);
      const angle = Math.atan2(by - ay, bx - ax);
      for (let at = carry; at < seg; at += STEP_PX) {
        const t = at / seg;
        this.arrows.push(this.arrow(ax + (bx - ax) * t, ay + (by - ay) * t, angle));
      }
      carry = (carry - seg) % STEP_PX;
      if (carry < 0) carry += STEP_PX;
    }
  }

  /** 진행 방향을 향한 작은 삼각형 하나 */
  private arrow(x: number, y: number, angle: number): Phaser.GameObjects.Triangle {
    return this.d.scene.add
      .triangle(x, y, 0, 0, 0, 7, 7, 3.5, COLOR)
      .setOrigin(0.5, 0.5)
      .setRotation(angle)
      .setDepth(this.d.depth)
      .setAlpha(ALPHA_AHEAD);
  }

  private clear(): void {
    for (const a of this.arrows) a.destroy();
    this.arrows = [];
  }

  destroy(): void {
    this.clear();
  }
}
