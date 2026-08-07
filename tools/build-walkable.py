#!/usr/bin/env python3
"""도면 → 통행가능 격자 (`packages/server/src/config/walkable.json`).

**이 스크립트가 없어서 한 번 고생했다.** 처음 walkable.json 을 만든 코드는 저장소에
남지 않았고, 도면이 바뀌었을 때 추출 방식을 도면에서 거꾸로 재구성해야 했다.
도면을 갈아끼울 때마다 여기를 다시 돌린다.

## 판정 규칙

도면 v2 부터는 **색이 곧 의미**다 — 색칠을 사람이 해서 주기 때문에 굵기 추정이 필요 없다.

    흰색      = 사람이 다닐 수 있는 바닥
    그 외 전부 = 벽 · 통제구역(계단·엘리베이터 샤프트·실외기실) · 건물 밖

손님 통제구역(직원 전용)은 여기서 다루지 않는다 — 도면을 훼손하지 않으려고 마스크를
따로 둔다. `tools/build-staff-areas.py` 참고.

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
OVER_PNG = os.path.join(ROOT, "packages", "web-patient", "public", "pixelmap-over.png")
FLOOR_OUT = os.path.join(CFG, "floor.json")

CELL = 4          # 격자 셀 한 변 (도면 px). 4px ≈ 6.5cm
WHITE_MIN = 240   # 세 채널 모두 이보다 밝으면 흰색으로 본다 (안티에일리어싱 여유)
# 셀 안 흰색 비율이 이보다 높으면 통행 가능. 0.5 는 "셀 절반 이상이 바닥이면 통과" —
# 벽에 걸친 셀을 막는 쪽으로 기울여야 아바타가 벽을 스치지 않는다.
WHITE_RATIO = 0.5

# 벽면 층에서 이보다 진한 픽셀이 덮은 자리는 '그림상 벽' 으로 본다
FACE_ALPHA_MIN = 40
# 기준점이 막혔을 때 되살릴 둘레 (칸)
ANCHOR_KEEP = 4



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
    walk = 0
    for r in range(rows):
        row = []
        for c in range(cols):
            white = 0
            for y in range(r * CELL, (r + 1) * CELL):
                for x in range(c * CELL, (c + 1) * CELL):
                    if min(px[x, y]) >= WHITE_MIN:
                        white += 1
            ok = white / (CELL * CELL) >= WHITE_RATIO
            row.append("1" if ok else "0")
            walk += ok
        grid.append("".join(row))

    # **바닥이 있는 곳** — 그리기용. 아래에서 빼는 것들이 반영되지 않은 원본이다.
    # 도트맵은 이걸 읽어야 한다. 줄어든 격자를 읽으면 벽면을 덜 그리고, 그걸 다시
    # 빼면 또 줄어든다 — 돌릴 때마다 값이 달라진다(실제로 그랬다).
    raw = list(grid)
    with open(FLOOR_OUT, "w", encoding="utf-8") as f:
        json.dump({"cell": CELL, "cols": cols, "rows": rows, "grid": raw}, f)
    zones = json.load(open(os.path.join(CFG, "zones.json"), encoding="utf-8"))

    # ── 2.5D 벽면이 덮는 띠를 뺀다 ──────────────────────────────────────────
    #
    # 환자용 화면은 2.5D 다 — 벽·안내데스크 발치에서 **남쪽으로** 높이가 그려진다.
    # 도면상 그 띠도 흰 바닥이라 사람이 그 위에 선다. 화면에서는 **안내데스크 파티션
    # 위에 올라탄 것**으로 보인다. 카운터의 옆면 안에 서 있는 셈이니 막는 게 맞다.
    #
    # 띠를 여기서 다시 계산하지 않고 도트맵이 만든 층(pixelmap-over.png)을 그대로 쓴다.
    # 벽 판정 방식(회색조 임계값)이 달라서 다시 계산하면 5배쯤 과하게 잘렸다.
    #
    # ⚠️ 그 층은 이 파일을 입력으로 만들어진다 — 그래서 **두 번 돌린다**:
    #     build-walkable.py → build-pixel-map.py → build-walkable.py --faces → build-pixel-map.py
    if os.path.exists(OVER_PNG):
        over = Image.open(OVER_PNG).convert("RGBA")
        op = over.load()
        OW, OH = over.size
        scale = OW / W  # 도면 → 도트맵 배율 (MAP_SCALE)
        cut = 0
        for r in range(rows):
            row = list(grid[r])
            for c in range(cols):
                if row[c] != "1":
                    continue
                x0, y0 = int(c * CELL * scale), int(r * CELL * scale)
                x1, y1 = max(x0 + 1, int((c + 1) * CELL * scale)), max(y0 + 1, int((r + 1) * CELL * scale))
                hit = tot = 0
                for y in range(y0, y1):
                    for x in range(x0, x1):
                        if 0 <= x < OW and 0 <= y < OH:
                            tot += 1
                            hit += op[x, y][3] > FACE_ALPHA_MIN
                if tot and hit / tot >= 0.5:
                    row[c] = "0"
                    cut += 1
            grid[r] = "".join(row)
        walk -= cut
        print(f"2.5D 벽면이 덮는 띠로 뺀 셀: {cut:,}")

        # 작은 방은 벽면 띠가 방을 통째로 덮는다 — 기준점 둘레를 되살린다
        saved = []
        for z in zones:
            gc, gr = int(z["tilePosition"]["x"] // CELL), int(z["tilePosition"]["y"] // CELL)
            if not (0 <= gc < cols and 0 <= gr < rows) or grid[gr][gc] == "1":
                continue
            saved.append(z["name"])
            for dr in range(-ANCHOR_KEEP, ANCHOR_KEEP + 1):
                rr = gr + dr
                if not (0 <= rr < rows):
                    continue
                row = list(grid[rr])
                for dc in range(-ANCHOR_KEEP, ANCHOR_KEEP + 1):
                    cc = gc + dc
                    if 0 <= cc < cols and raw[rr][cc] == "1" and row[cc] == "0":
                        row[cc] = "1"
                        walk += 1
                grid[rr] = "".join(row)
        if saved:
            print(f"기준점이 막혀 되살린 방 {len(saved)}개: {', '.join(saved)}")

    # 못 서는 자리(안내데스크 안쪽·파티션·붙박이 가구)를 뺀다.
    # 도면에는 흰 바닥으로 그려져 있어서 여기서 빼지 않으면 사람이 그 위에 선다.
    # 표시는 사람이 한다 — config/staff-area.png 에 청록색 (build-staff-areas.py)
    blocked_path = os.path.join(CFG, "blocked-area.json")
    if os.path.exists(blocked_path):
        bm = json.load(open(blocked_path, encoding="utf-8"))
        if (bm["cols"], bm["rows"], bm["cell"]) == (cols, rows, CELL):
            cut = 0
            for r in range(rows):
                if "1" not in bm["grid"][r]:
                    continue
                row = list(grid[r])
                for c in range(cols):
                    if bm["grid"][r][c] == "1" and row[c] == "1":
                        row[c] = "0"
                        cut += 1
                grid[r] = "".join(row)
            walk -= cut
            if cut:
                print(f"못 서는 자리로 뺀 셀: {cut:,}")
        else:
            print("⚠️ blocked-area.json 격자 크기가 안 맞는다 — 무시함")

    total = cols * rows
    print(f"격자 {cols}x{rows} (셀 {CELL}px) — 통행가능 {walk:,}셀 = {100 * walk / total:.1f}%")

    # 존 앵커가 전부 통행 가능한 자리인지 확인한다. 앵커가 막힌 셀에 있으면 방 사각형
    # 실측(build-pixel-map)과 길찾기가 그 방을 아예 못 찾는다.
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

    if dry:
        print("--dry — 파일 안 씀")
        return
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"cell": CELL, "cols": cols, "rows": rows, "grid": grid}, f)
    print(f"saved {OUT}")
    print(f"saved {FLOOR_OUT} (그리기용 바닥)")


if __name__ == "__main__":
    main()
