#!/usr/bin/env python3
"""디자이너용 방 배치 판 — 6F 도면 전체를 타일 격자로 깐 한 장 (`docs/room-design-board.png`).

## 이 판이 하는 일

디자이너가 층 전체 공간 구성을 한눈에 보고, **칸마다 타일·가구를 끼워 넣는 퍼즐**처럼
작업하게 한다. 벽이 어디인지, 문이 어디인지, 어느 칸이 어느 방인지는 **여기서 이미 다
정해서** 준다 — 디자이너는 채우기만 한다.

## 벽/바닥 판정 (C안)

판에서는 칸 하나가 벽 아니면 바닥으로 **딱 떨어진다**. 도면의 벽은 격자와 무관한 위치에
있어서 칸을 반씩 가로지르는데(층 전체 2,600칸 중 608칸), 그걸 다수결로 한쪽에 밀어
붙였다. 그래서 판은 퍼즐이 되고, **최종 렌더링은 도면의 실제 벽 위치를 쓴다** — 판과
결과가 반 칸(26cm) 정도 다를 수 있다. 정합은 렌더링 쪽에서 지킨다.

## 방 구역은 도트맵과 같은 함수로 나눈다

`build-pixel-map.segment_rooms` 를 그대로 불러 쓴다. 판과 실제 도트맵이 다른 방식으로
방을 나누면, 디자이너가 "이 칸은 상담실" 이라고 채운 게 렌더링에서 복도가 된다.

    python tools/build-design-board.py
"""
import importlib.util
import json
import os
from collections import deque

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CFG = os.path.join(ROOT, "packages", "server", "src", "config")
OUT = os.path.join(ROOT, "docs", "room-design-board.png")

# 도트맵 생성기에서 방 구역 나누기를 그대로 가져온다 (파일명에 하이픈이 있어 일반 import 불가)
_spec = importlib.util.spec_from_file_location(
    "build_pixel_map", os.path.join(ROOT, "tools", "build-pixel-map.py")
)
_bpm = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_bpm)

TILE_FP = _bpm.TILE_FP          # 타일 한 변 = 도면 32px = 52cm
CM_PER_PX = _bpm.CM_PER_PX
Z = 3                           # 판에서 타일 한 변 = 16 * Z px
TPX = 16 * Z
RUL = 44                        # 자 폭
HEAD = 172
FOOT = 250
WALL_REACH = _bpm.WALL_REACH    # 막힌 셀이 이 거리 안에 바닥이 있으면 '벽', 없으면 통제구역

# 방 type → 판에서 쓸 연한 색. 인쇄해도 글씨가 읽히게 전부 밝게 둔다.
TINT = {
    "surgery": (206, 236, 232),
    "laser": (206, 236, 232),
    "consult": (247, 238, 205),
    "recovery": (247, 238, 205),
    "skincare": (247, 238, 205),
    "waiting": (241, 224, 200),
    "reception": (241, 224, 200),
    "etc": (231, 234, 238),
    "staff": (216, 224, 236),
}
CORRIDOR_TINT = (250, 250, 250)
WALL_RGB = (46, 51, 68)
VOID_RGB = (108, 114, 128)
DOOR_RGB = (250, 204, 21)
GRID = (176, 184, 196)
GRID4 = (128, 138, 154)
ROOM_EDGE = (70, 78, 96)
INK = (24, 28, 40)
DIM = (108, 116, 132)


def font(sz, bold=False):
    return ImageFont.truetype(r"C:\Windows\Fonts\malgun%s.ttf" % ("bd" if bold else ""), sz)


def _crossable(walk, tx, ty, nx, ny, per):
    """칸 A 에서 칸 B 로, **두 칸 밖으로 나가지 않고** 걸어갈 수 있나.

    이게 "두 칸 사이에 벽이 있나" 의 정확한 질문이다. 벽이 칸 경계에 딱 놓여 있지 않아도
    (도면 벽은 격자와 무관한 위치다) 막힌 걸 잡아낸다.
    """
    r0, c0 = min(ty, ny) * per, min(tx, nx) * per
    r1 = r0 + per * (2 if ny != ty else 1)
    c1 = c0 + per * (2 if nx != tx else 1)
    start = [(r, c) for r in range(ty * per, ty * per + per)
             for c in range(tx * per, tx * per + per)
             if 0 <= r < walk.rows and 0 <= c < walk.cols and walk.grid[r][c] == "1"]
    if not start:
        return False
    goal = {(r, c) for r in range(ny * per, ny * per + per)
            for c in range(nx * per, nx * per + per)
            if 0 <= r < walk.rows and 0 <= c < walk.cols and walk.grid[r][c] == "1"}
    if not goal:
        return False
    seen = set(start)
    q = deque(start)
    while q:
        r, c = q.popleft()
        if (r, c) in goal:
            return True
        for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            rr, cc = r + dr, c + dc
            if (r0 <= rr < r1 and c0 <= cc < c1 and (rr, cc) not in seen
                    and 0 <= rr < walk.rows and 0 <= cc < walk.cols
                    and walk.grid[rr][cc] == "1"):
                seen.add((rr, cc))
                q.append((rr, cc))
    return False


