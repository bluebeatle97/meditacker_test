#!/usr/bin/env python3
"""문 위치 뽑기 — 사람이 도면 위에 칠한 빨간 막대에서.

    python tools/build-doors.py

입력:  packages/server/src/config/floorplan-door.png  ← **사람이 칠한 그림**
           도면 위에 문틈마다 빨강(#ED1C24) 막대를 채워 넣은 것
출력:  packages/server/src/config/door.json           문 목록
       packages/server/src/config/door-preview.png    확인용 그림

## 왜 이 방식인가

문을 기하로 자동 판별하려고 두 번 해봤고 둘 다 틀렸다:

  1. **좁은 목 찾기** — 방마다 폭이 달라 기준값을 하나로 못 정했다. 층 전체가
     한 덩어리로 뭉치거나 방이 잘게 부서지거나 둘 중 하나였다
  2. **깎아내기(erosion) 후 알맹이 경계** — 위치는 그럴듯했지만 폭이 전부 19cm 로
     나왔다. 알맹이가 맞닿는 한 줄에서 재니 늘 최소값이었다

그리고 사람이 **획으로** 표시한 판(door.png)도 문제가 있었다 — 그은 길이가 곧
판정이라, 짧으면 그 틈으로 새고(실측 3곳, 최대 89cm) 길면 문 두 개가 한 덩어리로
붙었다(3곳). ㄱ자로 만난 획도 갈라내야 했다.

지금 방식은 **문틈을 벽 색으로 꽉 채워** 표시한다. 그러면 덩어리 하나가 문 하나이고,
직사각형이라 bbox 만 재면 위치·방향·크기가 다 나온다. 애매한 구석이 없다.

## 두께

칠한 막대 두께를 그대로 쓴다 — 사람이 도면 벽에 맞춰 채웠으므로 그게 곧 벽 두께다.
"""
import json
import os
import sys
from collections import deque

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CFG = os.path.join(ROOT, "packages", "server", "src", "config")
SRC = os.path.join(CFG, "floorplan-door.png")
PLAN = os.path.join(ROOT, "packages", "web-staff", "public", "floorplan.png")
OUT = os.path.join(CFG, "door.json")
PREVIEW = os.path.join(CFG, "door-preview.png")

CM_PER_PX = 1.62
MIN_PX = 60        # 이보다 작은 빨강 조각은 손떨림
MIN_FILL = 0.75    # 덩어리가 제 bbox 를 이만큼은 채워야 '직사각형' 으로 본다


def is_red(p):
    return p[0] > 140 and p[1] < 110 and p[2] < 110


def main():
    plan = Image.open(PLAN).convert("RGB")
    W, H = plan.size
    src = Image.open(SRC).convert("RGB")
    if src.size != (W, H):
        sys.exit(f"floorplan-door.png 가 도면과 크기가 다르다: {src.size} vs {(W, H)}")
    sp = src.load()

    red = [[is_red(sp[x, y]) for x in range(W)] for y in range(H)]
    print(f"빨강 {sum(map(sum, red)):,}px")

    seen = [[False] * W for _ in range(H)]
    doors, odd = [], []
    for y0 in range(H):
        for x0 in range(W):
            if not red[y0][x0] or seen[y0][x0]:
                continue
            q = deque([(x0, y0)])
            seen[y0][x0] = True
            px = []
            while q:
                x, y = q.popleft()
                px.append((x, y))
                for dy in (-1, 0, 1):
                    for dx in (-1, 0, 1):
                        nx, ny = x + dx, y + dy
                        if 0 <= nx < W and 0 <= ny < H and red[ny][nx] and not seen[ny][nx]:
                            seen[ny][nx] = True
                            q.append((nx, ny))
            if len(px) < MIN_PX:
                continue
            xs = [p[0] for p in px]
            ys = [p[1] for p in px]
            x1, x2, y1, y2 = min(xs), max(xs), min(ys), max(ys)
            bw, bh = x2 - x1 + 1, y2 - y1 + 1
            fill = len(px) / (bw * bh)
            d = {
                "x": x1, "y": y1, "w": bw, "h": bh,
                "axis": "h" if bw >= bh else "v",
                "widthCm": round(max(bw, bh) * CM_PER_PX, 1),
                "thickCm": round(min(bw, bh) * CM_PER_PX, 1),
                "fill": round(fill, 2),
            }
            # 직사각형이 아니면 문 두 개가 ㄱ자로 붙었거나 삐져나온 것이다
            (doors if fill >= MIN_FILL else odd).append(d)

    doors.sort(key=lambda d: (d["y"], d["x"]))
    for i, d in enumerate(doors, 1):
        print(f"{i:2}. ({d['x']:>4},{d['y']:>4}) {'―' if d['axis']=='h' else '│'} "
              f"폭 {d['widthCm']:>5.0f}cm 두께 {d['thickCm']:>4.0f}cm")
    for d in odd:
        print(f" ⚠️ ({d['x']},{d['y']}) 채움률 {d['fill']} — 직사각형이 아니다 "
              f"(문 둘이 붙었거나 삐져나옴)")

    ws = [d["widthCm"] for d in doors]
    ts = [d["thickCm"] for d in doors]
    print(f"\n문 {len(doors)}개 · 폭 {min(ws):.0f}~{max(ws):.0f}cm · "
          f"두께 {min(ts):.0f}~{max(ts):.0f}cm · 이상한 덩어리 {len(odd)}개")

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"doors": doors, "odd": odd}, f, ensure_ascii=False)
    print(f"saved {OUT}")

    prev = Image.blend(plan, Image.new("RGB", (W, H), (255, 255, 255)), 0.4)
    dr = ImageDraw.Draw(prev, "RGBA")
    for d in doors:
        dr.rectangle((d["x"], d["y"], d["x"] + d["w"] - 1, d["y"] + d["h"] - 1),
                     fill=(30, 90, 235, 220))
    for d in odd:
        dr.rectangle((d["x"], d["y"], d["x"] + d["w"] - 1, d["y"] + d["h"] - 1),
                     fill=(230, 30, 30, 220))
    for i, d in enumerate(doors, 1):
        cx, cy = d["x"] + d["w"] / 2, d["y"] + d["h"] / 2
        dr.ellipse((cx - 16, cy - 16, cx + 16, cy + 16), outline=(0, 40, 170, 255), width=3)
        dr.text((cx - 6, cy - 6), str(i), fill=(0, 30, 130, 255))
    prev.save(PREVIEW)
    print(f"saved {PREVIEW}")


if __name__ == "__main__":
    main()
