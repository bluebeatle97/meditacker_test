/**
 * 캐릭터 만들기 화면 — 메이플스토리 캐릭터 생성창 방식.
 *
 * 항목이 전부 한 화면에 줄로 펼쳐져 있고, **모양은 ◀ ▶ 로 넘기고 색은 동그라미로**
 * 고른다. 가운데 캐릭터는 숨을 쉬고, 누르면 걷기·앉기도 보여준다.
 *
 * 왜 목록을 스크롤하지 않는가: 머리만 200개다. 격자로 늘어놓으면 고르는 게 아니라
 * 찾는 일이 된다. 이름이 `<모양>_<색>` 이라 29모양 x 7색으로 갈라지고, 그게 곧
 * 사람이 캐릭터를 고르는 순서다 ("이 머리 모양에, 이 색").
 */

import {
  CharPreview,
  FIXED_POSES,
  PART_ORDER,
  composeFixedSheet,
  composeSheet,
  encodeChoice,
  type CharChoice,
  type Manifest,
  type PartKey,
  type PartShape,
} from './char-builder';

const LABEL: Record<PartKey, string> = {
  hair: '머리',
  outfit: '옷',
  body: '피부',
  eyes: '눈',
  accessory: '장식',
};
/** 화면에 보일 순서 — 겹치는 순서(PART_ORDER)와 다르다. 눈에 띄는 것부터 고른다 */
const ROW_ORDER: PartKey[] = ['hair', 'outfit', 'body', 'eyes', 'accessory'];

const POSES: Array<[string, string]> = [
  ['idle', '서기'],
  ['walk', '걷기'],
  ['sit', '앉기'],
];

/** 한 항목의 현재 선택. 모양 -1 은 '없음' (장식만 가능) */
interface Pick {
  shape: number;
  color: number;
}

/** 화살표·동그라미 한 줄 */
function rowHtml(key: PartKey, name: string): string {
  return `
    <div class="cc-row" data-k="${key}">
      <span class="nm">${name}</span>
      <div class="pick">
        <button class="arw" data-d="-1" type="button" aria-label="${name} 이전">◀</button>
        <span class="cnt"></span>
        <button class="arw" data-d="1" type="button" aria-label="${name} 다음">▶</button>
      </div>
      <div class="sw"></div>
    </div>`;
}

/** 고르는 화면을 조작하는 손잡이. 언제 끝낼지는 부르는 쪽이 정한다 */
export interface CharPicker {
  /** 지금까지 고른 것의 `char_id` */
  charId(): string;
  /** 미리보기 애니메이션 정지 (화면을 닫을 때) */
  stop(): void;
}

/**
 * 고르는 화면을 붙이고 손잡이를 돌려준다.
 *
 * 다 고른 시점을 여기서 정하지 않는 것은 **별명 단계에서 되돌아올 수 있어야** 하기
 * 때문이다. 약속(Promise)으로 끝내버리면 '캐릭터 다시 만들기' 가 처음부터 다시
 * 만드는 일이 된다 — 고른 것이 그대로 남아 있어야 한다.
 *
 * `manifest` 가 없으면(파츠를 안 만든 기기 — 공개 시연판) 고정 4종에서 고른다.
 */
export function mountCharPicker(
  assetBase: string,
  manifest: Manifest | null,
  fixedIds: string[],
): CharPicker {
  const rows = document.getElementById('cc-rows')!;
  const view = document.getElementById('cc-view') as HTMLCanvasElement;
  const poseBar = document.getElementById('cc-poses')!;
  const dice = document.getElementById('cc-random') as HTMLButtonElement;
  const start = document.getElementById('start') as HTMLButtonElement;

  const preview = new CharPreview(view);
  preview.start();

  poseBar.innerHTML = POSES.map(
    ([p, t], i) => `<button data-p="${p}" type="button" class="${i ? '' : 'on'}">${t}</button>`,
  ).join('');
  poseBar.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!b) return;
    for (const o of Array.from(poseBar.children)) o.classList.toggle('on', o === b);
    preview.setPose(b.dataset.p!);
  });

  return manifest
    ? mountParts(assetBase, manifest, { rows, dice, start, preview })
    : mountFixed(assetBase, fixedIds, { rows, dice, start, preview });
}

interface Ui {
  rows: HTMLElement;
  dice: HTMLButtonElement;
  start: HTMLButtonElement;
  preview: CharPreview;
}

