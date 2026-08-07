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
  **문 폭보다 크게 깎아 방을 떼어낸 뒤 다시 채운다** (`segment_rooms` 주석에 자세히).
  앵커가 없는 조각은 복도다. 사각형 실측 방식은 v2 도면에서 문이 사라지자 개구부로
  새어 복도까지 한 방으로 먹었고, 그냥 연결영역 BFS 는 문이 열려 있어 층 전체가
  한 덩어리가 된다 — 둘 다 실제로 겪은 실패다.

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
from collections import deque

from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CFG = os.path.join(ROOT, "packages", "server", "src", "config")
OUT = os.path.join(ROOT, "packages", "web-patient", "public", "pixelmap.png")
OVER_OUT = os.path.join(ROOT, "packages", "web-patient", "public", "pixelmap-over.png")
DEFAULT_ASSETS = r"C:\Users\LG gram\Desktop\메디트레커(가칭)\에셋\Modern tiles_Free"

# 직원 전용 구역 바닥색 — 환자 화면에서 "못 들어가는 곳" 으로 읽혀야 하므로
# 다른 방보다 확실히 어둡게 (완전 검정은 건물 밖(void)과 헷갈린다)
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
WALL_RGB = (58, 58, 80)   # 에셋 시트의 외곽선 색 — 벽 윗면 테두리에 쓴다
CAP_RGB = (248, 248, 248)  # 벽을 위에서 본 윗면 (Room_Builder 의 ceiling 색)
WALL_DARK = 200      # 이보다 어두우면 완전 불투명한 벽
WALL_LIGHT = 246     # 이보다 밝으면 벽 아님 (사이는 반투명 → 매끈한 경계)

# ── 2.5D 벽 ──────────────────────────────────────────────────────────────
# 벽을 위에서 본 납작한 선으로 두면 두께만 있고 높이가 없다. 카메라 쪽(남향) 벽에만
# **벽면을 세워 붙이면** 탑다운인데 벽에 높이가 생긴다 (엔터 더 건전이 쓰는 방식).
# 북·동·서 벽은 윗면만 보인다 — 그쪽 면은 카메라를 등지고 있다.
#
# 셋이 한 묶음이다. 벽면만 세우고 걸레받이와 접지 그림자를 빼면 벽이 바닥에 붙지 않고
# 떠 보인다.
FACE_H = 13          # 벽면 높이 (출력 px). 13px ≈ 42cm
BASEBOARD_H = 2      # 걸레받이 (에셋 블록의 맨 아래 2px)
CONTACT_H = 5        # 벽면 아래 바닥에 흘리는 접지 그림자
CONTACT_ALPHA = 75
# 벽지 블록 좌상단 (Room_Builder, 타일 단위). 블록 하나가 2타일=32px 이고 구성은
# 외곽선1 + 천장캡4 + 외곽선1 + 벽면24 + 걸레받이1 + 외곽선1 이다.
# ⚠️ gray·beige·wood 만 쓴다. 줄무늬 벽지(mint·cream·salmon)는 아래 절반이 다른 색
#    굽도리라, 높이를 줄이려고 아래에서 자르면 그 색으로만 채워진다.
WALL_BLOCK = {"gray": (0, 17), "beige": (0, 19), "wood": (0, 11)}
FACE_BAND_BOTTOM = 30    # 블록 안에서 벽면이 끝나는 y (걸레받이 시작 전)
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
# 존 type → **벽지** 재질. 벽면은 방 안에서 보이므로 그 방 기준으로 고른다.
# ⚠️ 디자이너가 바꿀 값이다 — 구조(어디에 벽을 세우나)는 도면에서 나오고, 마감(무엇을
#    붙이나)은 여기서 정한다. 표면만 갈아입히는 자리라 이 dict 만 고치면 된다.
WALL_BY_TYPE = {
    "waiting": "wood",
    "reception": "wood",
    "consult": "beige",
    "recovery": "beige",
    "skincare": "beige",
    "surgery": "gray",
    "laser": "gray",
    "etc": "gray",
    "staff": "gray",
}
WALL_CORRIDOR = "gray"
VOID_RGB = (14, 20, 32)      # 건물 밖 / 샤프트 / 통제구역
CORRIDOR = "lightgray"
# 도면 축척 — 단일 출처는 shared/mock-walk.ts 의 CM_PER_PX. 여기 값이 그것과 다르면
# 화면의 거리감과 서버의 물리가 어긋난다.
CM_PER_PX = 1.62
# 방을 떼어낼 때 깎는 양. **문 폭의 절반보다 커야** 문이 닫힌다 (문 약 90cm → 45cm 초과).
# 55cm 로 두면 110cm 개구부까지 닫히고, 복도(1.5m 이상)와 가장 작은 방(1.6m)은 살아남는다.
ERODE_CM = 55
# 앵커에서 **걸어서** 이만큼까지만 그 방으로 본다.
#
# 깎기만으로는 부족하다 — 대기공간처럼 문 없이 복도로 열린 방은 개구부가 110cm 를 넘어
# 안 닫히고, 그 방 조각이 복도와 한 덩어리가 된다. 그러면 대기공간 색이 복도를 타고
# 층 절반까지 번진다(실제로 그렇게 나왔다).
#
# 예전 MAX_HALF(사각형 상한)와 다른 점은 **벽을 따라 재는 거리**라는 것이다. 직선 거리로
# 자르면 벽 너머 옆방까지 잘려 나가지만, 이건 걸어서 갈 수 있는 거리라 방 모양을 따른다.
# 이 층에서 가장 큰 방(대기공간 2, 6.2 x 4.7m)의 중심에서 모서리까지가 3.9m 다.
MAX_REACH_CM = 450


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

    def cell_ok(self, c, r):
        return 0 <= c < self.cols and 0 <= r < self.rows and self.grid[r][c] == "1"


