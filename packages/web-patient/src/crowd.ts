import type Phaser from 'phaser';
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
  /** 걷는 속도 (화면 px/초) */
  walkSpeed: number;
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
          .setDepth(-1); // 본인 캐릭터보다 뒤에
        sprite.play(this.d.animFor(sheet, false));
        this.d.scene.tweens.add({ targets: sprite, alpha: 0.92, duration: 350 });
        m = { sprite, sheet, path: [], lastSeen: now };
        this.members.set(u.id, m);
        continue;
      }
      m.lastSeen = now;
      // 목표까지 벽을 피해 걷는다 (직선으로 가면 벽을 통과한다)
      const from = { x: m.sprite.x / this.d.mapScale, y: m.sprite.y / this.d.mapScale };
      const dest = this.d.pf.nearestWalkable(u.x, u.y);
      const route = this.d.pf.hasLineOfSight(from.x, from.y, dest.x, dest.y)
        ? [dest]
        : this.d.pf.findPath(from.x, from.y, dest.x, dest.y) ?? [dest];
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

  /** 매 프레임 이동 (직원용 아바타와 같은 등속 보행) */
  update(delta: number): void {
    const step = (this.d.walkSpeed * delta) / 1000;
    for (const m of this.members.values()) {
      let remaining = step;
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
