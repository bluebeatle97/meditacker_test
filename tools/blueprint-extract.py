#!/usr/bin/env python3
"""설계도면(벡터 PDF) → 벽·문·방·2.5D 색 지도.

    python tools/blueprint-extract.py <도면.pdf> --out <폴더> --mm-per-px 19.779
    python tools/blueprint-extract.py <도면.pdf> --out <폴더>          # 축척 자동(치수 사슬)

## 이 도구가 서 있는 자리

기존 파이프라인(`build-maps.py`)은 **벽 마스크를 사람이 준다**는 전제로 시작한다. 이 도구는
그 앞단 — 설계도면에서 벽 마스크를 뽑는 부분이다. 벡터 PDF 에 CAD 레이어가 살아 있을 때만
쓴다(래스터 스캔은 거부한다. 억지로 뽑으면 테두리와 기둥만 나온 그림이 '그럴듯하게' 나와서
한참 뒤에 틀린 걸 발견한다 — 실제로 그랬다).

## 단계와 게이트

    ① 레이어 분리      이름이 아니라 역할로 (F-WALL*/DOOR/WIN 을 정규식으로 후보 삼고 확인)
    ② 벽 골조          레이어 렌더 + 이중선 사이 좁은 틈 채움
    ③ 샤프트 분리      두께가 벽 상한(500mm)을 넘으면 벽이 아니다 — 계단·엘리베이터 코어
    ④ 창문 봉함        창은 외벽에 난 구멍이다. 안 막으면 건물 경계가 열린다
    ⑤ 문 잇기          문 위치는 **탐색 힌트로만** 쓰고 양쪽 벽 끝점을 잇는다
    ⑥ 방 판정 (게이트)  방이 갈라지지 않으면 앞 단계가 실패한 것이다 → 0 이 아닌 코드로 종료
    ⑦ 2.5D 색 지도     세 부류(벽·문·샤프트)가 각각 윗면/정면 두 색을 갖는다

## 두 가지 핵심 결정 (둘 다 실패를 거쳐 나왔다)

**문은 문짝 위치로 만들지 않는다.** 도면은 문을 **열린 상태**로 그린다 — 슬라이딩이 벽 속
포켓에 들어가 있어서 문틀 자리는 빈 구멍이고 문짝은 그 옆에 있다. 문짝 위치를 문틀로 쓰면
어긋난다(세 번 틀렸다). 대신 문짝 주변에서 **벽 덩어리 두 개**를 찾아 가장 가까운 두 점을
잇는다. 추측이 없으므로 어긋날 여지가 없다 — 방 1개 → 27개가 이 변경 하나로 갈렸다.

**정면 깊이는 두께가 아니라 높이에서 나온다.** 119mm 가벽과 336mm 구조벽은 둘 다 천장까지
올라가므로 겉보기 높이가 같다. 두께 배수로 잡았다가 얇은 벽이 낮아져 갈아엎었다.
깊이 = 실제 높이 × projectionFactor (wall-standards.json).

## 사람이 고치는 지점은 문 하나다

⑤의 결과를 **사람이 칠하는 그림과 같은 형식**(`floorplan-door.png`, `#ED1C24` 채움)으로
낸다. 그래서 사람은 빠진 문을 칠하고 잘못된 문을 지우기만 하면 되고, 뒷단은 손댈 필요가 없다.
`door-review.png` 에 상태를 색으로 표시한다 — 초록 확정 / 노랑 의심 / 빨강 실패.
"""
import argparse
import json
import os
import re
import sys
from collections import deque

try:
    import fitz
except ImportError:
    sys.exit("PyMuPDF 가 필요하다: pip install pymupdf")
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STD = os.path.join(ROOT, "tools", "wall-standards.json")

WALL_RE = re.compile(r"WALL|벽", re.I)
DOOR_RE = re.compile(r"DOOR|문", re.I)
WIN_RE = re.compile(r"WIN|창", re.I)
TEXT_RE = re.compile(r"TEXT|문자", re.I)

RED = (237, 28, 36)          # build-doors.py 가 읽는 문 색
FLOOR, TOP, FACE = (0, 255, 0), (0, 0, 255), (255, 0, 0)
DTOP, DFACE = (255, 165, 0), (255, 105, 180)
STOP, SFACE = (150, 70, 200), (90, 30, 140)
OUT_C = (0, 0, 0)


