#!/usr/bin/env python3
"""손님 통제구역(직원 전용) 마스크 만들기.

    python tools/build-staff-areas.py

입력:  packages/server/src/config/staff-area.png   ← **사람이 칠한 그림**
출력:  packages/server/src/config/staff-area.json  (통행 격자와 같은 칸 배열)

## 왜 도면에 안 칠하는가

직원용 화면은 **실제 도면을 그대로** 보여준다. 거기에 구역 색을 박으면 도면이 훼손되고,
직원이 보는 그림에 손님용 표시가 섞인다. 통제구역은 **환자용 화면의 개념**이므로
마스크를 따로 둔다 — 도면은 그대로, 환자용 도트맵만 검게 칠한다.

## 왜 자동으로 안 뽑는가

두 번 해봤고 두 번 다 틀렸다:

  1. 방 분할(segment_rooms) → v2 도면은 문을 안 그려서 방이 복도로 새어 나갔다.
     마스크로 막고 재보니 환자 구역 56조합 중 42개가 서로 못 닿았다 (복도가 끊겼다)
  2. 기준점에서 흰 바닥 번지기 → 층 전체가 흰색 하나로 이어져 도면이 통째로 찼다

문이 안 그려진 도면에서 "방의 범위" 는 그림만 봐서는 결정되지 않는다. 사람이 짚는다.

## 그림 고치는 법

`staff-area.png` 를 열어 자홍색(#FF00FF)으로 칠하거나 지우고 이 스크립트를 다시 돌린다.
도면과 크기가 달라도 된다 — 여기서 맞춘다.
"""
import json
import os
import sys

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CFG = os.path.join(ROOT, "packages", "server", "src", "config")
MARK = os.path.join(CFG, "staff-area.png")
OUT = os.path.join(CFG, "staff-area.json")
CELL = 4  # walkable.json 과 같아야 한다


def is_mark(p):
    r, g, b = p[:3]
    return r > 200 and g < 80 and b > 200


def main():
    plan = json.load(open(os.path.join(CFG, "floorplan.json"), encoding="utf-8"))
    W, H = plan["width"], plan["height"]
    if not os.path.exists(MARK):
        print(f"칠한 그림이 없다: {MARK} — 빈 마스크를 쓴다")
        img = Image.new("RGB", (W, H), (255, 255, 255))
    else:
        img = Image.open(MARK).convert("RGB")
        # ⚠️ 도면과 픽셀 단위로 같아야 한다. 예전에는 다른 크기를 여기서 늘려 맞췄는데,
        #    그러면 칠한 경계가 어디로 갈지 사람이 알 수 없다 (wall.png 도 같은 이유로 고쳤다).
        if img.size != (W, H):
            sys.exit(
                f"staff-area.png 가 도면과 크기가 다르다: {img.size} vs {(W, H)}\n"
                f"도면과 **같은 크기로** 그려야 한다."
            )

    px = img.load()
    cols, rows = W // CELL, H // CELL
    grid = []
    n = 0
    for r in range(rows):
        row = []
        for c in range(cols):
            k = 0
            for y in range(r * CELL, (r + 1) * CELL):
                for x in range(c * CELL, (c + 1) * CELL):
                    if is_mark(px[x, y]):
                        k += 1
            on = k / (CELL * CELL) >= 0.5
            row.append("1" if on else "0")
            n += on
        grid.append("".join(row))

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"cell": CELL, "cols": cols, "rows": rows, "grid": grid}, f)
    print(f"통제구역 {n:,}칸 = {n * CELL * CELL * 1.62 * 1.62 / 10000:.1f}m^2 → {OUT}")


if __name__ == "__main__":
    main()