function mountParts(assetBase: string, manifest: Manifest, ui: Ui): CharPicker {
  {
    const parts = manifest.parts;
    const total = Object.values(manifest.frames).reduce((n, [, c]) => n + c, 0);
    const pick: Record<PartKey, Pick> = {
      body: { shape: 0, color: 0 },
      eyes: { shape: 0, color: 0 },
      outfit: { shape: 0, color: 0 },
      hair: { shape: 0, color: 0 },
      accessory: { shape: -1, color: 0 }, // 장식은 '없음' 이 기본
    };

    const shapesOf = (k: PartKey): PartShape[] => parts[k] ?? [];
    const colorsOf = (k: PartKey): PartShape['colors'] =>
      pick[k].shape < 0 ? [] : (shapesOf(k)[pick[k].shape]?.colors ?? []);

    const choice = (): CharChoice =>
      Object.fromEntries(
        PART_ORDER.map((k) => [k, colorsOf(k)[pick[k].color]?.id ?? '']),
      ) as CharChoice;

    ui.rows.innerHTML = ROW_ORDER.filter((k) => shapesOf(k).length).map((k) =>
      rowHtml(k, LABEL[k]),
    ).join('');

    // 화살표를 빠르게 연타하면 늦게 온 응답이 나중에 덮어써서 딴 캐릭터가 남는다.
    // 마지막 요청 번호만 반영한다.
    let seq = 0;
    const redraw = async (): Promise<void> => {
      const mine = ++seq;
      const sheet = await composeSheet(assetBase, choice(), total);
      if (mine === seq) ui.preview.setSheet(sheet, manifest.frames);
    };

    const paint = (): void => {
      for (const el of Array.from(ui.rows.querySelectorAll<HTMLElement>('.cc-row'))) {
        const k = el.dataset.k as PartKey;
        const shapes = shapesOf(k);
        const colors = colorsOf(k);
        const one = shapes.length === 1; // 피부·눈은 모양이 하나뿐 — 화살표를 보일 이유가 없다
        el.querySelector<HTMLElement>('.pick')!.style.visibility = one ? 'hidden' : 'visible';
        el.querySelector('.cnt')!.textContent =
          pick[k].shape < 0 ? '없음' : `${pick[k].shape + 1} / ${shapes.length}`;
        el.querySelector('.sw')!.innerHTML = colors
          .map(
            (c, i) =>
              `<i class="${i === pick[k].color ? 'on' : ''}" data-i="${i}" ` +
              `style="background:${c.hex}" title="${i + 1}번 색"></i>`,
          )
          .join('');
      }
      void redraw();
    };

    ui.rows.addEventListener('click', (e) => {
      const el = e.target as HTMLElement;
      const row = el.closest<HTMLElement>('.cc-row');
      if (!row) return;
      const k = row.dataset.k as PartKey;
      const arw = el.closest<HTMLElement>('.arw');
      if (arw) {
        // 장식만 맨 앞에 '없음'(-1)이 하나 더 있다
        const lo = k === 'accessory' ? -1 : 0;
        const n = shapesOf(k).length;
        const span = n - lo;
        pick[k].shape = ((pick[k].shape - lo + Number(arw.dataset.d) + span) % span) + lo;
        // 색 개수는 모양마다 다르다. 1번으로 되돌리면 넘길 때마다 색이 리셋돼 짜증나므로
        // 있는 데까지만 당긴다
        pick[k].color = Math.min(pick[k].color, Math.max(0, colorsOf(k).length - 1));
        paint();
        return;
      }
      const sw = el.closest<HTMLElement>('.sw i');
      if (sw) {
        pick[k].color = Number(sw.dataset.i);
        paint();
      }
    });

    ui.dice.addEventListener('click', () => {
      for (const k of PART_ORDER) {
        const n = shapesOf(k).length;
        if (!n) continue;
        // 장식은 절반쯤 '없음' 으로 — 전원이 파티모자를 쓰고 있으면 그게 더 이상하다
        pick[k].shape =
          k === 'accessory' && Math.random() < 0.5 ? -1 : Math.floor(Math.random() * n);
        pick[k].color = Math.floor(Math.random() * Math.max(1, colorsOf(k).length));
      }
      paint();
    });

    paint();
    ui.start.disabled = false; // 기본 조합이 이미 유효하다
    return { charId: () => encodeChoice(choice()), stop: () => ui.preview.stop() };
  }
}

/**
 * 파츠가 없을 때 — 고정 4종에서 고른다.
 *
 * 원본 에셋은 **재배포 금지**라 파츠 432개를 공개 저장소·공개 배포에 올리지 않는다
 * (`tools/build-charparts.py` 로 각 기기에서 만든다). 그래도 입장은 돼야 한다.
 */
function mountFixed(assetBase: string, ids: string[], ui: Ui): CharPicker {
  {
    let at = 0;
    ui.rows.innerHTML = rowHtml('body', '캐릭터');

    let seq = 0;
    const paint = async (): Promise<void> => {
      ui.rows.querySelector('.cnt')!.textContent = `${at + 1} / ${ids.length}`;
      const mine = ++seq;
      const sheet = await composeFixedSheet(assetBase, ids[at]);
      if (mine === seq) ui.preview.setSheet(sheet, FIXED_POSES);
    };

    ui.rows.addEventListener('click', (e) => {
      const arw = (e.target as HTMLElement).closest<HTMLElement>('.arw');
      if (!arw) return;
      at = (at + Number(arw.dataset.d) + ids.length) % ids.length;
      void paint();
    });
    ui.dice.addEventListener('click', () => {
      at = Math.floor(Math.random() * ids.length);
      void paint();
    });
    void paint();
    ui.start.disabled = false;
    return { charId: () => ids[at], stop: () => ui.preview.stop() };
  }
}