def pick_layers(doc):
    """레이어 이름으로 후보를 나눈다. 이름은 힌트이고, 확인은 ⑥ 게이트가 한다."""
    names = [it["text"] for it in doc.layer_ui_configs()]
    wall = {n for n in names if WALL_RE.search(n)}
    door = {n for n in names if DOOR_RE.search(n)}
    win = {n for n in names if WIN_RE.search(n)}
    text = {n for n in names if TEXT_RE.search(n)}
    return wall, door, win, text, names


def render(path, keep, dpi, thr):
    d = fitz.open(path)
    for it in d.layer_ui_configs():
        d.set_layer_ui_config(it["number"], action=0 if it["text"] in keep else 1)
    pix = d[0].get_pixmap(dpi=dpi)
    im = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
    g = im.convert("L")
    W, H = g.size
    p = g.load()
    m = bytearray(W * H)
    for y in range(H):
        for x in range(W):
            if p[x, y] < thr:
                m[y * W + x] = 1
    return m, W, H, im


def comps(src, W, H, minsz=20):
    seen = bytearray(W * H)
    out = []
    nb = ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (-1, -1), (1, -1), (-1, 1))
    for y0 in range(H):
        for x0 in range(W):
            if not src[y0 * W + x0] or seen[y0 * W + x0]:
                continue
            q = deque([(x0, y0)])
            seen[y0 * W + x0] = 1
            pts = []
            while q:
                x, y = q.popleft()
                pts.append((x, y))
                for dx, dy in nb:
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < W and 0 <= ny < H and src[ny * W + nx] and not seen[ny * W + nx]:
                        seen[ny * W + nx] = 1
                        q.append((nx, ny))
            if len(pts) >= minsz:
                out.append(pts)
    return out


def runs(src, W, H):
    """픽셀마다 가로·세로 연속 길이. min 이 그 픽셀이 속한 구조물의 두께다."""
    hr, vr = bytearray(W * H), bytearray(W * H)
    for y in range(H):
        x = 0
        while x < W:
            if src[y * W + x]:
                s = x
                while x < W and src[y * W + x]:
                    x += 1
                L = min(x - s, 255)
                for i in range(s, x):
                    hr[y * W + i] = L
            else:
                x += 1
    for x in range(W):
        y = 0
        while y < H:
            if src[y * W + x]:
                s = y
                while y < H and src[y * W + x]:
                    y += 1
                L = min(y - s, 255)
                for i in range(s, y):
                    vr[i * W + x] = L
            else:
                y += 1
    return hr, vr


