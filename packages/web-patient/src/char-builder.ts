/**
 * 환자 캐릭터 조합 — 파츠를 겹쳐 스프라이트 시트 한 장을 만든다.
 *
 * 원본(Character Generator 2.0)은 몸·눈·옷·머리·액세서리를 **따로따로 반투명 시트**로 준다.
 * 겹치는 순서가 곧 앞뒤 순서다. `tools/build-charparts.py` 가 필요한 네 동작만 잘라
 * 파츠당 한 줄(72프레임)로 만들어 두었으므로, 여기서는 **한 번만 겹치면** idle·걷기·
 * 앉기·폰이 다 나온다.
 *
 * 고르는 화면은 파츠를 **고른 것만** 받는다 (머리만 200개다). 미리보기가 곧 합성
 * 결과라 목록용 축소 이미지는 따로 두지 않는다.
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

/** 같은 모양의 색 변형 하나. `hex` 는 파츠에서 직접 뽑은 대표색 (고르는 화면의 동그라미) */
export interface PartColor {
  id: string;
  hex: string;
}
/** 모양 하나 + 그 모양의 색들. 피부·눈은 모양이 1종이고 색만 여럿이다 */
export interface PartShape {
  id: string;
  colors: PartColor[];
}

export interface Manifest {
  /** 동작 → [시작 프레임, 프레임 수] */
  frames: Record<string, [number, number]>;
  parts: Record<PartKey, PartShape[]>;
}

/** 고른 파츠. 액세서리만 비어 있을 수 있다 */
export type CharChoice = Record<PartKey, string>;

/** 미리보기가 돌릴 동작 → [시작 프레임, 프레임 수] */
export type PoseFrames = Record<string, [number, number]>;

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

/** ⚠️ 도트가 뭉개지지 않게 보간을 반드시 끈다 */
function sheetCanvas(frameCount: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement('canvas');
  canvas.width = frameCount * FW;
  canvas.height = FH;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  return [canvas, ctx];
}

/** 고른 파츠를 겹쳐 시트 한 장으로 */
export async function composeSheet(
  assetBase: string,
  choice: CharChoice,
  frameCount: number,
): Promise<HTMLCanvasElement> {
  const [canvas, ctx] = sheetCanvas(frameCount);
  // 순서대로 기다리면 파츠 5개가 줄서서 받아진다 — 화살표를 누를 때마다 그러면 굼뜨다
  const layers = await Promise.all(
    PART_ORDER.map((key) =>
      choice[key] ? loadImage(`${assetBase}charparts/${key}/${choice[key]}.png`) : null,
    ),
  );
  for (const img of layers) if (img) ctx.drawImage(img, 0, 0);
  return canvas;
}

/** 고정 4종은 동작마다 파일이 나뉘어 있다 — 조합형과 같은 배치로 이어 붙여 한 장으로 */
export const FIXED_POSES: PoseFrames = { idle: [0, 24], walk: [24, 24], sit: [48, 12] };

export async function composeFixedSheet(
  assetBase: string,
  charId: string,
): Promise<HTMLCanvasElement> {
  const [canvas, ctx] = sheetCanvas(60);
  const files: Array<[string, string]> = [
    ['idle', 'idle'],
    ['run', 'walk'],
    ['sit', 'sit'],
  ];
  const imgs = await Promise.all(
    files.map(([f]) => loadImage(`${assetBase}characters/${charId}-${f}.png`)),
  );
  imgs.forEach((img, i) => ctx.drawImage(img, FIXED_POSES[files[i][1]][0] * FW, 0));
  return canvas;
}

/**
 * 미리보기 재생기 — 시트 한 장을 받아 캔버스에 한 동작을 돌린다.
 *
 * 고르는 동안 캐릭터가 서서 숨을 쉬어야 "내 캐릭터" 로 보인다. 정지 그림이면
 * 그냥 아이콘 고르는 화면이 된다.
 */
export class CharPreview {
  private ctx: CanvasRenderingContext2D;
  private sheet: HTMLCanvasElement | null = null;
  private frames: PoseFrames = {};
  private pose = 'idle';
  private raf = 0;
  private last = 0;
  private at = 0;
  private readonly zoom: number;

  constructor(canvas: HTMLCanvasElement, zoom = 5) {
    this.zoom = zoom;
    canvas.width = FW * zoom;
    canvas.height = FH * zoom;
    this.ctx = canvas.getContext('2d')!;
    this.ctx.imageSmoothingEnabled = false;
  }

  setSheet(sheet: HTMLCanvasElement, frames: PoseFrames): void {
    this.sheet = sheet;
    this.frames = frames;
    if (!this.frames[this.pose]) this.pose = 'idle';
    this.draw();
  }

  setPose(pose: string): void {
    if (!this.frames[pose]) return;
    this.pose = pose;
    this.at = 0;
    this.draw();
  }

  /** 동작마다 속도가 다르다 — 걷기가 숨쉬기보다 빨라야 걷는 것으로 보인다 */
  private rate(): number {
    return this.pose === 'walk' ? 100 : this.pose === 'sit' ? 250 : 166;
  }

  private draw(): void {
    const [start, count] = this.frames[this.pose] ?? [0, 1];
    // 서기·걷기는 4방향이 붙어 있다 — 정면(아래)이 4번째 묶음이라 18칸 뒤에서 시작한다.
    // 앉기는 좌·우 두 벌뿐이라 앞의 오른쪽 벌을 쓴다.
    const offset = count === 24 ? 18 : 0;
    const len = Math.min(6, count);
    const f = start + offset + (this.at % len);
    const z = this.zoom;
    this.ctx.clearRect(0, 0, FW * z, FH * z);
    if (this.sheet) this.ctx.drawImage(this.sheet, f * FW, 0, FW, FH, 0, 0, FW * z, FH * z);
  }

  start(): void {
    const step = (t: number): void => {
      if (t - this.last >= this.rate()) {
        this.last = t;
        this.at++;
        this.draw();
      }
      this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
  }
}
