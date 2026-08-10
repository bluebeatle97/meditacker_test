import { describe, expect, it } from 'vitest';
import { UpdateClock } from '@meditracker/shared';
import { Crowd, type CrowdUnit } from './crowd';
import type { Pathfinder } from './pathfinder';

/**
 * 다른 손님 아바타의 **사라짐** 검증.
 *
 * **왜 있는가.** 화면은 "누가 나갔다" 를 따로 받지 않는다 — 매번 오는 목록에 없으면
 * 나간 것으로 친다. 그래서 목록이 통째로 비었을 때의 처리가 곧 사양이다.
 *
 * 예전에는 `units.length === 0` 이면 아무도 안 지웠다. 서버가 잘못 빈 목록을 뱉었을
 * 때를 막으려던 것인데, 진료 관련 방 손님을 빼기 시작하면서 **빈 목록이 정상 상태**가
 * 됐다(다들 진료실에 들어가 있는 시간대). 그 방어가 남아 있으면 방에 들어간 사람들이
 * 복도에 그대로 얼어붙는다. 눈으로만 보면 "왜 안 없어지지" 로 보이고 원인은 안 보인다.
 */

/** Crowd 가 실제로 건드리는 것만 흉내 낸다 (Phaser 를 끌어올 만한 일이 아니다) */
function fakeScene() {
  const sprites: Array<{ destroyed: boolean; alpha: number }> = [];
  const scene = {
    add: {
      sprite() {
        const s = {
          x: 0,
          y: 0,
          alpha: 1,
          destroyed: false,
          anims: { currentAnim: null },
          setOrigin: () => s,
          setAlpha: (a: number) => {
            s.alpha = a;
            return s;
          },
          setDepth: () => s,
          setFlipX: () => s,
          setPosition(x: number, y: number) {
            s.x = x;
            s.y = y;
            return s;
          },
          play: () => s,
          destroy() {
            s.destroyed = true;
          },
        };
        sprites.push(s);
        return s;
      },
    },
    tweens: {
      // 트윈은 즉시 끝난 것으로 친다 — 여기서 보는 건 '지워지는가' 지 연출이 아니다
      add(cfg: { onComplete?: () => void }) {
        cfg.onComplete?.();
      },
    },
  };
  return { scene, sprites };
}

/** 벽이 없는 평면 — 경로탐색은 이 테스트의 관심사가 아니다 */
const flatPf = {
  nearestWalkable: (x: number, y: number) => ({ x, y }),
  hasLineOfSight: () => true,
  findPath: () => null,
} as unknown as Pathfinder;

function makeCrowd() {
  const { scene, sprites } = fakeScene();
  const crowd = new Crowd({
    scene: scene as never,
    pf: flatPf,
    mapScale: 1,
    clock: new UpdateClock(),
    arriveEps: 1,
    sheetFor: () => 'sheet',
    animFor: () => 'anim',
  });
  return { crowd, sprites };
}

const at = (id: string, x = 100, y = 100): CrowdUnit => ({ id, x, y, kind: 'patient' });

describe('다른 손님 아바타', () => {
  it('목록에 새로 나타나면 세운다', () => {
    const { crowd } = makeCrowd();
    crowd.sync([at('a'), at('b')], 1000);
    expect(crowd.size).toBe(2);
  });

  it('목록에서 빠지면 지운다', () => {
    const { crowd } = makeCrowd();
    crowd.sync([at('a'), at('b')], 1000);
    crowd.sync([at('a')], 2000);
    expect(crowd.size).toBe(1);
  });

  it('빈 목록이 오면 전부 지운다 — 다들 진료실에 들어간 상태', () => {
    // 이 하나가 이 파일의 존재 이유다. 여기가 0이 아니면 방에 들어간 사람이
    // 복도에 서 있는 화면이 된다.
    const { crowd, sprites } = makeCrowd();
    crowd.sync([at('a'), at('b'), at('c')], 1000);
    expect(crowd.size).toBe(3);

    crowd.sync([], 2000);
    expect(crowd.size).toBe(0);
    expect(sprites.every((s) => s.destroyed)).toBe(true);
  });

  it('빈 목록 뒤에 다시 나타나면 되살아난다 — 방에서 나온 경우', () => {
    const { crowd } = makeCrowd();
    crowd.sync([at('a')], 1000);
    crowd.sync([], 2000);
    expect(crowd.size).toBe(0);

    crowd.sync([at('a')], 3000);
    expect(crowd.size).toBe(1);
  });

  it('같은 목록이 다시 와도 지우지 않는다', () => {
    const { crowd } = makeCrowd();
    crowd.sync([at('a'), at('b')], 1000);
    crowd.sync([at('a'), at('b')], 2000);
    expect(crowd.size).toBe(2);
  });
});
