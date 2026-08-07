#!/usr/bin/env python3
"""칠한 그림 → 구역 마스크.

    python tools/build-staff-areas.py

입력:  packages/server/src/config/staff-area.png   ← **사람이 칠한 그림**
출력:  packages/server/src/config/staff-area.json    자홍색 = 손님 통제구역
       packages/server/src/config/blocked-area.json  청록색 = 아무도 못 서는 자리

## 두 색의 차이

    자홍 #FF00FF  손님 통제구역 — **직원은 다닌다**. 환자 화면에서 벽처럼 덮고,
                  안내 경로가 피해 간다. 통행 격자는 그대로 (직원 좌표가 살아 있어야 한다)
    청록 #00FFFF  아무도 못 서는 자리 — 안내데스크 안쪽, 파티션, 붙박이 가구.
                  **통행 격자에서 아예 뺀다**. 사람이 그 위에 서 있으면 안 되는 곳이다

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

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CFG = os.path.join(ROOT, "packages", "server", "src", "config")
MARK = os.path.join(CFG, "staff-area.png")
OUT = os.path.join(CFG, "staff-area.json")
BLOCKED_OUT = os.path.join(CFG, "blocked-area.json")
CELL = 4  # walkable.json 과 같아야 한다


def is_staff(p):
    r, g, b = p[:3]
    return r > 200 and g < 80 and b > 200


def is_blocked(p):
    r, g, b = p[:3]
    return r < 120 and g > 180 and b > 180


def main():
    plan = json.load(open(os.path.join(CFG, "floorplan.json"), encoding="utf-8"))
    W, H = plan["width"], plan["height"]
    if not os.path.exists(MARK):
        print(f"칠한 그림이 없다: {MARK} — 빈 마스크를 쓴다")
        img = Image.new("RGB", (W, H), (255, 255, 255))
    else:
        img = Image.open(MARK).convert("RGB")
        if img.size != (W, H):
            print(f"칠한 그림 {img.size} → 도면 {(W, H)} 로 맞춤")
            # 가장 가까운 픽셀로 늘린다 — 섞으면 경계가 흐려져 칸 판정이 흔들린다
            img = img.resize((W, H), Image.NEAREST)

    px = img.load()
    cols, rows = W // CELL, H // CELL
    out = {"staff": ([], 0), "blocked": ([], 0)}
    sgrid, bgrid = [], []
    ns = nb = 0
    for r in range(rows):
        srow, brow = [], []
        for c in range(cols):
            ks = kb = 0
            for y in range(r * CELL, (r + 1) * CELL):
                for x in range(c * CELL, (c + 1) * CELL):
                    p = px[x, y]
                    if is_staff(p):
                        ks += 1
                    elif is_blocked(p):
                        kb += 1
            n = CELL * CELL
            # 못 서는 자리는 **한 픽셀이라도 걸치면** 막는다. 파티션은 얇아서 절반
            # 기준으로 재면 통째로 사라진다 — 얇게 그은 선이 그대로 살아야 한다
            s_on = ks / n >= 0.5
            b_on = kb > 0
            srow.append("1" if s_on else "0")
            brow.append("1" if b_on else "0")
            ns += s_on
            nb += b_on
        sgrid.append("".join(srow))
        bgrid.append("".join(brow))

    area = lambda k: k * CELL * CELL * 1.62 * 1.62 / 10000
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"cell": CELL, "cols": cols, "rows": rows, "grid": sgrid}, f)
    print(f"손님 통제구역 {ns:,}칸 = {area(ns):.1f}m^2 → {OUT}")
    with open(BLOCKED_OUT, "w", encoding="utf-8") as f:
        json.dump({"cell": CELL, "cols": cols, "rows": rows, "grid": bgrid}, f)
    print(f"못 서는 자리 {nb:,}칸 = {area(nb):.1f}m^2 → {BLOCKED_OUT}")


if __name__ == "__main__":
    main()