def main():
    plan = json.load(open(os.path.join(CFG, "floorplan.json"), encoding="utf-8"))
    zones = json.load(open(os.path.join(CFG, "zones.json"), encoding="utf-8"))
    walk = _bpm.Walk(json.load(open(os.path.join(CFG, "walkable.json"), encoding="utf-8")))
    detail = {}
    owner = _bpm.segment_rooms(walk, zones, detail)
    core = detail["core"]
    clearance = detail["clearance"]

    tw = -(-plan["width"] // TILE_FP)
    th = -(-plan["height"] // TILE_FP)
    per = TILE_FP // walk.cell           # 타일 안의 격자 셀 수 (8)

    # ── 막힌 셀이 '벽' 인지 '통제구역/건물 밖' 인지 ─────────────────────────
    # 벽은 바닥에 붙어 있고, 통제구역·건물 밖은 바닥에서 멀다. 도트맵의 void 판정과 같은 규칙.
    inside = [[False] * walk.cols for _ in range(walk.rows)]
    for r in range(walk.rows):
        for c in range(walk.cols):
            if walk.grid[r][c] == "1":
                continue
            for dr in range(-WALL_REACH, WALL_REACH + 1):
                rr = r + dr
                if not (0 <= rr < walk.rows):
                    continue
                row = walk.grid[rr]
                lo = max(0, c - WALL_REACH)
                hi = min(walk.cols, c + WALL_REACH + 1)
                if "1" in row[lo:hi]:
                    inside[r][c] = True
                    break

    # ── 타일별 판정 (C안: 다수결로 한쪽에 밀어붙인다) ────────────────────────
    KIND_FLOOR, KIND_WALL, KIND_VOID = 0, 1, 2
    kind = [[KIND_VOID] * tw for _ in range(th)]
    own = [[None] * tw for _ in range(th)]
    mixed = 0
    for ty in range(th):
        for tx in range(tw):
            votes = {}
            walkn = wall = void = 0
            for dr in range(per):
                for dc in range(per):
                    r, c = ty * per + dr, tx * per + dc
                    if not (0 <= r < walk.rows and 0 <= c < walk.cols):
                        continue
                    if walk.grid[r][c] == "1":
                        walkn += 1
                        o = owner[r][c]
                        votes[o] = votes.get(o, 0) + 1
                    elif inside[r][c]:
                        wall += 1
                    else:
                        void += 1
            n = walkn + wall + void
            if n == 0:
                continue
            if walkn and (wall or void):
                mixed += 1
            if walkn / n >= 0.5:
                kind[ty][tx] = KIND_FLOOR
                own[ty][tx] = max(votes.items(), key=lambda kv: kv[1])[0] if votes else -1
            else:
                kind[ty][tx] = KIND_WALL if wall >= void else KIND_VOID
    print(f"칸 {tw}x{th} = {tw * th:,}  ·  벽이 지나가는 칸 {mixed:,}개는 바닥으로 두고 "
          f"벽은 칸 경계로 옮김 (C안)")

    # ── 벽은 칸이 아니라 **칸 사이 선**이다 ─────────────────────────────────
    # 한 칸이 52cm, 가벽이 19cm 다. 벽이 칸을 지나가도 그 칸의 63%는 바닥이라 다수결로는
    # 절대 '벽 칸'이 안 된다 — 그렇게 뽑아 보니 판에서 벽이 거의 사라졌다. 벽은 칸 경계에
    # 그리는 게 맞고, 그러면 방 크기도 도면 그대로 유지된다 (3칸 방이 3칸으로 남는다).
    # 두꺼운 외벽·기둥처럼 칸을 통째로 먹는 것만 '벽 칸'으로 남는다.
    #
    # ⚠️ "두 칸 사이에 벽이 있나" 를 픽셀로 판정하려는 시도는 두 번 실패했다. 경계의 셀
    #    두 줄만 보면 벽이 칸 가운데를 지날 때 놓치고, 두 칸 안에서의 연결성을 보면 벽이
    #    칸을 반으로 가를 때 그 칸의 저쪽 절반을 통해 이어져 버린다. 26cm 모호함이라
    #    픽셀로는 못 푼다. 그래서 **의미로** 판정한다 — 방이 다르면 사이에 벽이 있다.
    edges = set()
    for ty in range(th):
        for tx in range(tw):
            if kind[ty][tx] != KIND_FLOOR:
                continue
            for dx, dy, side in ((1, 0, "r"), (0, 1, "b")):
                nx, ny = tx + dx, ty + dy
                if not (0 <= nx < tw and 0 <= ny < th) or kind[ny][nx] != KIND_FLOOR:
                    continue
                if own[ty][tx] != own[ny][nx]:
                    edges.add((tx, ty, side))

    # ── 문간 — 깎여 나간 띠 중 서로 다른 방을 잇는 셀 ────────────────────────
    # 조각(core)은 문 폭보다 크게 깎아 만든 것이라, 문은 조각들 **사이**에 남는다.
    door_tile = [[0] * tw for _ in range(th)]
    # 문은 **좁다**. 이 조건이 없으면 대기공간처럼 벽 없이 열린 경계까지 전부 문간으로
    # 찍힌다(273칸이 나왔다) — 사람이 지나가는 건 맞지만 문은 아니고, 판이 노랗게 뒤덮인다.
    # 문 90cm 의 중앙에서 벽까지는 45cm 이므로, 여유를 두고 60cm 를 상한으로 잡는다.
    door_clear = int(60 / (walk.cell * CM_PER_PX)) * 10
    for r in range(walk.rows):
        for c in range(walk.cols):
            if walk.grid[r][c] != "1" or core[r][c] >= 0:
                continue
            if clearance[r][c] > door_clear:
                continue
            # ⚠️ 사각형 이웃(±2셀 = ±13cm)으로 훑으면 안 된다 — 가벽이 19cm 라서 벽 반대편
            #    칸까지 보이고, 그러면 방 경계 전체가 문간으로 찍힌다(276칸이 나왔다).
            #    **바닥을 타고만** 퍼져야 벽을 넘지 않는다.
            around = set()
            seen_local = {(r, c)}
            frontier = [(r, c, 0)]
            while frontier:
                fr, fc, dep = frontier.pop()
                o = owner[fr][fc]
                if o is not None:
                    around.add(o)
                if dep >= 4:
                    continue
                for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    rr, cc = fr + dr, fc + dc
                    if (0 <= rr < walk.rows and 0 <= cc < walk.cols
                            and walk.grid[rr][cc] == "1" and (rr, cc) not in seen_local):
                        seen_local.add((rr, cc))
                        frontier.append((rr, cc, dep + 1))
            if len(around) >= 2:
                door_tile[r // per][c // per] += 1
    doors = sum(1 for row in door_tile for v in row if v >= 4)
    print(f"칸 사이 벽 {len(edges):,}개 · 문간 칸 {doors}개")

    # ── 그리기 ──────────────────────────────────────────────────────────────
    BW, BH = tw * TPX, th * TPX
    W, H = BW + RUL + 40, BH + RUL + HEAD + FOOT
    img = Image.new("RGB", (W, H), (255, 255, 255))
    d = ImageDraw.Draw(img)
    ox, oy = RUL + 20, HEAD + RUL

    def tint_of(ty, tx):
        o = own[ty][tx]
        if o is None or o < 0:
            return CORRIDOR_TINT
        z = zones[o]
        return TINT.get("staff" if z["category"] == "staff_area" else z["type"], TINT["etc"])

    for ty in range(th):
        for tx in range(tw):
            x0, y0 = ox + tx * TPX, oy + ty * TPX
            x1, y1 = x0 + TPX - 1, y0 + TPX - 1
            kd = kind[ty][tx]
            if kd == KIND_FLOOR:
                d.rectangle([x0, y0, x1, y1], fill=tint_of(ty, tx))
            elif kd == KIND_WALL:
                d.rectangle([x0, y0, x1, y1], fill=WALL_RGB)
            else:
                d.rectangle([x0, y0, x1, y1], fill=VOID_RGB)
                for i in range(-TPX, TPX, 9):   # 통제구역은 사선으로 한 번 더 표시
                    d.line([(x0 + i, y1), (x0 + i + TPX, y0)], fill=(88, 94, 108), width=1)

    # 벽·문을 칸 경계에 그린다 (격자선보다 굵게 — 이게 판의 뼈대다).
    # 문은 벽선의 **끊긴 자리**로 보여야 도면처럼 읽힌다 — 칸을 노랗게 칠하면 열린 경계가
    # 많은 이 층에서는 판이 노랗게 뒤덮인다(273칸이 그랬다).
    for tx, ty, side in edges:
        x0, y0 = ox + tx * TPX, oy + ty * TPX
        nx, ny = (tx + 1, ty) if side == "r" else (tx, ty + 1)
        if side == "r":
            a, b = (x0 + TPX, y0), (x0 + TPX, y0 + TPX)
        else:
            a, b = (x0, y0 + TPX), (x0 + TPX, y0 + TPX)
        opening = door_tile[ty][tx] >= 4 or door_tile[ny][nx] >= 4
        d.line([a, b], fill=DOOR_RGB if opening else WALL_RGB, width=7)

    # 격자 + 자
    for tx in range(tw + 1):
        x = ox + tx * TPX
        d.line([(x, oy), (x, oy + BH)], fill=GRID4 if tx % 4 == 0 else GRID,
               width=2 if tx % 4 == 0 else 1)
    for ty in range(th + 1):
        y = oy + ty * TPX
        d.line([(ox, y), (ox + BW, y)], fill=GRID4 if ty % 4 == 0 else GRID,
               width=2 if ty % 4 == 0 else 1)
    fr = font(15, True)
    for tx in range(tw):
        d.text((ox + tx * TPX + TPX // 2 - 8, oy - 24), str(tx), font=fr, fill=DIM)
    for ty in range(th):
        d.text((ox - 30, oy + ty * TPX + TPX // 2 - 10), str(ty), font=fr, fill=DIM)

    # 방 이름 — 앵커 자리에, 칸 크기와 함께
    seen = {}
    for i, z in enumerate(zones):
        cnt = sum(1 for ty in range(th) for tx in range(tw) if own[ty][tx] == i)
        seen[i] = cnt
    fn = font(17, True)
    fs = font(14)
    for i, z in enumerate(zones):
        ax = int(z["tilePosition"]["x"] // TILE_FP)
        ay = int(z["tilePosition"]["y"] // TILE_FP)
        px, py = ox + ax * TPX + TPX // 2, oy + ay * TPX + TPX // 2
        label = z["name"]
        sub = f"{seen[i]}칸"
        d.text((px, py - 12), label, font=fn, fill=INK, anchor="mm",
               stroke_width=4, stroke_fill=(255, 255, 255))
        d.text((px, py + 8), sub, font=fs, fill=DIM, anchor="mm",
               stroke_width=4, stroke_fill=(255, 255, 255))

    # ── 머리글 ──────────────────────────────────────────────────────────────
    d.text((RUL + 20, 26), "고트의원 6F — 방 배치 판", font=font(40, True), fill=INK)
    d.text((RUL + 20, 78),
           f"{tw} x {th} 칸 = {tw * th:,}칸  ·  한 칸 = 16px = 52cm  ·  "
           f"층 전체 {plan['width'] * CM_PER_PX / 100:.1f}m x {plan['height'] * CM_PER_PX / 100:.1f}m",
           font=font(19), fill=DIM)
    d.text((RUL + 20, 110),
           "벽·문·방 구분은 이미 정해져 있습니다. 흰 바탕 칸에 바닥 타일과 가구를 채워 주세요 — "
           "칸 주소는 위쪽/왼쪽 자의 숫자입니다 (예: 12,7).",
           font=font(20, True), fill=(22, 101, 132))

    # ── 범례 ────────────────────────────────────────────────────────────────
    ly = oy + BH + 34
    items = [
        (WALL_RGB, "벽 (칸 사이 굵은 선)", "가벽이 19cm, 한 칸이 52cm 라 칸이 아니라 경계에 그립니다"),
        (VOID_RGB, "통제구역 · 건물 밖", "비콘이 못 가는 곳 (계단·엘리베이터 샤프트·실외기실). 채우지 않습니다"),
        (DOOR_RGB, "문간 (노란 선)", "사람이 지나갑니다 — 가구로 막지 마세요"),
        (TINT["surgery"], "시술·수술·레이저실", ""),
        (TINT["consult"], "상담·회복·피부관리실", ""),
        (TINT["waiting"], "대기공간·접수", ""),
        (TINT["staff"], "직원 구역", "환자 화면에서는 안 보이지만 비콘은 갑니다"),
        (CORRIDOR_TINT, "복도", "어느 방에도 안 들어가는 바닥"),
    ]
    for i, (col, name, note) in enumerate(items):
        cx = RUL + 20 + (i % 2) * (BW // 2)
        cy = ly + (i // 2) * 34
        d.rectangle([cx, cy + 4, cx + 30, cy + 26], fill=col, outline=ROOM_EDGE)
        d.text((cx + 42, cy + 2), name, font=font(19, True), fill=INK)
        if note:
            d.text((cx + 300, cy + 4), note, font=font(16), fill=DIM)
    d.text((RUL + 20, ly + 4 * 34 + 12),
           "굵은 격자 = 4칸 = 2.08m  ·  방 이름 아래 숫자는 그 방이 차지하는 칸 수  ·  "
           "이 판은 tools/build-design-board.py 로 다시 뽑습니다 (도면이 바뀌면 재생성)",
           font=font(16), fill=DIM)

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    img.save(OUT, optimize=True)
    print(f"saved {OUT}  {img.size}  ({os.path.getsize(OUT) / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
