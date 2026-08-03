import type Phaser from 'phaser';
import { paceForPath, pathLengthPx, type UpdateClock } from '@meditracker/shared';
import type { Pathfinder } from './pathfinder';

/**
 * 환자 화면에 보이는 **다른 사람들**.
 *
 * 환자용은 직원용과 같은 그림이어야 하므로(도트 스킨 + 확대만 다름) 서버가 주는
 * 같은 좌표를 그대로 쓴다. 다만 넘어오는 건 익명 id·좌표·손님/직원 구분뿐이고
 * 이름·MAC·personId 는 없다 (서버 `patientSeesEveryone` 스위치로 끌 수 있다).
 *
 * 좌표는 몇 초에 한 번 오므로, 그 사이는 직원용과 같은 방식으로 **걸어서** 좁힌다.
 */
/** 그리기 층: 배경(0) < 다른 사람(1) < 본인(2) < 이름표(3) */
export const DEPTH_CROWD = 1;

export interface CrowdUnit {
  id: string;
  /** 도면 좌표 */
  x: number;
  y: number;
  kind: 'patient' | 'staff';
}

export interface CrowdDeps {
  scene: Phaser.Scene;
  pf: Pathfinder;
  /** 도면 좌표 → 화면 좌표 배율 */
  mapScale: number;
  /**
   * 좌표 브로드캐스트 주기 관측 (본인 캐릭터와 공유).
   * ⚠️ 여기서 `tick()` 을 부르면 안 된다 — 같은 브로드캐스트에서 pos:self 가 이미 부르므로
   *    두 번 세면 주기 추정이 0으로 수렴한다.
   */
  clock: UpdateClock;
  /** 도착 판정 거리 (화면 px) */
  arriveEps: number;
  /** kind 별 스프라이트 시트 키를 고른다 (id 로 캐릭터를 흩뿌리는 것도 여기서) */
  sheetFor(unit: CrowdUnit): string;
  /** 시트 키 → idle/걷기 애니메이션 키 */
  animFor(sheet: string, moving: boolean): string;
}

interface Member {
  sprite: Phaser.GameObjects.Sprite;
  sheet: string;
  path: Array<{ x: number; y: number }>;
  lastSeen: number;
  /** 직전 서버 좌표 (도면) — 경로 출발점. 직원용 패널과 같은 A* 입력을 쓰기 위한 것 */
  lastPoint: { x: number; y: number };
  /** 이번 구간 속도 (도면 px/초) */
  pace: number;
}

export class Crowd {
  private members = new Map<string, Member>();

  constructor(private d: CrowdDeps) {}

  get size(): number {
    return this.members.size;
  }

