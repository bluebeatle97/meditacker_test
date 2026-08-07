#!/usr/bin/env python3
"""사람이 설 수 없는 자리 마스크 (안내데스크 파티션).

    python tools/build-blocked-areas.py

입력:  packages/server/src/config/{walkable,zones}.json
출력:  packages/server/src/config/blocked-area.json

## 무엇을 막는가

환자용 화면은 2.5D 라, 안내데스크 카운터 **발치에서 남쪽으로** 파티션 옆면이 그려진다.
도면상 그 띠는 흰 바닥이라 사람이 그 위에 선다 — 화면에서는 파티션 위에 올라탄 것으로
보인다. 그 띠만 막는다.

## 왜 벽 전체가 아닌가

한 번 벽이란 벽의 아래를 다 막아 봤다. 통행 가능 면적이 14% 줄고 캐릭터가 벽에 박혀
보였다 — 벽 앞 20cm 에 서는 것 자체는 정상이다. 문제는 **카운터 옆면**이지 벽이 아니다.
그래서 접수데스크 둘레의 **독립 구조물**(건물 벽과 떨어진 덩어리)만 대상으로 한다.
"""
import json
import os
from collections import deque

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CFG = os.path.join(ROOT, "packages", "server", "src", "config")
OUT = os.path.join(CFG, "blocked-area.json")

# 파티션 옆면의 높이 (격자 칸). 도트맵의 FACE_H+걸레받이(출력 15px = 도면 30px) 에 맞춘 값
FACE_CELLS = 7
# 이 존 둘레의 구조물만 본다
DESK_ZONE = "reception"
# 앵커에서 이 거리 안쪽만 (도면 px). 카운터가 옆 벽에 붙어 한 덩어리로 잡히므로 필요하다
NEAR_PX = 210
# 이보다 작은 덩어리는 기둥·문틀 같은 것 — 파티션이 아니다
MIN_CELLS = 100


def main():
    w = json.load(open(os.path.join(CFG, "walkable.json"), encoding="utf-8"))
    zones = json.load(open(os.path.join(CFG, "zones.json"), encoding="utf-8"))
    cell, cols, rows = w["cell"], w["cols"], w["rows"]
    g = w["grid"]
    desk = next(z for z in zones if z["zoneId"] == DESK_ZONE)
    ax, ay = desk["tilePosition"]["x"], desk["tilePosition"]["y"]

    # 막힌 칸을 덩어리로 나눈다. 가장 큰 것이 건물 벽 — 그건 제외한다
    seen = [[False] * cols for _ in range(rows)]
    comps = []
    for gy in range(rows):
        for gx in range(cols):
            if g[gy][gx] == "1" or seen[gy][gx]:
                continue
            q = deque([(gx, gy)])
            seen[gy][gx] = True
            cs = []
            while q:
                x, y = q.popleft()
                cs.append((x, y))
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)):
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < cols and 0 <= ny < rows and not seen[ny][nx] and g[ny][nx] == "0":
                        seen[ny][nx] = True
                        q.append((nx, ny))
            comps.append(cs)
    comps.sort(key=len, reverse=True)

    near = lambda cs: min(abs(x * cell - ax) + abs(y * cell - ay) for x, y in cs)
    islands = [c for c in comps[1:] if len(c) >= MIN_CELLS and near(c) <= NEAR_PX]
    print(f"안내데스크 구조물 {len(islands)}개: " + ", ".join(f"{len(c)}칸" for c in islands))

    anchors = {
        (int(z["tilePosition"]["x"] // cell), int(z["tilePosition"]["y"] // cell)) for z in zones
    }
    cut = set()
    for c in islands:
        s = set(c)
        for x, y in c:
            if (x, y + 1) in s:
                continue  # 구조물 안쪽 — 아래로 더 이어진다
            for k in range(1, FACE_CELLS + 1):
                yy = y + k
                # 도면상 벽이거나, 데스크에서 너무 멀거나, 존 기준점이면 멈춘다
                if yy >= rows or g[yy][x] == "0":
                    break
                if abs(x * cell - ax) + abs(yy * cell - ay) > NEAR_PX:
                    break
                if (x, yy) in anchors:
                    break
                cut.add((x, yy))

    total = sum(r.count("1") for r in g)
    print(f"막을 칸 {len(cut):,} = 통행 가능의 {100 * len(cut) / total:.2f}%")
    grid = ["".join("1" if (c, r) in cut else "0" for c in range(cols)) for r in range(rows)]
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"cell": cell, "cols": cols, "rows": rows, "grid": grid}, f)
    print(f"saved {OUT}")


if __name__ == "__main__":
    main()
