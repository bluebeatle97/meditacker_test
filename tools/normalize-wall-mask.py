#!/usr/bin/env python3
"""손으로 만든 벽 마스크를 툴체인 규격으로 맞추고, 건물 밖 마스크를 뽑는다.

    python tools/normalize-wall-mask.py

입력:  packages/server/src/config/wall-mask.png   (흰색 = 벽. RGBA·회색 아무 형식이나)
출력:  같은 파일을 8비트 흑백·순수 이진으로 덮어씀
       packages/server/src/config/outside-mask.png (흰색 = 건물 밖)

## 언제 쓰나

**벽 마스크를 직접 받았을 때.** 원래 마스크는 `wall.png`(사람이 그린 2.5D 그림)에서
`build-wall-mask.py` 가 만들고, 그때 `outside-mask.png` 도 **짝으로 함께** 나온다.
마스크만 갈아끼우면 그 짝이 옛 것으로 남아 통행 격자가 어긋난다.

이 스크립트는 그 짝을 마스크 기준으로 다시 만든다. `build-wall-mask.py` 를 대신 돌리면
안 된다 — 그건 `wall.png` 에서 마스크를 **생성**하므로 받은 마스크를 덮어쓴다.

## 하는 일 두 가지

1. **형식 정규화.** 받은 마스크가 RGBA 였고 안티에일리어싱 값(50·92 등)이 섞여 있었다.
   `check-walls.ts` 는 8비트 흑백만 읽어서 RGBA 면 그 자리에서 죽는다. 128 기준으로
   이진화해 순수 흑백으로 만든다 — 중간값이 남으면 "벽이냐" 를 읽는 쪽마다 다르게 답한다.

2. **건물 밖 뽑기.** 테두리에서 시작해 벽이 아닌 픽셀로 번져 나간다(4방향). 닿는 곳이
   건물 밖이고, 안쪽에 갇힌 곳은 실내 바닥이다. `build-wall-mask.py` 와 같은 절차다.

   ⚠️ 원본 스크립트는 안쪽에 갇힌 **검정을 벽(붙박이 물건)으로** 승격시킨다. 여기서는
      하지 않는다 — 받은 마스크에서는 흰색이 곧 벽이라는 판단이 이미 끝나 있고,
      그 위에 규칙을 더 얹으면 준 사람의 의도를 우리가 덮어쓰는 셈이다.
"""
import os
import sys
from collections import deque

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CFG = os.path.join(ROOT, "packages", "server", "src", "config")
THRESHOLD = 128


def main() -> None:
    mask_path = os.path.join(CFG, "wall-mask.png")
    if not os.path.exists(mask_path):
        sys.exit(f"벽 마스크가 없다: {mask_path}")

    src = Image.open(mask_path)
    fmt = src.mode
    src = src.convert("L")
    W, H = src.size
    sp = src.load()

    meta_path = os.path.join(CFG, "floorplan.json")
    if os.path.exists(meta_path):
        import json

        meta = json.load(open(meta_path, encoding="utf-8"))
        if (meta["width"], meta["height"]) != (W, H):
            sys.exit(
                f"마스크 크기({W}x{H})가 floorplan.json({meta['width']}x{meta['height']})과 다르다.\n"
                "존·게이트웨이 좌표가 전부 그 좌표계에 박혀 있으므로 크기를 맞춰야 한다."
            )

    wall = Image.new("L", (W, H), 0)
    wp = wall.load()
    wall_px = 0
    mixed = 0
    for y in range(H):
        for x in range(W):
            v = sp[x, y]
            if v not in (0, 255):
                mixed += 1
            if v >= THRESHOLD:
                wp[x, y] = 255
                wall_px += 1

    outside = bytearray(W * H)
    q: deque = deque()
    for x in range(W):
        for y in (0, H - 1):
            if wp[x, y] == 0 and not outside[y * W + x]:
                outside[y * W + x] = 1
                q.append((x, y))
    for y in range(H):
        for x in (0, W - 1):
            if wp[x, y] == 0 and not outside[y * W + x]:
                outside[y * W + x] = 1
                q.append((x, y))
    while q:
        x, y = q.popleft()
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if 0 <= nx < W and 0 <= ny < H and not outside[ny * W + nx] and wp[nx, ny] == 0:
                outside[ny * W + nx] = 1
                q.append((nx, ny))

    out = Image.new("L", (W, H), 0)
    op = out.load()
    out_px = 0
    for y in range(H):
        for x in range(W):
            if outside[y * W + x]:
                op[x, y] = 255
                out_px += 1

    wall.save(mask_path)
    out.save(os.path.join(CFG, "outside-mask.png"))

    tot = W * H
    inside = tot - wall_px - out_px
    print(f"{W}x{H} · 입력 형식 {fmt}" + (f" · 중간색 {mixed:,}px 이진화" if mixed else ""))
    print(f"  벽        {wall_px:9,}px ({wall_px / tot * 100:5.1f}%)")
    print(f"  건물 밖   {out_px:9,}px ({out_px / tot * 100:5.1f}%)")
    print(f"  실내 바닥 {inside:9,}px ({inside / tot * 100:5.1f}%)")
    print("saved wall-mask.png (8비트 흑백) · outside-mask.png")


if __name__ == "__main__":
    main()
