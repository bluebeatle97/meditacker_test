#!/usr/bin/env python3
"""사람이 그린 벽 그림 → 벽 마스크 + 정렬된 벽 그림.

    python tools/build-wall-mask.py

입력:  packages/server/src/config/wall.png   ← **사람이 그린 2.5D 벽 그림**
출력:  packages/server/src/config/wall-mask.png   흑백 (흰색 = 벽)
       packages/server/src/config/wall-art.png    도면 크기로 맞춘 원본 (도트맵이 얹는다)

## 왜 이 그림이 기준인가

전에는 셋이 서로 다른 규칙으로 만들어졌다 — 도면은 얇은 선, 도트맵은 세운 벽,
격자는 "셀 절반" 기준. 그래서 **그려진 벽과 막힌 벽이 달랐고** 캐릭터 발이 벽에
박혔다. 이 그림 하나를 벽의 정의로 삼으면 셋이 같아진다.

## 판정

    밝은 곳(>=170)        바닥 (벽 그림자 포함 — 그림자는 벽이 아니다)
    회색                  벽
    검정 — 테두리에서 이어짐   건물 밖
    검정 — 안쪽에 갇힘        벽 (안내데스크 장비 같은 물건. 이걸 빼면 그 위에 사람이 선다)

## 빗살(카운터 난간)은 따로 안 메운다

카운터 난간이 막대 6px·틈 2px 짜리 빗살로 그려져 있다. 처음엔 틈을 메웠는데,
격자 한 칸이 4px 이고 "칸에 벽이 한 픽셀이라도 있으면 못 섬" 이라 **빗살 구간에서는
어차피 통째로 빈 칸이 안 나온다**. 메우나 마나 7칸(0.01%) 차이였다.

반면 위험은 있었다 — 정사각으로 메우니 문간까지 봉해서 방 6개가 끊겼다(연결 42 → 36).
얻는 게 없고 잃을 게 있으니 안 한다. 빗살 끝의 넓은 틈(최대 39px)은 실제로 사람이
지나는 자리라 바닥으로 남아야 한다.
"""
import os
from collections import deque

from PIL import Image, ImageChops

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CFG = os.path.join(ROOT, "packages", "server", "src", "config")
SRC = os.path.join(CFG, "wall.png")
MASK_OUT = os.path.join(CFG, "wall-mask.png")
ART_OUT = os.path.join(CFG, "wall-art.png")
PLAN = os.path.join(ROOT, "packages", "web-staff", "public", "floorplan.png")

BLACK = 40
# 이보다 밝으면 바닥으로 본다.
#
# 벽에는 **부드러운 그림자**가 깔려 있다(옅은 회색 번짐). 200 으로 자르면 그 그림자까지
# 벽으로 세어 벽이 실제보다 두꺼워지고, 좁은 문간이 봉해진다 — 상담실 4가 통째로 갇히고
# 방 3개가 벽에 묻혔다. 170 으로 올리면 그림자는 바닥으로 남고 벽 몸통만 잡힌다
# (살아있는 존 43 → 44, 연결 42 → 44).
FLOOR = 170
# 도면과 겹쳐 재서 나온 값 (겹치는 넓이가 가장 큰 이동)
OFFSET = (7, 1)



def main():
    plan = Image.open(PLAN).convert("RGB")
    W, H = plan.size
    art = ImageChops.offset(Image.open(SRC).convert("RGB").resize((W, H), Image.NEAREST), *OFFSET)
    art.save(ART_OUT)
    g = art.convert("L")
    gp = g.load()

    # 테두리에서 번지는 검정 = 건물 밖. 안쪽에 갇힌 검정은 물건이다
    outside = bytearray(W * H)
    q = deque()
    edge = [(x, y) for x in range(W) for y in (0, H - 1)] + [
        (x, y) for y in range(H) for x in (0, W - 1)
    ]
    for x, y in edge:
        if gp[x, y] < BLACK and not outside[y * W + x]:
            outside[y * W + x] = 1
            q.append((x, y))
    while q:
        x, y = q.popleft()
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if 0 <= nx < W and 0 <= ny < H and not outside[ny * W + nx] and gp[nx, ny] < BLACK:
                outside[ny * W + nx] = 1
                q.append((nx, ny))

    wall = Image.new("L", (W, H), 0)
    wl = wall.load()
    inner = 0
    for y in range(H):
        for x in range(W):
            v = gp[x, y]
            if BLACK <= v < FLOOR:
                wl[x, y] = 255
            elif v < BLACK and not outside[y * W + x]:
                wl[x, y] = 255
                inner += 1

    cnt = lambda m: sum(m.histogram()[255:])
    wall.save(MASK_OUT)

    # 건물 밖도 같이 남긴다 (도트맵이 바깥을 칠할 때 쓴다)
    out_img = Image.new("L", (W, H), 0)
    op = out_img.load()
    for y in range(H):
        for x in range(W):
            if outside[y * W + x]:
                op[x, y] = 255
    out_img.save(os.path.join(CFG, "outside-mask.png"))

    print(f"벽 {cnt(wall):,}px (안쪽 검은 물건 {inner:,} 포함)")
    print(f"건물 밖 {cnt(out_img):,}px")
    print(f"saved {MASK_OUT}\nsaved {ART_OUT}")


if __name__ == "__main__":
    main()
