#!/usr/bin/env python3
"""환자용 도트(픽셀아트) 배경 생성기.

직원용 화면은 실제 도면을 그대로 쓴다(위치 정확성). 환자용은 같은 층을 도트
그래픽으로 다시 그린다 — 포켓몬 골드 같은 타일 탑뷰가 목표다:

    타일 1칸(16px) = 도면 32px 약 52cm,  출력 = 도면 × MAP_SCALE(0.5)

축척이 핵심이다. 타일을 잘게(도면 8px) 잡으면 벽은 또렷해지지만 바닥 무늬가
캐릭터보다 커져 도트맵으로 안 보인다(실측 확인). 에셋 본래 축척에 맞춰
캐릭터(16x32)가 두 칸 키로 서고, **확대는 카메라 줌**이 담당한다.
서버 좌표(도면 px)에 MAP_SCALE 을 곱하면 그대로 화면 좌표가 된다.

방 구분:
  존마다 통행가능 격자에서 **방 사각형을 실측**한다(pathfinder.roomBoxAt 과 같은
  방식 — 앵커 주변 여러 줄의 좌우/상하 벽 위치 중앙값). 사각형이 겹치면 앵커가
  더 가까운 존이 이긴다. 어느 방에도 안 들어가는 바닥은 복도로 칠한다.
  ⚠️ 연결영역 BFS 로는 안 된다 — 문이 열려 있어 방끼리 색이 번진다(실측 확인).

입력:  packages/server/src/config/{walkable,zones,floorplan}.json
       Modern Interiors 타일셋 (Room_Builder_free_16x16.png)
출력:  packages/web-patient/public/pixelmap.png

    python tools/build-pixel-map.py [타일셋_폴더]

⚠️ 에셋 라이선스: 무료 버전은 비상업 프로젝트 전용이다. 실제 병원 운영에 쓰려면
   유료(전체) 버전을 구매해야 한다. LICENSE.txt 확인.
"""
import json
import math
import os
import sys

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CFG = os.path.join(ROOT, "packages", "server", "src", "config")
OUT = os.path.join(ROOT, "packages", "web-patient", "public", "pixelmap.png")
DEFAULT_ASSETS = r"C:\Users\LG gram\Desktop\메디트레커(가칭)\에셋\Modern tiles_Free"

T = 16          # 타일 한 변 (출력 px) — 에셋 타일 크기
# 타일 한 칸이 담는 도면 px. 도면 1px ≈ 1.62cm 이므로 32px ≈ 52cm.
# ⚠️ 이 값이 곧 '축척'이다. 너무 잘게 잡으면(8px≈13cm) 바닥 무늬가 캐릭터보다 커져
#    도트 그래픽으로 안 보인다 — 캐릭터(16x32)가 2칸 키 ≈ 104cm 가 되게 맞춘 값.
TILE_FP = 32
MAP_SCALE = T / TILE_FP    # 출력 = 도면 × 0.5
# 막힌 셀이 이 비율을 넘으면 벽. 타일이 커졌으니 낮게 잡아야 벽이 한 칸으로 이어진다
# (도면 벽 두께 10~14px = 타일의 30~44%).
WALL_RATIO = 0.3

