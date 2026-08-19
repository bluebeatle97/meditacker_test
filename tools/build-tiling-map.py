#!/usr/bin/env python3
"""바닥·벽·벽 윗면을 색으로 갈라 놓은 지도 — 에셋 자동 배치용 입력.

    python tools/build-tiling-map.py [--face 24] [--desk-face 8]

입력:  packages/server/src/config/wall-mask.png       (흰색 = 벽)
       packages/server/src/config/outside-mask.png    (흰색 = 건물 밖)
       packages/server/src/config/furniture-mask.png  (흰색 = 가구, 선택)
출력:  packages/server/src/config/tiling-map.png

## 왜 마스크로 충분한가

`wall.png`(사람이 그린 2.5D 그림)는 명도가 205단계지만 그 음영은 **사람 눈을 위한 것**이다.
에셋을 깔 때 필요한 건 "여기는 바닥, 여기는 벽" 이라는 경계뿐이고, 그건 마스크에 다 있다.
실측으로 마스크의 벽 두께 중앙값이 40px 인데 평면상 벽은 15px 남짓이라, **마스크가 이미
윗면 + 정면을 합친 골조**를 담고 있다.

## 색

    초록 (0,255,0)   바닥 — 타일을 깐다
    빨강 (255,0,0)   벽 정면 — 세로로 서서 보이는 면
    파랑 (0,0,255)   벽 윗면 — 천장과 맞닿는 면
    검정 (0,0,0)     건물 밖 — 아무것도 깔지 않는다

순수 원색만 쓴다. 중간색을 섞으면 받는 쪽이 임계값을 정해야 하고, 그 임계값이 또 하나의
합의 사항이 된다 — 색을 정확히 비교하면 끝나게 둔다.

## 정면과 윗면을 가르는 기준 — **남쪽에 바닥이 있는가**

처음엔 "위 가장자리에서 N px" 를 윗면으로 잡았다가 갈아엎었다. 그 규칙은 **세로 벽에서
틀린다** — 북쪽 끝만 윗면이 되고 긴 몸통이 전부 정면으로 찍혀서, 위에서 내려다보면
윗면이어야 할 자리에 벽면 타일이 깔린다.

2.5D 에서 정면이 보이는 건 **그 아래에 바닥이 있을 때뿐**이다. 그래서 벽 픽셀에서
**아래로** 내려가 벽이 끝날 때까지의 거리가 `--face` 이하면 정면, 나머지는 전부 윗면이다.

    가로 벽        → 아래 띠가 정면, 위쪽은 윗면
    세로 벽        → 남쪽 끝만 정면, 긴 몸통은 윗면
    양쪽이 바닥인 벽 → 북쪽은 윗면, 남쪽은 정면

즉 **윗면이 기본이고 정면이 예외**다.

## 가구는 벽보다 낮다

안내데스크는 벽이 아니라 곡선 책상이다. 벽과 같은 높이로 치면 정면이 너무 넓게 잡혀
책상 상판이 사라진다 — 위에서 보면 상판(윗면)이 넓게 보여야 한다. `furniture-mask.png`
에 칠해 둔 곳은 `--desk-face` 만큼만 정면으로 잡는다.

⚠️ 가구는 **자동으로 못 가려낸다.** 안내데스크 곡선이 주변 벽과 같은 연결 덩어리라
   (실측 확인) 형태·연결로는 갈리지 않는다. 손으로 칠한 마스크가 유일한 방법이다 —
   `staff-area.png` 를 손으로 칠하는 것과 같은 이유다.
"""
import argparse
import os
import sys

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CFG = os.path.join(ROOT, "packages", "server", "src", "config")

FLOOR = (0, 255, 0)
FACE = (255, 0, 0)
TOP = (0, 0, 255)
OUTSIDE = (0, 0, 0)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--face", type=int, default=24, help="벽 정면으로 볼 띠 두께(px)")
    ap.add_argument("--desk-face", type=int, default=8, help="가구 정면 띠 두께(px)")
    ap.add_argument("--out", default=os.path.join(CFG, "tiling-map.png"))
    args = ap.parse_args()

    wall_p = os.path.join(CFG, "wall-mask.png")
    out_p = os.path.join(CFG, "outside-mask.png")
    fur_p = os.path.join(CFG, "furniture-mask.png")
    for p in (wall_p, out_p):
        if not os.path.exists(p):
            sys.exit(f"입력이 없다: {p}")

    wall = Image.open(wall_p).convert("L")
    outside = Image.open(out_p).convert("L")
    if wall.size != outside.size:
        sys.exit(f"두 마스크 크기가 다르다: {wall.size} vs {outside.size}")
    W, H = wall.size

    fur = None
    if os.path.exists(fur_p):
        fur = Image.open(fur_p).convert("L")
        if fur.size != (W, H):
            sys.exit(f"가구 마스크 크기가 다르다: {fur.size} vs {(W, H)}")

    wp, op = wall.load(), outside.load()
    fp = fur.load() if fur else None
    img = Image.new("RGB", (W, H))
    px = img.load()

    # 아래로 몇 픽셀 만에 벽이 끝나는가 — 아래에서 위로 한 번 훑으면 전부 구해진다
    down = [0] * (W * H)
    for x in range(W):
        run = 0
        for y in range(H - 1, -1, -1):
            run = run + 1 if wp[x, y] >= 128 else 0
            down[y * W + x] = run

    n = {"floor": 0, "face": 0, "top": 0, "outside": 0, "desk": 0}
    for y in range(H):
        for x in range(W):
            if wp[x, y] >= 128:
                is_fur = fp is not None and fp[x, y] >= 128
                if is_fur:
                    n["desk"] += 1
                band = args.desk_face if is_fur else args.face
                if down[y * W + x] <= band:
                    px[x, y] = FACE
                    n["face"] += 1
                else:
                    px[x, y] = TOP
                    n["top"] += 1
            elif op[x, y] >= 128:
                px[x, y] = OUTSIDE
                n["outside"] += 1
            else:
                px[x, y] = FLOOR
                n["floor"] += 1

    img.save(args.out)
    tot = W * H
    print(f"{W}x{H} · 벽 정면 {args.face}px · 가구 정면 {args.desk_face}px"
          + (f" · 가구 {n['desk']:,}px" if fur else " · 가구 마스크 없음"))
    for k, label in (("floor", "초록 바닥"), ("face", "빨강 벽정면"),
                     ("top", "파랑 벽윗면"), ("outside", "검정 건물밖")):
        print(f"  {label:12} {n[k]:9,}px ({n[k] / tot * 100:5.1f}%)")
    print(f"saved {args.out}")


if __name__ == "__main__":
    main()
