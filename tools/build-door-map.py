#!/usr/bin/env python3
"""문 2.5D 레이어 — 환자용 도트맵 위에 얹는 투명 PNG.

    python tools/build-door-map.py

입력:  packages/server/src/config/door.json   (build-doors.py 산출)
       packages/server/src/config/floorplan.json (크기)
출력:  packages/web-patient/public/doormap.png

## 왜 도트맵에 굽지 않나

`pixelmap.png` 은 타일로 미리 그려 둔 **정지 이미지 한 장**이다. 거기에 문을 그려
넣으면 영원히 닫힌 그림이 된다. 나중에 여닫는 애니메이션 에셋으로 갈아끼우려면
문은 **배경 위에 얹는 별도 레이어**여야 한다.

그래서 이 도구는 `pixelmap.png` 을 건드리지 않는다 — 같은 크기의 투명 PNG 를 따로 낸다.

## 벽과 같은 2.5D, 다른 색

벽과 같은 방식으로 세운다 (윗면 + 남향 벽면 + 걸레받이 + 접지 그림자). 다만 **색은
벽과 확실히 다르게** — 도면에서 문이 어디인지 한눈에 구분되어야 한다. 나무색을 쓴다.

치수는 build-pixel-map.py 의 벽과 같은 상수를 쓴다. 다르면 문만 키가 달라 보인다.
"""
import json
import os
import sys

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CFG = os.path.join(ROOT, "packages", "server", "src", "config")
OUT = os.path.join(ROOT, "packages", "web-patient", "public", "doormap.png")

# ⚠️ build-pixel-map.py 와 같은 값이어야 한다. 다르면 문만 축척·키가 어긋난다
T = 16               # 타일 한 변 (출력 px)
TILE_FP = 32         # 타일 한 칸이 담는 도면 px
MAP_SCALE = T / TILE_FP
FACE_H = 13          # 벽면 높이 (출력 px)
BASEBOARD_H = 2
CONTACT_H = 5
CONTACT_ALPHA = 75

# 문 색 — 벽(회색·베이지 계열)과 확실히 구분되는 나무색
CAP = (150, 96, 52)        # 위에서 본 문 윗면
CAP_EDGE = (58, 58, 80)    # 외곽선 (에셋 시트와 같은 색)
FACE_TOP = (176, 116, 66)  # 문면 위쪽
FACE_BOT = (128, 80, 42)   # 문면 아래쪽 (아래로 갈수록 어둡게)
BASEBOARD = (74, 46, 26)


def main():
    plan = json.load(open(os.path.join(CFG, "floorplan.json"), encoding="utf-8"))
    dj = json.load(open(os.path.join(CFG, "door.json"), encoding="utf-8"))
    # 캔버스는 도트맵과 **같은 크기**여야 겹쳤을 때 안 어긋난다.
    # 도트맵은 타일 개수로 올림해서 잡으므로(825x795 가 아니라 832x800) 여기서도 그렇게 한다
    mw = -(-plan["width"] // TILE_FP) * T
    mh = -(-plan["height"] // TILE_FP) * T
    img = Image.new("RGBA", (mw, mh), (0, 0, 0, 0))
    d = ImageDraw.Draw(img, "RGBA")

    doors = dj["doors"]
    if not doors:
        sys.exit("door.json 에 문이 없다 — build-doors.py 를 먼저 돌릴 것")

    for door in doors:
        x0 = int(door["x"] * MAP_SCALE)
        y0 = int(door["y"] * MAP_SCALE)
        x1 = int((door["x"] + door["w"]) * MAP_SCALE)
        y1 = int((door["y"] + door["h"]) * MAP_SCALE)
        if x1 <= x0 or y1 <= y0:
            continue

        # 남향 벽면 — 문 아래쪽에 세운다 (벽과 같은 방향). 위에서 아래로 어두워진다
        for i in range(FACE_H):
            t = i / max(1, FACE_H - 1)
            col = tuple(int(FACE_TOP[k] + (FACE_BOT[k] - FACE_TOP[k]) * t) for k in range(3))
            yy = y1 + i
            if 0 <= yy < mh:
                d.rectangle((x0, yy, x1 - 1, yy), fill=col + (255,))
        # 걸레받이
        for i in range(BASEBOARD_H):
            yy = y1 + FACE_H + i
            if 0 <= yy < mh:
                d.rectangle((x0, yy, x1 - 1, yy), fill=BASEBOARD + (255,))
        # 바닥으로 흘리는 접지 그림자 — 없으면 문이 떠 보인다
        for i in range(CONTACT_H):
            yy = y1 + FACE_H + BASEBOARD_H + i
            a = int(CONTACT_ALPHA * (1 - i / CONTACT_H))
            if 0 <= yy < mh:
                d.rectangle((x0, yy, x1 - 1, yy), fill=(0, 0, 0, a))

        # 윗면 (위에서 본 문) — 벽면보다 나중에 그려 벽면 위를 덮게 한다
        d.rectangle((x0, y0, x1 - 1, y1 - 1), fill=CAP + (255,))
        d.rectangle((x0, y0, x1 - 1, y1 - 1), outline=CAP_EDGE + (255,), width=1)

    img.save(OUT)
    print(f"문 {len(doors)}개 → {OUT}  {img.size}")


if __name__ == "__main__":
    main()