# Room_Builder 타일셋 좌표 (타일 단위). 바닥은 3x2 패턴이 반복된다.
FLOORS = {
    "brick":     (11, 5, 3, 2),   # 붉은 벽돌 — 엘리베이터 홀
    "cream":     (11, 7, 3, 2),   # 크림 타일 — 상담·회복·피부관리
    "teal":      (11, 9, 3, 2),   # 민트 타일 — 시술·수술·레이저
    "lightgray": (11, 11, 3, 2),  # 밝은 회색 타일 — 화장실·체인징룸·복도
    "wood":      (11, 13, 3, 2),  # 헤링본 우드 — 대기공간·접수
    "concrete":  (14, 7, 3, 2),   # 회색 콘크리트 — 직원 구역
}
# 벽은 타일도, 격자도 아니라 **도면 원본 선을 그대로 축소**해서 올린다.
# 타일(52cm)·격자(6.5cm) 둘 다 계단처럼 각이 지는데, 도면을 LANCZOS 로 줄이면
# 안티에일리어싱이 걸려 벽만 매끈해진다 (바닥은 도트 타일 그대로).
PLAN_PNG = os.path.join(ROOT, "packages", "web-staff", "public", "floorplan.png")
WALL_RGB = (52, 54, 74)
WALL_DARK = 200      # 이보다 어두우면 완전 불투명한 벽
WALL_LIGHT = 246     # 이보다 밝으면 벽 아님 (사이는 반투명 → 매끈한 경계)
SHADOW_DROP = 3      # 벽 아래로 이만큼 그림자 (출력 px)
SHADOW_ALPHA = 90
# 막힌 셀에서 이 거리(격자 셀) 안에 통행가능 셀이 있으면 '건물 안', 아니면 건물 밖(void).
WALL_REACH = 4

# 존 type → 바닥 재질. category=staff_area 는 무조건 concrete (환자 동선 아님).
FLOOR_BY_TYPE = {
    "waiting": "wood",
    "reception": "wood",
    "consult": "cream",
    "recovery": "cream",
    "skincare": "cream",
    "surgery": "teal",
    "laser": "teal",
    "etc": "lightgray",
    "staff": "concrete",
}
VOID_RGB = (14, 20, 32)      # 건물 밖 / 샤프트
CORRIDOR = "lightgray"
# 방 사각형이 앵커에서 이만큼(도면 px ≈ 3.9m)까지만 뻗게 자른다.
# 실측이 문틈으로 새면 복도까지 한 방 색으로 덮여버린다 — 남는 곳은 복도로 칠하면 된다.
MAX_HALF = 240


def load(name):
    with open(os.path.join(CFG, name), encoding="utf-8") as f:
        return json.load(f)


