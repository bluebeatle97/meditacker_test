/**
 * 환자 캐릭터 조합 — 파츠를 겹쳐 스프라이트 시트 한 장을 만든다.
 *
 * 원본(Character Generator 2.0)은 몸·눈·옷·머리·액세서리를 **따로따로 반투명 시트**로 준다.
 * 겹치는 순서가 곧 앞뒤 순서다. `tools/build-charparts.py` 가 필요한 네 동작만 잘라
 * 파츠당 한 줄(72프레임)로 만들어 두었으므로, 여기서는 **한 번만 겹치면** idle·걷기·
 * 앉기·폰이 다 나온다.
 *
 * 고르는 화면에서는 파츠 원본을 다 받지 않는다 — 머리만 200개다. 미리보기 묶음
 * (`*-thumbs.png`, 다 합쳐 57KB)만 받고, **고른 것만** 원본을 받아 합성한다.
 *
 * ⚠️ 라이선스: Modern Interiors 유료판 — 상업 이용 가능, 크레딧(limezu.itch.io) 필요,
 *    에셋 재배포 금지.
 */

import { isValidCharId } from '@meditracker/shared';

const FW = 16;
const FH = 32;

/** 겹치는 순서 (뒤 → 앞). 액세서리는 '없음' 이 기본이라 빈 값을 허용한다 */
export const PART_ORDER = ['body', 'eyes', 'outfit', 'hair', 'accessory'] as const;
export type PartKey = (typeof PART_ORDER)[number];

export interface Manifest {
  body: string[];
  eyes: string[];
  outfit: string[];
  hair: string[];
  accessory: string[];
  /** 동작 → [시작 프레임, 프레임 수] */
  frames: Record<string, [number, number]>;
}

/** 고른 파츠. 액세서리만 비어 있을 수 있다 */
export type CharChoice = Record<PartKey, string>;

/**
 * DB 에 넣을 문자열. `patient_profiles.char_id` 가 TEXT 라 그대로 들어간다.
 * JSON 대신 구분자를 쓰는 건 DB 를 눈으로 열어봤을 때 읽히게 하려는 것.
 */
export function encodeChoice(c: CharChoice): string {
  return PART_ORDER.map((k) => c[k] ?? '').join('|');
}

export function decodeChoice(s: string): CharChoice | null {
  // 형식 검사는 서버와 같은 것을 쓴다 — 서버가 받아준 값이 화면에서 파일 경로가 되므로
  // 두 곳의 규칙이 갈리면 저장은 됐는데 안 그려지는 상태가 된다
  if (!isValidCharId(s) || !s.includes('|')) return null;
  const v = s.split('|');
  return Object.fromEntries(PART_ORDER.map((k, i) => [k, v[i]])) as CharChoice;
}

/** 조합형 char_id 인가 (예전 'adam' 같은 고정 캐릭터와 구분) */
export function isComposed(charId: string): boolean {
  return charId.includes('|');
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`파츠를 불러오지 못했습니다: ${src}`));
    img.src = src;
  });
}

/**
 * 고른 파츠를 겹쳐 시트 한 장으로.
 * ⚠️ 도트가 뭉개지지 않게 `imageSmoothingEnabled = false` 를 반드시 끈다.
 */
export async function composeSheet(
  assetBase: string,
  choice: CharChoice,
  frameCount: number,
): Promise<HTMLCanvasElement> {
  const canvas = document.createElement('canvas');
  canvas.width = frameCount * FW;
  canvas.height = FH;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;

  for (const key of PART_ORDER) {
    const id = choice[key];
    if (!id) continue; // 액세서리 '없음'
    const img = await loadImage(`${assetBase}charparts/${key}/${id}.png`);
    ctx.drawImage(img, 0, 0);
  }
  return canvas;
}

/**
 * 파츠가 없을 때 쓰는 고정 캐릭터 4종의 미리보기.
 * idle 시트(384x32)의 정면 프레임(18번) 한 장만 잘라 쓴다.
 */
export function fixedThumbStyle(assetBase: string, charId: string, zoom = 3): string {
  return [
    `background-image:url(${assetBase}characters/${charId}-idle.png)`,
    `background-position:-${18 * FW * zoom}px 0`,
    `background-size:auto ${FH * zoom}px`,
    'background-repeat:no-repeat',
    'image-rendering:pixelated',
    `width:${FW * zoom}px`,
    `height:${FH * zoom}px`,
  ].join(';');
}

/** 미리보기 묶음에서 한 칸만 잘라 배경 이미지로 (파츠 원본을 안 받고 목록을 그린다) */
export function thumbStyle(assetBase: string, key: PartKey, index: number, zoom = 3): string {
  return [
    `background-image:url(${assetBase}charparts/${key}-thumbs.png)`,
    `background-position:-${index * FW * zoom}px 0`,
    `background-size:auto ${FH * zoom}px`,
    'background-repeat:no-repeat',
    'image-rendering:pixelated',
    `width:${FW * zoom}px`,
    `height:${FH * zoom}px`,
  ].join(';');
}
