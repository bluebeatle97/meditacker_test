import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 캐릭터 스프라이트 시트의 규격 검증.
 *
 * **왜 있는가.** 앉기 원본은 32px 프레임에 사람을 16px 폭으로 넣어 둔다. 다른 포즈처럼
 * 16px 로 자르면 사람이 정확히 반으로 쪼개져 두 프레임에 걸친다 — 화면에서는 반쪽이
 * 좌우로 왔다갔다하는 것으로 보였다. `tools/build-characters.py` 가 추출할 때 16px 로
 * 다시 담는데, 그 처리를 빠뜨리고 재추출하면 폭이 두 배가 되어 같은 증상이 돌아온다.
 * 눈으로 봐야 알 수 있는 종류라 시트 크기로 못을 박아 둔다.
 */

const here = dirname(fileURLToPath(import.meta.url));
const DIR = join(here, '../public/characters');
const CHARACTERS = ['adam', 'alex', 'amelia', 'bob'];

/** PNG IHDR 에서 크기만 읽는다 (디코더를 끌어올 만한 일이 아니다) */
function pngSize(file: string): { w: number; h: number } {
  const buf = readFileSync(file);
  expect(buf.subarray(1, 4).toString('ascii'), `${file} 가 PNG 가 아님`).toBe('PNG');
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

/** 포즈 → 기대 프레임 수. 앱의 애니메이션 정의가 이 수를 전제로 한다 */
const EXPECTED_FRAMES: Record<string, number> = {
  idle: 24, // 6프레임 x 4방향
  run: 24, // 6프레임 x 4방향
  sit: 12, // 6프레임 x 2벌 — 방향 없음. 32px 원본을 16px 로 다시 담은 결과
  phone: 9, // 단일 방향
};

const FRAME_W = 16;
const FRAME_H = 32;

describe('캐릭터 스프라이트 시트', () => {
  for (const char of CHARACTERS) {
    for (const [pose, frames] of Object.entries(EXPECTED_FRAMES)) {
      it(`${char}-${pose}: ${FRAME_W}x${FRAME_H} 프레임 ${frames}개`, () => {
        const { w, h } = pngSize(join(DIR, `${char}-${pose}.png`));
        expect(h, '프레임 높이').toBe(FRAME_H);
        expect(w % FRAME_W, `폭 ${w} 가 ${FRAME_W} 의 배수가 아님`).toBe(0);
        expect(w / FRAME_W, '프레임 수').toBe(frames);
      });
    }
  }

  it('앉기 시트가 걷기와 같은 프레임 수면 재추출 때 재정렬이 빠진 것이다', () => {
    // 이 등식이 성립하면 32px 원본을 그대로 복사했다는 뜻 — 사람이 반으로 쪼개진다
    for (const char of CHARACTERS) {
      const sit = pngSize(join(DIR, `${char}-sit.png`)).w;
      const run = pngSize(join(DIR, `${char}-run.png`)).w;
      expect(sit, `${char}: sit 폭이 run 과 같다 (재정렬 누락 의심)`).not.toBe(run);
    }
  });
});
