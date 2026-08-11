#!/usr/bin/env python3
"""방 분할 + 복도 마스크 — 문을 막고 갈라 보면 방이 나온다.

    python tools/build-rooms.py

입력:  packages/server/src/config/{walkable,door,zones}.json
출력:  packages/server/src/config/rooms.json      조각마다 어떤 방인지
       packages/server/src/config/corridor.json   복도 칸 마스크 (경로탐색이 쓴다)
       packages/server/src/config/room-preview.png

## 왜 이제야 되는가

방 분할은 예전에 두 번 실패했다 — v2 도면에 **문이 안 그려져 있어서** 방이 문간으로
새어 복도까지 한 덩어리가 됐다(README 「왜 벽을 손으로 그리나」 참고).

이제 문 위치를 안다(`build-doors.py`). 문을 막고 flood fill 하면 조각이 나고,
**존 앵커가 든 조각 = 그 방, 앵커 없는 조각 = 복도**다. 문 하나가 방 분할의 열쇠였다.

## 복도를 어디에 쓰나

경로탐색이 **웬만하면 복도로 다니게** 하는 데 쓴다. 목적지도 아닌 남의 방을 가로질러
가는 그림이 이상해서다. 막지 않고 비용만 올린다 — 유일한 길이면 그래도 지나간다.

## 뭉치는 방이 있다면

`wall.png` 에 그 방들 사이 벽이 덜 그려진 것이다. 여기서 이름을 찍어 주니 그걸 보고
그림을 고치면 된다. (대기공간끼리 트여 있는 것은 정상이다.)
"""
import json
import os
from collections import deque

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CFG = os.path.join(ROOT, "packages", "server", "src", "config")
PLAN = os.path.join(ROOT, "packages", "web-staff", "public", "floorplan.png")
ROOMS_OUT = os.path.join(CFG, "rooms.json")
CORR_OUT = os.path.join(CFG, "corridor.json")
PREVIEW = os.path.join(CFG, "room-preview.png")

CM_PER_PX = 1.62