class Walk:
    """통행가능 격자 조회 (도면 px 좌표로 질의)"""

    def __init__(self, w):
        self.cell = w["cell"]
        self.cols = w["cols"]
        self.rows = w["rows"]
        self.grid = w["grid"]

    def ok(self, px, py):
        c, r = int(px // self.cell), int(py // self.cell)
        return 0 <= c < self.cols and 0 <= r < self.rows and self.grid[r][c] == "1"

    def span_x(self, px, py):
        if not self.ok(px, py):
            return None
        l = r = px
        while l - self.cell > 0 and self.ok(l - self.cell, py):
            l -= self.cell
        while r + self.cell < self.cols * self.cell and self.ok(r + self.cell, py):
            r += self.cell
        return l, r

    def span_y(self, px, py):
        if not self.ok(px, py):
            return None
        t = b = py
        while t - self.cell > 0 and self.ok(px, t - self.cell):
            t -= self.cell
        while b + self.cell < self.rows * self.cell and self.ok(px, b + self.cell):
            b += self.cell
        return t, b

    def room_box(self, px, py, probe=6):
        """앵커가 속한 방의 사각형 (도면 px). 문틈 한 줄에 휘둘리지 않게 중앙값을 쓴다."""
        if not self.ok(px, py):
            return None
        step = self.cell * 2
        L, R, Tp, B = [], [], [], []
        for i in range(-probe, probe + 1):
            s = self.span_x(px, py + i * step)
            if s:
                L.append(s[0])
                R.append(s[1])
            s = self.span_y(px + i * step, py)
            if s:
                Tp.append(s[0])
                B.append(s[1])
        if not L or not Tp:
            return None
        mid = lambda v: sorted(v)[len(v) // 2]
        return mid(L), mid(Tp), mid(R) + self.cell, mid(B) + self.cell



def nearest_mat(mat_of, tx, ty, tw, th, reach=3):
    """막힌 타일 밑에 깔 바닥 재질 — 가까운 방 재질을 가져온다 (벽이 그 위를 덮는다)"""
    for r in range(1, reach + 1):
        for dy in range(-r, r + 1):
            for dx in range(-r, r + 1):
                x, y = tx + dx, ty + dy
                if 0 <= x < tw and 0 <= y < th and mat_of[y][x]:
                    return mat_of[y][x]
    return None


def main():
    assets = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_ASSETS
    sheet_path = os.path.join(assets, "Interiors_free", "16x16", "Room_Builder_free_16x16.png")
    if not os.path.exists(sheet_path):
        sys.exit(f"타일셋을 못 찾음: {sheet_path}\n사용법: build-pixel-map.py <타일셋_폴더>")
    sheet = Image.open(sheet_path).convert("RGBA")

    plan = load("floorplan.json")
    zones = load("zones.json")
    walk = Walk(load("walkable.json"))

    tw = -(-plan["width"] // TILE_FP)            # 타일 개수 (가로)
    th = -(-plan["height"] // TILE_FP)
    per = TILE_FP // walk.cell                   # 타일 한 변의 격자 셀 수 (8)

    # ── 1. 타일별 바닥/벽 판정 ──────────────────────────────────────────────
    floor = [[False] * tw for _ in range(th)]
    for ty in range(th):
        for tx in range(tw):
            n = 0
            for dy in range(per):
                for dx in range(per):
                    if walk.ok((tx * per + dx) * walk.cell, (ty * per + dy) * walk.cell):
                        n += 1
            blocked = 1 - n / (per * per)
            floor[ty][tx] = blocked < WALL_RATIO

    # ── 2. 존별 방 사각형 실측 → 타일 소유권 (겹치면 앵커가 가까운 쪽) ──────
    boxes = []
    for z in zones:
        ax, ay = z["tilePosition"]["x"], z["tilePosition"]["y"]
        box = walk.room_box(ax, ay)
        if box:
            x0, y0, x1, y1 = box
            box = (
                max(x0, ax - MAX_HALF),
                max(y0, ay - MAX_HALF),
                min(x1, ax + MAX_HALF),
                min(y1, ay + MAX_HALF),
            )
            boxes.append((box, (ax, ay), z))
    print(f"방 사각형 실측: {len(boxes)}/{len(zones)}")

    mat_of = [[None] * tw for _ in range(th)]
    for ty in range(th):
        for tx in range(tw):
            if not floor[ty][tx]:
                continue
            fx = (tx + 0.5) * TILE_FP      # 타일 중심을 도면 좌표로
            fy = (ty + 0.5) * TILE_FP
            best, bestd = None, None
            for (x0, y0, x1, y1), (ax, ay), z in boxes:
                if x0 <= fx < x1 and y0 <= fy < y1:
                    d = math.hypot(fx - ax, fy - ay)
                    if bestd is None or d < bestd:
                        best, bestd = z, d
            if best is None:
                mat_of[ty][tx] = CORRIDOR
            elif best["category"] == "staff_area":
                mat_of[ty][tx] = "concrete"
            elif best["zoneId"] == "elev_hall":
                mat_of[ty][tx] = "brick"
            else:
                mat_of[ty][tx] = FLOOR_BY_TYPE.get(best["type"], CORRIDOR)

    # ── 3. 바닥 찍기 ────────────────────────────────────────────────────────
    # 재질별로 타일을 채운 레이어를 만들고, **방 사각형 마스크**로 잘라 얹는다.
    # 타일 단위로 재질을 고르면 방 경계가 52cm 계단이 된다 — 마스크로 자르면 직선이다.
    img = Image.new("RGBA", (tw * T, th * T), VOID_RGB + (255,))

    def tiled(mat):
        ox, oy, pw, ph = FLOORS[mat]
        pat = sheet.crop((ox * T, oy * T, (ox + pw) * T, (oy + ph) * T))
        layer = Image.new("RGBA", img.size)
        for y in range(0, img.height, pat.height):
            for x in range(0, img.width, pat.width):
                layer.paste(pat, (x, y))
        return layer

    layers = {m: tiled(m) for m in FLOORS}
    img.alpha_composite(layers[CORRIDOR])       # 복도/기본 바닥

    # 넓은 사각형부터 깔아 작은 방(더 구체적인 것)이 위로 오게 한다
    counts = {}
    for (x0, y0, x1, y1), _anchor, z in sorted(
        boxes, key=lambda b: -((b[0][2] - b[0][0]) * (b[0][3] - b[0][1]))
    ):
        if z["category"] == "staff_area":
            mat = "concrete"
        elif z["zoneId"] == "elev_hall":
            mat = "brick"
        else:
            mat = FLOOR_BY_TYPE.get(z["type"], CORRIDOR)
        counts[mat] = counts.get(mat, 0) + 1
        box = (
            int(x0 * MAP_SCALE),
            int(y0 * MAP_SCALE),
            int(x1 * MAP_SCALE),
            int(y1 * MAP_SCALE),
        )
        img.paste(layers[mat].crop(box), (box[0], box[1]))

    # ── 4. 건물 밖(void) 채우기 — 막힌 셀 중 통행가능 셀에서 먼 곳 ───────────
    cell_px = int(walk.cell * MAP_SCALE)
    draw = ImageDraw.Draw(img)
    reach = WALL_REACH
    void_cells = 0
    for gy in range(walk.rows):
        for gx in range(walk.cols):
            if walk.grid[gy][gx] == "1":
                continue
            near = False
            for dy in range(-reach, reach + 1):
                for dx in range(-reach, reach + 1):
                    y, x = gy + dy, gx + dx
                    if 0 <= x < walk.cols and 0 <= y < walk.rows and walk.grid[y][x] == "1":
                        near = True
                        break
                if near:
                    break
            if not near:
                void_cells += 1
                draw.rectangle(
                    [gx * cell_px, gy * cell_px, gx * cell_px + cell_px - 1, gy * cell_px + cell_px - 1],
                    fill=VOID_RGB,
                )

    # ── 5. 벽 — 도면 원본 선을 축소해 매끈하게 올린다 (여기만 도트 아님) ──────
    if not os.path.exists(PLAN_PNG):
        sys.exit(f"도면 원본을 못 찾음: {PLAN_PNG}")
    gray = Image.open(PLAN_PNG).convert("L")
    lut = []
    for g in range(256):
        if g <= WALL_DARK:
            lut.append(255)
        elif g >= WALL_LIGHT:
            lut.append(0)
        else:
            lut.append(int(255 * (WALL_LIGHT - g) / (WALL_LIGHT - WALL_DARK)))
    mw = int(plan["width"] * MAP_SCALE)
    mh = int(plan["height"] * MAP_SCALE)
    # LANCZOS 축소가 경계에 반투명 픽셀을 만들어 벽이 계단이 아니라 선으로 보인다
    alpha = gray.point(lut).resize((mw, mh), Image.LANCZOS)

    shadow = Image.new("RGBA", (mw, mh), (0, 0, 0, 0))
    shadow.putalpha(alpha.point(lambda a: a * SHADOW_ALPHA // 255))
    img.alpha_composite(shadow, (0, SHADOW_DROP))   # 벽 아래로 살짝 흘린 그림자

    wall = Image.new("RGBA", (mw, mh), WALL_RGB + (255,))
    wall.putalpha(alpha)
    img.alpha_composite(wall, (0, 0))

    # 타일 격자 크기 그대로 저장한다 (도면 크기로 자르면 마지막 타일이 잘린다)
    img.save(OUT)
    print(f"saved {OUT}  {img.size}  tiles {tw}x{th}  (도면 x{MAP_SCALE} · 타일 {TILE_FP}도면px {TILE_FP*1.62:.0f}cm)")
    print(f"건물 밖 셀: {void_cells}")
    print("재질별 방 수:", dict(sorted(counts.items(), key=lambda kv: -kv[1])))


if __name__ == "__main__":
    main()