def flood_regions(bar, W, H, min_cells):
    """(바깥 칸수, [방 칸수…], 라벨) — 라벨 1=바깥, 2=실내"""
    lab = bytearray(W * H)

    def go(sx, sy, tag):
        q = deque([(sx, sy)])
        lab[sy * W + sx] = tag
        c = 0
        while q:
            x, y = q.popleft()
            c += 1
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                nx, ny = x + dx, y + dy
                if 0 <= nx < W and 0 <= ny < H and not lab[ny * W + nx] and not bar[ny * W + nx]:
                    lab[ny * W + nx] = tag
                    q.append((nx, ny))
        return c

    outside = go(0, 0, 1)
    rooms = []
    for y in range(H):
        for x in range(W):
            if not bar[y * W + x] and not lab[y * W + x]:
                c = go(x, y, 2)
                if c >= min_cells:
                    rooms.append(c)
    return outside, sorted(rooms, reverse=True), lab


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf")
    ap.add_argument("--out", required=True, help="산출물 폴더")
    ap.add_argument("--dpi", type=float, default=150)
    ap.add_argument("--mm-per-px", type=float, default=None,
                    help="축척. 생략하면 blueprint-scale.py 로 먼저 확정할 것")
    ap.add_argument("--standards", default=STD)
    ap.add_argument("--search", type=int, default=55, help="문 주변에서 벽을 찾을 반경(px)")
    args = ap.parse_args()

    if not os.path.exists(args.pdf):
        sys.exit(f"도면이 없다: {args.pdf}")
    os.makedirs(args.out, exist_ok=True)
    std = json.load(open(args.standards, encoding="utf-8"))
    h = std["heights"]
    proj, ceil_mm, door_mm = h["projectionFactor"], h["ceilingMm"], h["doorMm"]
    shaft_mm = h.get("shaftMm", h["ceilingMm"])
    tbl_max = max(w["mm"] for w in std["walls"])

    doc = fitz.open(args.pdf)
    if not doc.get_ocgs():
        sys.exit("CAD 레이어(OCG)가 없다 — 이 도구는 벡터 레이어 도면만 다룬다.\n"
                 "래스터 스캔은 자동 추출이 신뢰할 수 없으므로 사람이 벽을 칠하는 쪽이 맞다.")
    wl, dl, wnl, txl, allnames = pick_layers(doc)
    print(f"[1] 레이어 {len(allnames)}개 · 벽 {sorted(wl)} · 문 {sorted(dl)} · 창 {sorted(wnl)}")
    if not wl or not dl:
        sys.exit("벽 또는 문 레이어를 못 찾았다 — --standards 로 후보를 넓히거나 이름을 확인할 것")

    mmpx = args.mm_per_px
    if mmpx is None:
        sys.exit("축척(--mm-per-px)이 필요하다. tools/blueprint-scale.py 로 먼저 확정할 것.\n"
                 "축척 없이는 모든 문턱이 근거 없는 픽셀값이 된다.")
    print(f"    축척 {mmpx:.3f} mm/px")

    raw, W, H, _ = render(args.pdf, wl, args.dpi, 128)
    win, _, _, _ = render(args.pdf, wnl, args.dpi, 215) if wnl else (bytearray(W * H), W, H, None)
    door, _, _, _ = render(args.pdf, dl, args.dpi, 128)
    _, _, _, plan = render(args.pdf, wl | dl | wnl | txl, args.dpi, 128)
    print(f"[2] 벽 골조 {sum(raw)/(W*H)*100:.1f}% · 창 {sum(win):,}px · 문 {sum(door):,}px")

    # ④ 창문 봉함 — 덩어리 bbox 를 채운다. 창은 외벽 라인을 따라 조각으로 떨어져 있어
    #    bbox 가 곧 그 구간의 벽이 된다 (벽은 전부 이어져 있어 같은 방법이 안 통한다)
    nwin = 0
    for pts in comps(win, W, H):
        nwin += 1
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        for yy in range(min(ys), max(ys) + 1):
            for xx in range(min(xs), max(xs) + 1):
                raw[yy * W + xx] = 1
    # 이중선 사이 좁은 틈
    lab = bytearray(W * H)

    def fl(sx, sy, tag):
        q = deque([(sx, sy)])
        lab[sy * W + sx] = tag
        cells = [(sx, sy)]
        while q:
            x, y = q.popleft()
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                nx, ny = x + dx, y + dy
                if 0 <= nx < W and 0 <= ny < H and not lab[ny * W + nx] and not raw[ny * W + nx]:
                    lab[ny * W + nx] = tag
                    q.append((nx, ny))
                    cells.append((nx, ny))
        return cells

    fl(0, 0, 1)
    for y in range(H):
        for x in range(W):
            if not raw[y * W + x] and not lab[y * W + x]:
                cells = fl(x, y, 2)
                if len(cells) < 1500:
                    for cx, cy in cells:
                        raw[cy * W + cx] = 1
    print(f"[4] 창문 {nwin}곳 봉함 → 벽 {sum(raw)/(W*H)*100:.1f}%")

    # ③ 샤프트 분리 — 두께가 표의 상한을 넘으면 벽이 아니다
    hr, vr = runs(raw, W, H)
    lim = int((tbl_max + 100) / mmpx)
    shaft, wall = bytearray(W * H), bytearray(W * H)
    for i in range(W * H):
        if not raw[i]:
            continue
        (shaft if min(hr[i], vr[i]) > lim else wall)[i] = 1
    sh2 = bytearray(W * H)
    nsh = 0
    for pts in comps(shaft, W, H, minsz=400):
        nsh += 1
        for x, y in pts:
            sh2[y * W + x] = 1
    for i in range(W * H):
        if shaft[i] and not sh2[i]:
            wall[i] = 1
    shaft = sh2
    print(f"[3] 샤프트 {nsh}덩어리 {sum(shaft)*mmpx**2/1e6:.0f}m² 분리 "
          f"(두께 {tbl_max+100}mm 초과) · 벽 {sum(wall)/(W*H)*100:.1f}%")

    # ⑤ 문 잇기 — 문 위치는 힌트, 실제로는 양쪽 벽 끝점을 잇는다
    leaves = comps(door, W, H, minsz=30)
    lo, hi = 600 / mmpx, 1500 / mmpx
    thick = max(3, round(140 / mmpx))
    bridges, review = [], []
    for n, pts in enumerate(leaves, 1):
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        cx, cy = (min(xs) + max(xs)) // 2, (min(ys) + max(ys)) // 2
        x0, x1 = max(0, cx - args.search), min(W, cx + args.search)
        y0, y1 = max(0, cy - args.search), min(H, cy + args.search)
        sw = x1 - x0
        sub = bytearray(sw * (y1 - y0))
        for y in range(y0, y1):
            for x in range(x0, x1):
                if wall[y * W + x]:
                    sub[(y - y0) * sw + (x - x0)] = 1
        gs = comps(sub, sw, y1 - y0, minsz=12)
        if len(gs) < 2:
            review.append({"n": n, "x": cx, "y": cy, "status": "fail",
                           "why": "양쪽 벽을 못 찾음 — 사람이 칠해야 한다"})
            continue
        gs.sort(key=lambda g: min((px + x0 - cx) ** 2 + (py + y0 - cy) ** 2 for px, py in g))
        best = None
        for ax, ay in gs[0]:
            for bx, by in gs[1]:
                d2 = (ax - bx) ** 2 + (ay - by) ** 2
                if best is None or d2 < best[0]:
                    best = (d2, (ax + x0, ay + y0), (bx + x0, by + y0))
        gap = best[0] ** 0.5
        st = "ok" if lo <= gap <= hi else "suspect"
        review.append({"n": n, "x": cx, "y": cy, "status": st,
                       "why": "" if st == "ok" else f"간격 {gap*mmpx:.0f}mm (문 폭 600~1500 밖)"})
        bridges.append((best[1], best[2]))

    dimg = Image.new("L", (W, H), 0)
    dd = ImageDraw.Draw(dimg)
    for a, b in bridges:
        dd.line([a, b], fill=255, width=thick)
    dp = dimg.load()
    doorm = bytearray(W * H)
    for y in range(H):
        for x in range(W):
            if dp[x, y] >= 128 and not wall[y * W + x] and not shaft[y * W + x]:
                doorm[y * W + x] = 1
    nok = sum(1 for r in review if r["status"] == "ok")
    nsus = sum(1 for r in review if r["status"] == "suspect")
    nbad = sum(1 for r in review if r["status"] == "fail")
    print(f"[5] 문 {len(review)}개 → 확정 {nok} · 의심 {nsus} · 실패 {nbad}")
    for r in review:
        if r["status"] != "ok":
            print(f"      #{r['n']:2} @({r['x']},{r['y']})  {r['why']}")

    # 사람이 고치는 파일 + 검토 그림
    edit = plan.copy()
    de = ImageDraw.Draw(edit)
    for a, b in bridges:
        de.line([a, b], fill=RED, width=thick)
    edit.save(os.path.join(args.out, "floorplan-door.png"))
    vis = Image.new("RGB", (W, H), (16, 18, 22))
    vp = vis.load()
    for y in range(H):
        for x in range(W):
            if wall[y * W + x]:
                vp[x, y] = (150, 156, 165)
            elif shaft[y * W + x]:
                vp[x, y] = (90, 60, 120)
    dv = ImageDraw.Draw(vis)
    COL = {"ok": (60, 220, 130), "suspect": (250, 205, 60), "fail": (255, 80, 80)}
    for (a, b), r in zip(bridges, [r for r in review if r["status"] != "fail"]):
        dv.line([a, b], fill=COL[r["status"]], width=thick)
    for r in review:
        c = COL[r["status"]]
        dv.ellipse([r["x"] - 15, r["y"] - 15, r["x"] + 15, r["y"] + 15], outline=c, width=3)
        dv.text((r["x"] - 5, r["y"] - 6), str(r["n"]), fill=c)
    vis.save(os.path.join(args.out, "door-review.png"))

    # ⑥ 방 판정 게이트
    bar = bytearray(W * H)
    for i in range(W * H):
        bar[i] = 1 if (wall[i] or shaft[i] or doorm[i]) else 0
    min_cells = int(2_000_000 / (mmpx ** 2))
    outside, rooms, lab2 = flood_regions(bar, W, H, min_cells)
    area = lambda c: c * mmpx ** 2 / 1e6
    print(f"[6] 방 {len(rooms)}개 · 방면적 {area(sum(rooms)):.0f}m² · 바깥 {area(outside):.0f}m²")
    if rooms:
        print("      큰 방: " + ", ".join(f"{area(s):.0f}" for s in rooms[:10]) + " m²")

    # 산출물
    def save_mask(mask, name):
        im = Image.new("L", (W, H), 0)
        p = im.load()
        for y in range(H):
            for x in range(W):
                if mask[y * W + x]:
                    p[x, y] = 255
        im.save(os.path.join(args.out, name))

    save_mask(wall, "wall-mask.png")
    save_mask(shaft, "shaft-mask.png")
    outside_mask = bytearray(W * H)
    for i in range(W * H):
        outside_mask[i] = 1 if lab2[i] == 1 else 0
    save_mask(outside_mask, "outside-mask.png")

    # ⑦ 2.5D — 깊이는 높이 x 투영계수 (두께가 아니다)
    solid = bytearray(W * H)
    for i in range(W * H):
        solid[i] = 1 if (wall[i] or shaft[i] or doorm[i]) else 0
    tile = Image.new("RGB", (W, H), OUT_C)
    tp = tile.load()
    for y in range(H):
        for x in range(W):
            i = y * W + x
            if shaft[i]:
                tp[x, y] = STOP
            elif doorm[i]:
                tp[x, y] = DTOP
            elif wall[i]:
                tp[x, y] = TOP
            elif lab2[i] == 1:
                tp[x, y] = OUT_C
            else:
                tp[x, y] = FLOOR
    depth_of = lambda mm: max(1, int(round(mm * proj / mmpx)))
    wall_depth, door_depth, shaft_depth = (
        depth_of(ceil_mm), depth_of(door_mm), depth_of(shaft_mm))
    # 윗면 색 → (정면 색, 정면 깊이). 샤프트도 천장까지 올라가므로 벽과 같은 높이다 —
    # 색을 벽 정면(빨강)과 나눠 두면 아트가 벽면과 코어(엘리베이터 문·계단)를 갈라 깐다.
    KIND = {"door": (DFACE, door_depth), "shaft": (SFACE, shaft_depth),
            "wall": (FACE, wall_depth)}
    for y in range(H):
        x = 0
        while x < W:
            south = solid[y * W + x] and (y + 1 >= H or not solid[(y + 1) * W + x])
            if not south:
                x += 1
                continue
            s0 = x
            while x < W and solid[y * W + x] and (y + 1 >= H or not solid[(y + 1) * W + x]):
                x += 1
            run = list(range(s0, x))
            # 조각 하나에 색 하나 — 픽셀별로 고르면 접합부에서 정면이 톱니가 된다
            n = {k: 0 for k in KIND}
            for i in run:
                j = y * W + i
                n["door" if doorm[j] else "shaft" if shaft[j] else "wall"] += 1
            col, depth = KIND[max(n, key=lambda k: n[k])]
            for i in run:
                for k in range(y + 1, min(H, y + 1 + depth)):
                    if not solid[k * W + i] and lab2[k * W + i] != 1:
                        tp[i, k] = col
    tile.save(os.path.join(args.out, "tiling-map.png"))
    print(f"[7] 2.5D 저장 · 벽 정면 {wall_depth}px({ceil_mm}mm x {proj}) · "
          f"문 {door_depth}px · 샤프트 {shaft_depth}px")

    json.dump({
        "pdf": os.path.basename(args.pdf), "dpi": args.dpi, "mmPerPx": mmpx,
        "layers": {"wall": sorted(wl), "door": sorted(dl), "window": sorted(wnl)},
        "shaftPieces": nsh, "shaftM2": round(area(sum(shaft)), 1),
        "doors": {"total": len(review), "ok": nok, "suspect": nsus, "fail": nbad},
        "rooms": {"count": len(rooms), "m2": round(area(sum(rooms)), 1)},
        "review": review, "gatePassed": len(rooms) > 1,
    }, open(os.path.join(args.out, "extract-summary.json"), "w", encoding="utf-8"),
        ensure_ascii=False, indent=2)

    if len(rooms) <= 1:
        print("\n[중단] 방 판정 실패 — 방이 갈라지지 않았다.")
        print("   벽·창문·문 중 어딘가가 새고 있다. door-review.png 의 빨강/노랑을")
        print("   floorplan-door.png 에서 고친 뒤 다시 돌릴 것.")
        sys.exit(2)
    print("\n[통과] 방 판정 게이트. 사람이 볼 곳은 door-review.png 의 빨강/노랑뿐이다.")


if __name__ == "__main__":
    main()