def segment_rooms(walk, zones, detail=None):
    """통행가능 바닥을 방별로 나눈다. 반환: `owner[r][c]` = 존 인덱스 / -1 복도 / None 막힘.

    ## 왜 사각형이 아닌가

    예전에는 앵커에서 좌우·상하 벽까지의 중앙값으로 **방 사각형**을 재고 그 안을 그 방
    색으로 칠했다. v2 도면부터 문이 그려지지 않아 개구부가 넓어지자 그 방식이 무너졌다 —
    사각형이 문틈으로 새어 복도까지 한 방으로 먹었다 (피부관리실이 깊이 7.7m, 대기공간 1과
    의국실이 13타일로 측정됐다. 상한 ±240px 에 걸려 있던 것이다).

    ## 왜 그냥 BFS 도 아닌가

    통행가능 영역을 그대로 연결영역으로 나누면 **문이 열려 있어 방끼리 다 이어진다** —
    층 전체가 한 덩어리가 된다. 이건 예전에도 확인한 실패다.

    ## 그래서: 문보다 크게 깎았다가 다시 채운다

    1. 각 셀에서 가장 가까운 벽까지의 거리를 잰다.
    2. **문 폭의 절반보다 크게** 깎는다(ERODE_CM). 문(약 90cm)은 양쪽에서 깎여 닫히고,
       복도(1.5m 이상)와 방은 폭이 남아 살아 있다 → 방이 서로 떨어진 조각(core)이 된다.
    3. 조각 안에 앵커가 있으면 그 방, 앵커가 여러 개면 조각 안에서 가까운 앵커가 이긴다.
       앵커가 없는 조각은 복도다 (zones.json 에 복도 존은 없다).
    4. 깎여 나간 테두리와 문간을 조각들로부터 다시 채운다.

    ⚠️ 깎는 양은 **문 폭에 매여 있다.** 도면의 문 개구부가 이보다 넓어지면 그 문이 닫히지
       않아 방과 복도가 한 조각이 된다. 문 폭을 바꿀 일이 생기면 여기도 같이 본다.
    """
    cell_cm = walk.cell * CM_PER_PX
    erode = max(2, int(ERODE_CM / cell_cm))
    cols, rows = walk.cols, walk.rows
    W = [[walk.grid[r][c] == "1" for c in range(cols)] for r in range(rows)]

    # 1. 벽까지의 거리 (체임퍼 2-패스, 직교 10 · 대각 14 ≈ 유클리드 x10)
    INF = 10 ** 9
    d = [[0 if not W[r][c] else INF for c in range(cols)] for r in range(rows)]
    for r in range(rows):
        for c in range(cols):
            if d[r][c] == 0:
                continue
            best = d[r][c]
            for dc, dr, w in ((-1, 0, 10), (0, -1, 10), (-1, -1, 14), (1, -1, 14)):
                cc, rr = c + dc, r + dr
                if 0 <= cc < cols and 0 <= rr < rows:
                    best = min(best, d[rr][cc] + w)
            d[r][c] = best
    for r in range(rows - 1, -1, -1):
        for c in range(cols - 1, -1, -1):
            if d[r][c] == 0:
                continue
            best = d[r][c]
            for dc, dr, w in ((1, 0, 10), (0, 1, 10), (1, 1, 14), (-1, 1, 14)):
                cc, rr = c + dc, r + dr
                if 0 <= cc < cols and 0 <= rr < rows:
                    best = min(best, d[rr][cc] + w)
            d[r][c] = best

    # 2. 깎은 뒤 남은 조각(core) 라벨링
    thr = erode * 10
    core = [[-1] * cols for _ in range(rows)]
    cores = 0
    for sr in range(rows):
        for sc in range(cols):
            if d[sr][sc] < thr or core[sr][sc] >= 0:
                continue
            q = deque([(sc, sr)])
            core[sr][sc] = cores
            while q:
                c, r = q.popleft()
                for dc, dr in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    cc, rr = c + dc, r + dr
                    if (0 <= cc < cols and 0 <= rr < rows and d[rr][cc] >= thr
                            and core[rr][cc] < 0):
                        core[rr][cc] = cores
                        q.append((cc, rr))
            cores += 1

    # 3. 앵커를 조각에 붙인다. 앵커가 벽 가까이 있어 조각 밖이면 가장 가까운 조각 셀을 찾는다.
    seeds = []          # (c, r, zone_idx)
    for i, z in enumerate(zones):
        ac = int(z["tilePosition"]["x"] // walk.cell)
        ar = int(z["tilePosition"]["y"] // walk.cell)
        if core[ar][ac] >= 0:
            seeds.append((ac, ar, i))
            continue
        best = None
        for rr in range(max(0, ar - 40), min(rows, ar + 41)):
            for cc in range(max(0, ac - 40), min(cols, ac + 41)):
                if core[rr][cc] < 0:
                    continue
                dist = math.hypot(cc - ac, rr - ar)
                if best is None or dist < best[0]:
                    best = (dist, cc, rr)
        if best:
            seeds.append((best[1], best[2], i))
        else:
            print(f"⚠️ 조각에 못 붙인 존: {z['name']} — 방이 문 폭보다 좁다는 뜻이다")

    # 4. 조각 안에서 가까운 앵커가 이긴다 (조각 하나에 앵커가 여러 개일 수 있다).
    #    reach 를 넘어가면 놓아준다 — 복도와 한 덩어리가 된 조각이 방 색으로 덮이지 않게.
    reach = int(MAX_REACH_CM / cell_cm)
    owner = [[None] * cols for _ in range(rows)]
    walked = [[0] * cols for _ in range(rows)]
    q = deque()
    for c, r, i in seeds:
        owner[r][c] = i
        q.append((c, r))
    while q:
        c, r = q.popleft()
        if walked[r][c] >= reach:
            continue
        for dc, dr in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            cc, rr = c + dc, r + dr
            if (0 <= cc < cols and 0 <= rr < rows and owner[rr][cc] is None
                    and core[rr][cc] >= 0 and core[rr][cc] == core[r][c]):
                owner[rr][cc] = owner[r][c]
                walked[rr][cc] = walked[r][c] + 1
                q.append((cc, rr))
    # 앵커가 없던 조각, 그리고 reach 를 넘어 남은 조각 = 복도
    for r in range(rows):
        for c in range(cols):
            if core[r][c] >= 0 and owner[r][c] is None:
                owner[r][c] = -1

    # 5. 깎여 나간 테두리·문간을 조각들로부터 채운다
    q = deque((c, r) for r in range(rows) for c in range(cols) if owner[r][c] is not None)
    while q:
        c, r = q.popleft()
        for dc, dr in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            cc, rr = c + dc, r + dr
            if 0 <= cc < cols and 0 <= rr < rows and W[rr][cc] and owner[rr][cc] is None:
                owner[rr][cc] = owner[r][c]
                q.append((cc, rr))
    for r in range(rows):
        for c in range(cols):
            if not W[r][c]:
                owner[r][c] = None

    # ⚠️ 다수결 스무딩을 붙여 봤지만 뺐다. reach 로 자른 경계는 셀 단위 잡음이 아니라
    #    매끈한 원호라서, 5x5 다수결로는 10만 셀 중 4셀만 바뀌고 값만 비싸다. 대기공간처럼
    #    벽 없이 열린 구역의 경계가 벽과 안 맞는 건 이 방법의 한계이고, 고치려면 그 구역에
    #    복도 앵커를 따로 주는 수밖에 없다.

    named = sum(1 for r in range(rows) for c in range(cols)
                if owner[r][c] is not None and owner[r][c] >= 0)
    hall = sum(1 for r in range(rows) for c in range(cols) if owner[r][c] == -1)
    got = len({o for row in owner for o in row if o is not None and o >= 0})
    print(f"방 구역 나누기: 조각 {cores}개 · 존 {got}/{len(zones)}개가 바닥을 얻음 "
          f"(깎기 {erode}셀 = {erode * cell_cm:.0f}cm) · 방 {named:,}셀 / 복도 {hall:,}셀")
    # 조각 지도는 문간을 찾는 데 쓴다 — 깎여 나간 띠 중 서로 다른 조각을 잇는 셀이 문이다.
    # 디자이너 판(build-design-board.py)이 이걸 쓴다. 같은 계산을 두 벌 두지 않기 위해 내보낸다.
    if detail is not None:
        detail["core"] = core
        detail["clearance"] = d      # 셀 → 가장 가까운 벽까지 (x10, 대각 14)
    return owner


def main():
    assets = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_ASSETS
    sheet_path = os.path.join(assets, "Interiors_free", "16x16", "Room_Builder_free_16x16.png")
    if not os.path.exists(sheet_path):
        sys.exit(f"타일셋을 못 찾음: {sheet_path}\n사용법: build-pixel-map.py <타일셋_폴더>")
    sheet = Image.open(sheet_path).convert("RGBA")

    plan = load("floorplan.json")
    zones = load("zones.json")
    # **바닥이 있는 곳**을 읽는다 (walkable.json 이 아니다).
    # walkable.json 은 2.5D 벽면 띠가 빠진 "설 수 있는 곳" 이라, 그걸 읽으면 벽면을
    # 덜 그리게 되고 → 다음 빌드에서 또 줄어든다. 그리기는 원본 바닥 기준이어야 한다.
    walk = Walk(load("floor.json" if os.path.exists(os.path.join(CFG, "floor.json")) else "walkable.json"))

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

    # ── 2. 방 구역 나누기 (문에서 끊는다 — segment_rooms 주석 참고) ──────────
    owner = segment_rooms(walk, zones)

    def mat_for(idx):
        if idx is None or idx < 0:
            return CORRIDOR
        z = zones[idx]
        if z["category"] == "staff_area":
            return "concrete"
        if z["zoneId"] == "elev_hall":
            return "brick"
        return FLOOR_BY_TYPE.get(z["type"], CORRIDOR)

    # ── 3. 바닥 찍기 ────────────────────────────────────────────────────────
    # 재질별 마스크를 **격자 셀(6.5cm) 해상도**로 만들어 타일 레이어를 통과시킨다.
    # 타일(52cm) 단위로 재질을 고르면 방 경계가 계단이 된다 — 셀 해상도면 벽선과 맞는다.
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
    masks = {m: Image.new("L", img.size, 0) for m in FLOORS}
    draws = {m: ImageDraw.Draw(masks[m]) for m in FLOORS}
    cpx = walk.cell * MAP_SCALE                 # 셀 한 변의 출력 px (2)
    for r in range(walk.rows):
        c = 0
        while c < walk.cols:
            if owner[r][c] is None:
                c += 1
                continue
            mat = mat_for(owner[r][c])
            s = c
            while c < walk.cols and owner[r][c] is not None and mat_for(owner[r][c]) == mat:
                c += 1
            draws[mat].rectangle(
                [int(s * cpx), int(r * cpx), int(c * cpx) - 1, int((r + 1) * cpx) - 1],
                fill=255,
            )
    for mat, mask in masks.items():
        img.paste(layers[mat], (0, 0), mask)

    counts = {}
    for i, z in enumerate(zones):
        m = mat_for(i)
        counts[m] = counts.get(m, 0) + 1

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

    # ── 5. 벽 — 2.5D (천장캡 + 남향 벽면 + 걸레받이 + 접지 그림자) ────────────
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
    ap = alpha.load()
    opx = walk.cell * MAP_SCALE                  # 격자 셀 한 변의 출력 px (2)

    def owner_at(x, y):
        """출력 좌표의 바닥 주인 (없으면 None)"""
        c, r = int(x / opx), int(y / opx)
        if 0 <= r < walk.rows and 0 <= c < walk.cols:
            return owner[r][c]
        return None

    def wall_mat_at(x, y):
        o = owner_at(x, y)
        if o is None or o < 0:
            return WALL_CORRIDOR
        z = zones[o]
        return WALL_BY_TYPE.get("staff" if z["category"] == "staff_area" else z["type"],
                                WALL_CORRIDOR)

    # 벽지 블록에서 벽면 띠와 걸레받이를 잘라 둔다 (아래에서 잘라야 걸레받이가 남는다)
    bands = {}
    for name, (bc, br) in WALL_BLOCK.items():
        by = br * T
        bands[name] = (
            sheet.crop(((bc + 1) * T, by + FACE_BAND_BOTTOM - FACE_H,
                        (bc + 2) * T, by + FACE_BAND_BOTTOM)),
            sheet.crop(((bc + 1) * T, by + FACE_BAND_BOTTOM,
                        (bc + 2) * T, by + FACE_BAND_BOTTOM + BASEBOARD_H)),
        )

    face_layer = Image.new("RGBA", (mw, mh), (0, 0, 0, 0))
    shade = Image.new("RGBA", (mw, mh), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shade)
    faces = 0
    for x in range(mw):
        y = 1
        while y < mh - 1:
            # 벽의 아래쪽 경계이고, 그 아래가 통행 가능한 바닥이면 벽면을 세운다
            if ap[x, y] >= 128 and ap[x, y + 1] < 128 and owner_at(x, y + 1) is not None:
                mat = wall_mat_at(x, y + 1)
                band, base = bands[mat]
                # 좁은 통로에서 벽면이 맞은편 벽을 넘어가지 않게 자른다
                h = 0
                while h < FACE_H and y + 1 + h < mh and ap[x, y + 1 + h] < 128:
                    h += 1
                if h >= 3:
                    sx = x % T
                    face_layer.alpha_composite(
                        band.crop((sx, FACE_H - h, sx + 1, FACE_H)), (x, y + 1))
                    yb = y + 1 + h
                    for i in range(BASEBOARD_H):
                        if yb + i < mh and ap[x, yb + i] < 128:
                            face_layer.alpha_composite(
                                base.crop((sx, i, sx + 1, i + 1)), (x, yb + i))
                    for i in range(CONTACT_H):     # 바닥으로 흘리는 접지 그림자
                        yy = yb + BASEBOARD_H + i
                        if yy < mh and ap[x, yy] < 128:
                            sd.point((x, yy), fill=(0, 0, 0,
                                                    int(CONTACT_ALPHA * (1 - i / CONTACT_H))))
                    faces += 1
                y += max(h, 1)
            else:
                y += 1
    img.alpha_composite(shade)
    img.alpha_composite(face_layer)

    # ── 5.5 캐릭터 위에 덮을 층 (벽면) ──────────────────────────────────────
    # 벽면은 벽 발치에서 **남쪽으로** 최대 FACE_H+걸레받이(15px ≈ 49cm) 더 그려진다.
    # 그 띠는 그림상 벽이지만 바닥이기도 하다 — 벽 앞 20cm 에 서는 건 정상이다.
    # 그래서 못 서게 막지 않고, **캐릭터보다 위에 다시 그린다**. 그러면 벽·안내데스크
    # 앞에 선 사람이 그 위에 올라탄 게 아니라 뒤에 서 있는 것으로 보인다.
    face_layer.save(OVER_OUT)
    print(f"saved {OVER_OUT}  (캐릭터 위에 덮을 벽면 층)")

    # 천장캡 — 벽을 위에서 본 윗면. 바닥에 붙은 벽에만 올린다 (샤프트 안쪽은 통제구역이라
    # 어두운 채로 남겨야 한다). 테두리는 시트의 외곽선 색으로 1px.
    near = Image.new("L", (walk.cols, walk.rows), 0)
    npx = near.load()
    for r in range(walk.rows):
        for c in range(walk.cols):
            if walk.grid[r][c] == "1":
                npx[c, r] = 255
    near = near.filter(ImageFilter.MaxFilter(WALL_REACH * 2 + 1))
    near = near.resize((mw, mh), Image.NEAREST)

    cap_mask = Image.new("L", (mw, mh), 0)
    cap_mask.paste(alpha, (0, 0), near)
    cap = Image.new("RGBA", (mw, mh), CAP_RGB + (255,))
    cap.putalpha(cap_mask)
    img.alpha_composite(cap)
    edge = Image.new("RGBA", (mw, mh), WALL_RGB + (255,))
    edge.putalpha(ImageChops.subtract(cap_mask, cap_mask.filter(ImageFilter.MinFilter(3))))
    img.alpha_composite(edge)

    # ── 6. 손님 통제구역 — **벽까지 덮어** 한 덩어리로 ──────────────────────
    # 벽보다 먼저 칠하면 검은 바닥 위로 벽선이 그대로 지나가 어색하다. 벽을 다 그린
    # 뒤에 덮는다.
    #
    # 색은 **벽 윗면(천장)과 같은 것**을 쓴다. 검게 두면 손님 화면에 구멍이 뚫린 것처럼
    # 보인다 — 이 구역은 구멍이 아니라 **막힌 덩어리**여야 자연스럽다. 벽과 같은 색에
    # 같은 테두리를 두르면 큰 벽 하나로 읽힌다.
    staff_mask_path = os.path.join(CFG, "staff-area.json")
    if os.path.exists(staff_mask_path):
        sm = json.load(open(staff_mask_path, encoding="utf-8"))
        smask = Image.new("L", img.size, 0)
        sdraw = ImageDraw.Draw(smask)
        n_staff = 0
        cpx2 = walk.cell * MAP_SCALE
        for r in range(min(sm["rows"], walk.rows)):
            row = sm["grid"][r]
            c = 0
            while c < min(sm["cols"], walk.cols):
                if row[c] != "1":
                    c += 1
                    continue
                s0 = c
                while c < min(sm["cols"], walk.cols) and row[c] == "1":
                    n_staff += 1
                    c += 1
                sdraw.rectangle(
                    [int(s0 * cpx2), int(r * cpx2), int(c * cpx2) - 1, int((r + 1) * cpx2) - 1],
                    fill=255,
                )
        if n_staff:
            solid = Image.new("RGBA", img.size, CAP_RGB + (255,))
            solid.putalpha(smask)
            img.alpha_composite(solid)
            # 벽과 같은 테두리 — 벽 그리는 마지막 단계와 같은 처리다
            edge = ImageChops.subtract(smask, smask.filter(ImageFilter.MinFilter(3)))
            rim = Image.new("RGBA", img.size, WALL_RGB + (255,))
            rim.putalpha(edge)
            img.alpha_composite(rim)
        print(f"손님 통제구역: {n_staff}칸 (벽 윗면 색으로 덮음)")

    # 타일 격자 크기 그대로 저장한다 (도면 크기로 자르면 마지막 타일이 잘린다)
    img.save(OUT)
    print(f"saved {OUT}  {img.size}  tiles {tw}x{th}  (도면 x{MAP_SCALE} · 타일 {TILE_FP}도면px {TILE_FP*1.62:.0f}cm)")
    print(f"건물 밖 셀: {void_cells}")
    print("재질별 방 수:", dict(sorted(counts.items(), key=lambda kv: -kv[1])))


if __name__ == "__main__":
    main()
