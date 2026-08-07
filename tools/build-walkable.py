#!/usr/bin/env python3
"""도면 → 통행가능 격자 (`packages/server/src/config/walkable.json`).

**이 스크립트가 없어서 한 번 고생했다.** 처음 walkable.json 을 만든 코드는 저장소에
남지 않았고, 도면이 바뀌었을 때 추출 방식을 도면에서 거꾸로 재구성해야 했다.
도면을 갈아끼울 때마다 여기를 다시 돌린다.

## 판정 규칙

도면 v2 부터는 **색이 곧 의미**다 — 색칠을 사람이 해서 주기 때문에 굵기 추정이 필요 없다.

    흰색      = 사람이 다닐 수 있는 바닥
    자홍색    = 다닐 수 있지만 **직원 전용** (환자 화면에서 검게 칠하고 안내 경로가 피한다)
    그 외 전부 = 벽 · 통제구역(계단·엘리베이터 샤프트·실외기실) · 건물 밖

옛 도면(v1)은 이렇지 않았다. 벽과 문이 같은 얇은 선으로 그려져 있어 **두께로** 벽을
가려내야 했고, 그 결과 문짝과 문 열림 궤적까지 통행 불가로 잡혀서 아바타가 문간을
못 지나갔다. 색으로 주기로 한 뒤 그 문제가 사라졌다 — 규칙을 도면 쪽으로 옮긴 것이다.

⚠️ 그러므로 도면을 수정할 때 **흰색은 통행 가능이라는 뜻**임을 지켜야 한다. 통행시키고
   싶지 않은 곳(샤프트·기계실·데스크 안쪽)은 회색으로 칠한다. 벽만 그려 두고 안을
   비워 두면 그 안이 통행 가능해진다.

## 셀 크기

셀 4px(약 6.5cm)은 사람 한 명이 서는 자리보다 훨씬 작다. 이보다 키우면 문간 같은
좁은 통로가 격자에서 막혀 버리고, 줄이면 파일이 커지는 대신 얻는 게 없다.

    python tools/build-walkable.py [--dry]
"""
import json
import os
import sys

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CFG = os.path.join(ROOT, "packages", "server", "src", "config")
PLAN = os.path.join(ROOT, "packages", "web-staff", "public", "floorplan.png")
OUT = os.path.join(CFG, "walkable.json")
STAFF_OUT = os.path.join(CFG, "staff-area.json")

CELL = 4          # 격자 셀 한 변 (도면 px). 4px ≈ 6.5cm
WHITE_MIN = 240   # 세 채널 모두 이보다 밝으면 흰색으로 본다 (안티에일리어싱 여유)
# 셀 안 흰색 비율이 이보다 높으면 통행 가능. 0.5 는 "셀 절반 이상이 바닥이면 통과" —
# 벽에 걸친 셀을 막는 쪽으로 기울여야 아바타가 벽을 스치지 않는다.
WHITE_RATIO = 0.5

# 직원 전용 구역 표시색 (도면에 사람이 칠해서 준다).
# **왜 검정이 아닌가**: 이 도면에서 검정은 이미 벽·설비 선이다. 검게 칠하면 통행
# 불가가 되어 직원 좌표까지 벽으로 밀려난다 — 직원은 그 안에서 일해야 한다.
# 건축 도면에 절대 안 나오는 자홍색을 쓴다. 환자 화면에서는 이 구역을 **검게** 칠한다.
STAFF_RGB = (255, 0, 255)
STAFF_TOL = 60


def is_staff(p):
    return all(abs(a - b) <= STAFF_TOL for a, b in zip(p, STAFF_RGB))


def main():
    dry = "--dry" in sys.argv
    if not os.path.exists(PLAN):
        sys.exit(f"도면을 못 찾음: {PLAN}")
    img = Image.open(PLAN).convert("RGB")
    W, H = img.size
    px = img.load()

    meta_path = os.path.join(CFG, "floorplan.json")
    meta = json.load(open(meta_path, encoding="utf-8"))
    if (meta["width"], meta["height"]) != (W, H):
        sys.exit(
            f"도면 크기({W}x{H})와 floorplan.json({meta['width']}x{meta['height']})이 다르다.\n"
            "존·게이트웨이 좌표가 전부 이 좌표계에 박혀 있으므로, 크기가 바뀌었으면\n"
            "floorplan.json 을 고치고 존 앵커부터 다시 뽑아야 한다."
        )

    cols, rows = W // CELL, H // CELL
    grid = []
    sgrid = []
    walk = 0
    for r in range(rows):
        row = []
        srow = []
        for c in range(cols):
            white = 0
            staff = 0
            for y in range(r * CELL, (r + 1) * CELL):
                for x in range(c * CELL, (c + 1) * CELL):
                    p = px[x, y]
                    if min(p) >= WHITE_MIN:
                        white += 1
                    elif is_staff(p):
                        staff += 1
            n = CELL * CELL
            # 직원 전용 색도 '바닥' 이다 — 직원은 그 안에서 일한다. 다만 따로 기록해 둔다
            ok = (white + staff) / n >= WHITE_RATIO
            row.append("1" if ok else "0")
            srow.append("1" if ok and staff / n >= WHITE_RATIO else "0")
            walk += ok
        grid.append("".join(row))
        sgrid.append("".join(srow))

    total = cols * rows
    print(f"격자 {cols}x{rows} (셀 {CELL}px) — 통행가능 {walk:,}셀 = {100 * walk / total:.1f}%")

    # 존 앵커가 전부 통행 가능한 자리인지 확인한다. 앵커가 막힌 셀에 있으면 방 사각형
    # 실측(build-pixel-map)과 길찾기가 그 방을 아예 못 찾는다.
    zones = json.load(open(os.path.join(CFG, "zones.json"), encoding="utf-8"))
    bad = []
    for z in zones:
        x, y = z["tilePosition"]["x"], z["tilePosition"]["y"]
        c, r = int(x // CELL), int(y // CELL)
        if not (0 <= c < cols and 0 <= r < rows and grid[r][c] == "1"):
            bad.append(z["name"])
    if bad:
        print(f"⚠️ 앵커가 막힌 셀에 있는 존 {len(bad)}개: {', '.join(bad)}")
    else:
        print(f"존 {len(zones)}개 앵커 전부 통행 가능한 자리")

    n_staff = sum(row.count("1") for row in sgrid)
    if n_staff:
        print(f"직원 전용 구역: {n_staff:,}셀 = {100 * n_staff / walk:.1f}% (도면의 자홍색)")
    else:
        print("직원 전용 구역: 없음 (도면에 자홍색으로 칠하면 잡힌다)")

    if dry:
        print("--dry — 파일 안 씀")
        return
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"cell": CELL, "cols": cols, "rows": rows, "grid": grid}, f)
    print(f"saved {OUT}")
    with open(STAFF_OUT, "w", encoding="utf-8") as f:
        json.dump({"cell": CELL, "cols": cols, "rows": rows, "grid": sgrid}, f)
    print(f"saved {STAFF_OUT}")


if __name__ == "__main__":
    main()
