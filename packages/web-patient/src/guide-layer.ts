import Phaser from 'phaser';
import type { Zone } from '@meditracker/shared';
import type { Pathfinder } from './pathfinder';

/**
 * 방 안내 — 목적지까지 바닥에 빨간 화살표를 깔아 준다.
 *
 * **내 캐릭터 발밑에서 시작한다.** 처음엔 방 기준점에서 그렸는데(신호가 튀어도 안
 * 흔들리라고), 화면에서는 화살표가 나와 상관없는 데서 뻗어 나가는 것으로 보였다.
 * 어차피 위치가 틀리면 캐릭터도 같이 틀리므로, 보이는 것과 맞추는 편이 낫다.
 *
 * 대신 **매 프레임 다시 잡지는 않는다** — 캐릭터가 {@link REROUTE_PX} 만큼 움직였을
 * 때만 다시 계산한다. 안 그러면 경로가 미세하게 떨린다.
 *
 * 복도에는 게이트웨이가 없어 '이동 중'이 되지만, 캐릭터 위치는 계속 있으므로
 * 화살표도 계속 따라온다.
 */

/** 화살표 간격 (화면 픽셀). 촘촘하면 선이 되고, 성기면 어디로 가는지 안 읽힌다 */
const STEP_PX = 13;
/** 이만큼 움직여야 경로를 다시 잡는다 (화면 픽셀) — 매번 잡으면 화살표가 떨린다 */
const REROUTE_PX = 18;
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
  /** 도면 좌표 ↔ 화면 좌표 배율 */
  scale: number;
  /** 그리기 층 — 바닥(0) 위, 사람(1) 아래 */
  depth: number;
}

export class GuideLayer {
  private d: GuideDeps;
  private arrows: Phaser.GameObjects.Triangle[] = [];
  private target: string | null = null;
  /** 경로를 뽑을 때 캐릭터가 서 있던 자리 (화면 좌표) */
  private routedAt: { x: number; y: number } | null = null;

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
    this.routedAt = null; // 다음 갱신에서 새로 그린다
    if (!zoneId) this.clear();
  }

  /**
   * 매 프레임 호출. 캐릭터가 충분히 움직였으면 경로를 다시 깔고,
   * 지나온 화살표를 흐리게 한다.
   */
  update(selfX: number, selfY: number, time: number): void {
    if (!this.target) return;
    const moved =
      !this.routedAt || Math.hypot(selfX - this.routedAt.x, selfY - this.routedAt.y) > REROUTE_PX;
    if (moved) this.draw(selfX, selfY);
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

  private draw(selfX: number, selfY: number): void {
    this.clear();
    this.routedAt = { x: selfX, y: selfY };
    const to = this.target ? this.d.zones.get(this.target) : undefined;
    if (!to) return;

    // 길찾기는 도면 좌표로 한다 — 화면 좌표를 그대로 넣으면 격자를 벗어난다
    const fx = selfX / this.d.scale;
    const fy = selfY / this.d.scale;
    const route = this.d.pf.findPath(fx, fy, to.tilePosition.x, to.tilePosition.y);
    if (!route || route.length < 1) return;

    // ⚠️ findPath 는 **꺾이는 지점만** 돌려준다 — 출발점은 안 들어 있다. 걸을 때는
    //    캐릭터가 이미 그 자리라 상관없지만, 길을 그릴 때 그대로 쓰면 화살표가 내
    //    발밑이 아니라 첫 모퉁이에서 시작한다. 여기서 출발점을 앞에 붙인다.
    //    (단순화가 출발점에서 첫 지점까지 가시선을 보장하므로 벽을 뚫지 않는다)
    const pts = [{ x: fx, y: fy }, ...route];

    // 경로 꺾은선을 일정 간격으로 훑으며 진행 방향으로 돌린 화살표를 놓는다
    let carry = 0;
    for (let i = 1; i < pts.length; i++) {
      const ax = pts[i - 1].x * this.d.scale;
      const ay = pts[i - 1].y * this.d.scale;
      const bx = pts[i].x * this.d.scale;
      const by = pts[i].y * this.d.scale;
      const seg = Math.hypot(bx - ax, by - ay);
      if (seg < 0.01) continue; // 같은 자리면 방향을 못 정한다
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