  /** 서버가 준 좌표 목록에 맞춘다 (처음 보는 사람은 그 자리에 바로 세운다) */
  sync(units: CrowdUnit[], now = Date.now()): void {
    for (const u of units) {
      const x = u.x * this.d.mapScale;
      const y = u.y * this.d.mapScale;
      let m = this.members.get(u.id);
      if (!m) {
        const sheet = this.d.sheetFor(u);
        const sprite = this.d.scene.add
          .sprite(x, y, sheet)
          .setOrigin(0.5, 0.85)
          .setAlpha(0)
          // ⚠️ 음수 depth 를 쓰면 배경 픽셀맵(depth 0) 뒤로 들어가 아예 안 보인다.
          //    배경 위·본인 캐릭터 아래 = DEPTH_CROWD (main.ts 의 depth 층 참고)
          .setDepth(DEPTH_CROWD);
        sprite.play(this.d.animFor(sheet, false));
        this.d.scene.tweens.add({ targets: sprite, alpha: 0.92, duration: 350 });
        m = { sprite, sheet, path: [], lastSeen: now, lastPoint: { x: u.x, y: u.y }, pace: 0 };
        this.members.set(u.id, m);
        continue;
      }
      m.lastSeen = now;
      // 목표까지 벽을 피해 걷는다 (직선으로 가면 벽을 통과한다).
      // 출발점은 스프라이트 위치가 아니라 **직전 서버 좌표** — 직원용 패널과 A* 입력을
      // 같게 만들어야 같은 경로가 나온다 (스프라이트에서 재면 다른 문으로 돌아간다).
      const cur = { x: m.sprite.x / this.d.mapScale, y: m.sprite.y / this.d.mapScale };
      const dest = this.d.pf.nearestWalkable(u.x, u.y);
      const routeFrom = (fx: number, fy: number): Array<{ x: number; y: number }> =>
        this.d.pf.hasLineOfSight(fx, fy, dest.x, dest.y)
          ? [dest]
          : (this.d.pf.findPath(fx, fy, dest.x, dest.y) ?? [dest]);

      let route = routeFrom(m.lastPoint.x, m.lastPoint.y);
      m.lastPoint = { x: u.x, y: u.y };
      // 스프라이트와 경로 시작점 사이가 벽으로 막혀 있으면 붙이지 말고 경로를 다시 잡는다
      // (붙이면 화면에서 벽을 뚫고 순간이동한 것으로 보인다)
      if (route[0] && !this.d.pf.hasLineOfSight(cur.x, cur.y, route[0].x, route[0].y)) {
        route = routeFrom(cur.x, cur.y);
      }
      // 다음 좌표가 올 때쯤 도착하도록 매 구간 속도를 다시 정한다 (고정 속도면 못 따라잡는다)
      m.pace = paceForPath(pathLengthPx(cur, route), this.d.clock.intervalMs);
      m.path = route.map((p) => ({ x: p.x * this.d.mapScale, y: p.y * this.d.mapScale }));
    }

    // 목록에서 사라진 사람은 페이드아웃 (자리비움·태그 반납)
    for (const [id, m] of this.members) {
      if (m.lastSeen === now) continue;
      if (units.length === 0) continue;
      this.members.delete(id);
      this.d.scene.tweens.add({
        targets: m.sprite,
        alpha: 0,
        duration: 350,
        onComplete: () => m.sprite.destroy(),
      });
    }
  }

  /**
   * 모두를 마지막 서버 좌표로 즉시 붙인다 (탭 복귀용).
   * 백그라운드 동안 rAF 가 멈춰 뒤처진 걸 걸어서 메우려 하면 그 사이 새 좌표가 또 오므로
   * 영영 못 따라잡는다 — 직원용 화면과 어긋난 채로 굳는다.
   */
  snapAll(): void {
    for (const m of this.members.values()) {
      m.sprite.setPosition(m.lastPoint.x * this.d.mapScale, m.lastPoint.y * this.d.mapScale);
      m.path = [];
    }
  }

  /** 매 프레임 이동 (직원용 아바타와 같은 페이싱 — walk-pacing.ts) */
  update(delta: number): void {
    for (const m of this.members.values()) {
      let remaining = (m.pace * this.d.mapScale * delta) / 1000;
      let moved = false;
      while (remaining > 0 && m.path.length > 0) {
        const wp = m.path[0];
        const dx = wp.x - m.sprite.x;
        const dy = wp.y - m.sprite.y;
        const dist = Math.hypot(dx, dy);
        if (m.path.length === 1 && dist <= this.d.arriveEps) {
          m.path.shift();
          break;
        }
        moved = true;
        m.sprite.setFlipX(dx < 0);
        if (dist <= remaining) {
          m.sprite.setPosition(wp.x, wp.y);
          remaining -= dist;
          m.path.shift();
          continue;
        }
        m.sprite.setPosition(m.sprite.x + (dx / dist) * remaining, m.sprite.y + (dy / dist) * remaining);
        remaining = 0;
      }
      const want = this.d.animFor(m.sheet, moved);
      if (m.sprite.anims.currentAnim?.key !== want) m.sprite.play(want, true);
    }
  }
}