def main():
    w = json.load(open(os.path.join(CFG, "walkable.json"), encoding="utf-8"))
    dj = json.load(open(os.path.join(CFG, "door.json"), encoding="utf-8"))
    zones = json.load(open(os.path.join(CFG, "zones.json"), encoding="utf-8"))
    C, COLS, ROWS = w["cell"], w["cols"], w["rows"]
    walk = [[w["grid"][r][c] == "1" for c in range(COLS)] for r in range(ROWS)]

    # 문이 걸치는 칸을 막는다 (4px 칸이라 실제 문보다 조금 넓게 막힌다 — 분할용이라 괜찮다)
    door_cell = [[False] * COLS for _ in range(ROWS)]
    for d in dj["doors"]:
        for y in range(d["y"], d["y"] + d["h"]):
            for x in range(d["x"], d["x"] + d["w"]):
                r, c = y // C, x // C
                if 0 <= r < ROWS and 0 <= c < COLS:
                    door_cell[r][c] = True

    comp = [[-1] * COLS for _ in range(ROWS)]
    sizes = []
    for r0 in range(ROWS):
        for c0 in range(COLS):
            if not walk[r0][c0] or door_cell[r0][c0] or comp[r0][c0] != -1:
                continue
            i = len(sizes)
            q = deque([(r0, c0)])
            comp[r0][c0] = i
            n = 0
            while q:
                r, c = q.popleft()
                n += 1
                for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nr, nc = r + dr, c + dc
                    if 0 <= nr < ROWS and 0 <= nc < COLS and walk[nr][nc] \
                            and not door_cell[nr][nc] and comp[nr][nc] == -1:
                        comp[nr][nc] = i
                        q.append((nr, nc))
            sizes.append(n)

    zone_of = {}
    kinds_of = {}
    for z in zones:
        r, c = int(z["tilePosition"]["y"] // C), int(z["tilePosition"]["x"] // C)
        if 0 <= r < ROWS and 0 <= c < COLS and comp[r][c] != -1:
            zone_of.setdefault(comp[r][c], []).append(z["name"])
            kinds_of.setdefault(comp[r][c], []).append((z["type"], z["category"]))

    # ── 통행 공간인가 ──────────────────────────────────────────────────────
    # **대기공간·접수데스크·ELEV.홀 이 든 조각만** 통행 공간이다. 이 층에서는 복도가
    # 그 홀과 트여 있어 한 덩어리로 잡힌다.
    #
    # ⚠️ "앵커 없는 조각 = 복도" 를 넣었다가 뺐다. 앵커가 없는 건 이름을 안 붙인
    #    방이지 복도가 아니다 — 그렇게 잡으니 문 뒤 막다른 공간 4조각(3,798칸)이
    #    복도가 되어 안내 경로가 그리로 들어갔다. 이름이 없다고 지나다니는 곳은 아니다.
    OPEN = {"waiting", "reception"}

    def is_open(i):
        ks = kinds_of.get(i)
        if not ks:
            return False
        return any(t in OPEN or (t == "etc" and cat == "common") for t, cat in ks)

    corridor = {i for i in range(len(sizes)) if is_open(i)}
    rooms = {i: n for i, n in zone_of.items() if i not in corridor}

    unnamed = len(sizes) - len(rooms) - len(corridor)
    print(f"조각 {len(sizes)}개 — 방 {len(rooms)}개(+이름 없는 방 {unnamed}개) · "
          f"통행 공간 {len(corridor)}개\n")
    merged = []
    for i, names in sorted(rooms.items(), key=lambda t: -sizes[t[0]]):
        tag = ""
        if len(names) > 1:
            merged.append(names)
            tag = "   ⚠️ 여러 방이 한 덩어리 — wall.png 에 벽이 빠졌다"
        print(f"  {sizes[i]:>6,}칸  {' / '.join(names)}{tag}")
    for i in sorted(corridor, key=lambda i: -sizes[i]):
        who = " / ".join(zone_of[i]) if i in zone_of else "복도"
        print(f"  {sizes[i]:>6,}칸  [통행] {who}")

    # ── 손님끼리 서로 안 보이는 방 ─────────────────────────────────────────
    # 진료 관련 방(patient_area) + 화장실 + 체인징룸. shared 의 isPrivateRoom 과 같은 규칙.
    #
    # **왜 좌표로 내나.** 서버가 존 판정으로 걸렀더니 복도에 선 사람이 21.9% 나 숨었다 —
    # 복도엔 게이트웨이가 없어 존 판정이 "제일 가까운 방" 을 찍고, 그걸 걸러 주기로 한
    # inTransit 은 6.4% 밖에 안 떴다. 좌표가 어느 방 안인지는 추측할 것이 없다.
    def is_private(z):
        return z["category"] == "patient_area" or z["type"] in ("toilet", "changing")

    zmap = {z["name"]: z for z in zones}
    private = {i for i in range(len(sizes))
               if i not in corridor
               and (i not in zone_of                       # 이름 없는 방 — 안전한 쪽으로
                    or any(is_private(zmap[n]) for n in zone_of[i] if n in zmap))}
    pgrid = ["".join("1" if comp[r][c] in private else "0" for c in range(COLS))
             for r in range(ROWS)]
    npriv = sum(row.count("1") for row in pgrid)
    with open(os.path.join(CFG, "private-area.json"), "w", encoding="utf-8") as f:
        json.dump({"cell": C, "cols": COLS, "rows": ROWS, "grid": pgrid}, f)
    print(f"손님끼리 안 보이는 방 {len(private)}개 · {npriv:,}칸 → private-area.json")

    cgrid = ["".join("1" if comp[r][c] in corridor else "0" for c in range(COLS))
             for r in range(ROWS)]
    ncorr = sum(row.count("1") for row in cgrid)
    with open(CORR_OUT, "w", encoding="utf-8") as f:
        json.dump({"cell": C, "cols": COLS, "rows": ROWS, "grid": cgrid}, f)
    print(f"\n복도 {ncorr:,}칸 = {ncorr * C * C * CM_PER_PX ** 2 / 10000:.0f}m^2 → {CORR_OUT}")

    # 방마다: 어느 문으로 드나드나
    door_of = {}
    for di, d in enumerate(dj["doors"]):
        touch = set()
        for y in range(d["y"] - C, d["y"] + d["h"] + C):
            for x in range(d["x"] - C, d["x"] + d["w"] + C):
                r, c = y // C, x // C
                if 0 <= r < ROWS and 0 <= c < COLS and comp[r][c] != -1:
                    touch.add(comp[r][c])
        for t in touch:
            door_of.setdefault(t, []).append(di)

    with open(ROOMS_OUT, "w", encoding="utf-8") as f:
        json.dump({
            "cell": C, "cols": COLS, "rows": ROWS,
            "pieces": [{"id": i, "cells": sizes[i],
                        "zones": zone_of.get(i, []),
                        "kind": "room" if i in zone_of else
                                ("corridor" if i in corridor else "scrap"),
                        "doors": door_of.get(i, [])} for i in range(len(sizes))],
        }, f, ensure_ascii=False)
    print(f"saved {ROOMS_OUT}")

    plan = Image.open(PLAN).convert("RGB")
    W, H = plan.size
    prev = Image.blend(plan, Image.new("RGB", (W, H), (255, 255, 255)), 0.55)
    dr = ImageDraw.Draw(prev, "RGBA")
    for r in range(ROWS):
        for c in range(COLS):
            i = comp[r][c]
            if i == -1:
                continue
            if i in corridor:
                col = (40, 160, 90, 120)
            elif i in zone_of and len(zone_of[i]) > 1:
                col = (230, 140, 0, 120)      # 여러 방이 뭉친 것
            else:
                # 앵커가 있든 없든 통행 공간이 아니면 방이다. 이름 없는 조각을 안 칠했더니
                # 그림에 빈 데가 생겼다 — 판정에는 이미 방으로 들어가 있는데도.
                col = (70, 110, 220, 90)
            dr.rectangle((c * C, r * C, c * C + C - 1, r * C + C - 1), fill=col)
    for d in dj["doors"]:
        dr.rectangle((d["x"], d["y"], d["x"] + d["w"] - 1, d["y"] + d["h"] - 1),
                     fill=(200, 0, 30, 230))
    prev.save(PREVIEW)
    print(f"saved {PREVIEW}  (초록=복도, 파랑=방, 주황=여러 방이 뭉친 것, 빨강=문)")


if __name__ == "__main__":
    main()
