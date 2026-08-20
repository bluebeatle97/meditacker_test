#!/usr/bin/env python3
"""사람이 문까지 칠한 2D 도면 → 2.5D 색 지도. (`blueprint-extract.py` 의 ②~⑦ 를 래스터로)

    python tools/plan-to-tiling.py                    # 원내 설정 폴더에 바로 쓴다
    python tools/plan-to-tiling.py --dry-run --out-dir <폴더>

## 이 도구가 서 있는 자리

`blueprint-extract.py` 는 **벡터 PDF + CAD 레이어** 를 받아 ①레이어 분리부터 돈다. 이
도구는 그 앞 두 단계(레이어 분리, 문 잇기)가 **이미 끝나 있을 때** 쓴다:

    floorplan-door.png = 2D 도면 + 사람이 칠한 빨강 문막대(#ED1C24)

즉 ⑤ 문 잇기를 사람이 손으로 확정한 상태다. 추측이 없으니 ②③⑥⑦ 만 돌리면 된다.

## 왜 이 래스터는 받아도 되는가

`blueprint-extract.py` 는 래스터를 **거부한다** — 스캔은 벽과 가구가 같은 얇은 선이라
두께로 가릴 수 없고, 억지로 뽑으면 테두리와 기둥만 나온 그림이 그럴듯해서 한참 뒤에
틀린 걸 발견한다(실제로 그랬다).

이 파일은 스캔이 아니다. 벡터에서 뽑은 **색이 양자화된** 도면이라 골조와 바닥이 색으로
정확히 갈린다:

    흰 (255)         바닥 — 유일하게 비어 있는 색
    그 밖의 모든 색   골조. 이 도면은 구조를 **어두운 외곽선 + 회색 채움**으로 그린다
    빨강 (237,28,36) 문 — 사람이 칠한 것

⚠️ **외곽선과 채움을 색으로 가르면 안 된다.** 처음에 회색을 샤프트로, 어두운 선을 벽으로
   잡았다가 벽 속이 보라색이 됐다 — 벽도 회색 채움에 어두운 외곽선이라 같은 규칙에 걸린다.
   외곽선은 자기가 감싼 것에 속한다. 그래서 **흰색이 아니면 다 골조**로 묶고, 부류는
   아래 ③에서 두께로 가른다 (`blueprint-extract.py` 와 같은 규칙).

## 정면 깊이는 두께가 아니라 높이에서 나온다

`wall-standards.json` 의 `heights` 를 쓴다. 146mm 가벽과 300mm 구조벽은 둘 다 천장까지
올라가므로 겉보기 높이가 같다 — 두께 배수로 잡았다가 얇은 벽이 낮아져 갈아엎었다.

    깊이 = 실제 높이(mm) x projectionFactor / mmPerPx

## 게이트

⑥ 방 판정이 실패하면(방이 1개 이하) **0 이 아닌 코드로 멈춘다.** 방이 갈라지지 않으면
벽이나 문 어딘가가 새고 있다는 뜻이고, 그 상태로 2.5D 를 내면 틀린 그림이 그럴듯하게
나온다. `floorplan-door.png` 에 빠진 문을 칠하고 다시 돌리는 게 순서다.
"""
import argparse
import json
import os
import sys
from collections import deque

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CFG = os.path.join(ROOT, "packages", "server", "src", "config")
STD = os.path.join(ROOT, "tools", "wall-standards.json")

# 색표 — blueprint-extract.py 와 같은 값이어야 한다. 받는 쪽이 두 도구를 구분하지 않는다.
FLOOR, TOP, FACE = (0, 255, 0), (0, 0, 255), (255, 0, 0)
DTOP, DFACE = (255, 165, 0), (255, 105, 180)
STOP, SFACE = (150, 70, 200), (90, 30, 140)
FTOP, FFACE = (0, 200, 255), (0, 110, 160)
OUT_C = (0, 0, 0)


def is_red(p):
    return p[0] > 140 and p[1] < 110 and p[2] < 110


def flood_regions(bar, W, H, min_cells):
    """막힌 것 밖에서 흘려 바깥을 찾고, 남은 빈칸을 방으로 센다. lab: 1=바깥 2+=방"""
    lab = bytearray(W * H)
    q = deque()
    for x in range(W):
        for y in (0, H - 1):
            if not bar[y * W + x] and not lab[y * W + x]:
                lab[y * W + x] = 1
                q.append((x, y))
    for y in range(H):
        for x in (0, W - 1):
            if not bar[y * W + x] and not lab[y * W + x]:
                lab[y * W + x] = 1
                q.append((x, y))
    outside = 0
    while q:
        x, y = q.popleft()
        outside += 1
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if 0 <= nx < W and 0 <= ny < H and not bar[ny * W + nx] and not lab[ny * W + nx]:
                lab[ny * W + nx] = 1
                q.append((nx, ny))
    rooms, tag = [], 1
    for y0 in range(H):
        for x0 in range(W):
            if bar[y0 * W + x0] or lab[y0 * W + x0]:
                continue
            tag += 1
            q = deque([(x0, y0)])
            lab[y0 * W + x0] = min(tag, 255)
            n = 0
            while q:
                x, y = q.popleft()
                n += 1
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nx, ny = x + dx, y + dy
                    if (0 <= nx < W and 0 <= ny < H and not bar[ny * W + nx]
                            and not lab[ny * W + nx]):
                        lab[ny * W + nx] = min(tag, 255)
                        q.append((nx, ny))
            if n >= min_cells:
                rooms.append(n)
    rooms.sort(reverse=True)
    return outside, rooms, lab


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config-dir", default=CFG, help="입력을 둘 폴더")
    ap.add_argument("--out-dir", default=None, help="산출물을 둘 폴더 (기본 = --config-dir)")
    ap.add_argument("--mm-per-px", type=float, default=16.2,
                    help="축척. 기본 16.2 는 build-doors.py 의 CM_PER_PX 1.62 와 같다")
    ap.add_argument("--solid-thr", type=int, default=230,
                    help="이보다 어두우면 골조. 흰 바닥(255)과 회색 채움(153) 사이 아무 값")
    ap.add_argument("--shaft-mm", type=float, default=500,
                    help="두께가 이보다 두꺼우면 벽이 아니다 — 계단·엘리베이터 코어. "
                         "wall-standards.json 의 벽 상한 400mm 에 여유를 준 값")
    ap.add_argument("--min-room-m2", type=float, default=2.0,
                    help="이보다 작은 빈칸은 방으로 세지 않는다")
    ap.add_argument("--dry-run", action="store_true", help="tiling-map.png 을 쓰지 않는다")
    args = ap.parse_args()
    out_dir = args.out_dir or args.config_dir

    h = json.load(open(STD, encoding="utf-8"))["heights"]
    proj = h["projectionFactor"]
    mmpx = args.mm_per_px

    plan_p = os.path.join(args.config_dir, "floorplan-door.png")
    out_p = os.path.join(args.config_dir, "outside-mask.png")
    fur_p = os.path.join(args.config_dir, "furniture-mask.png")
    for p in (plan_p, out_p):
        if not os.path.exists(p):
            sys.exit(f"입력이 없다: {p}")

    plan = Image.open(plan_p).convert("RGB")
    outside_im = Image.open(out_p).convert("L")
    if plan.size != outside_im.size:
        sys.exit(f"크기가 다르다: {plan.size} vs {outside_im.size}")
    W, H = plan.size
    pp, op = plan.load(), outside_im.load()
    fur = None
    if os.path.exists(fur_p):
        f = Image.open(fur_p).convert("L")
        if f.size != (W, H):
            sys.exit(f"가구 마스크 크기가 다르다: {f.size} vs {(W, H)}")
        fur = f.load()

    # ── ② 골조 · ⑤ 문 — 흰색이 아니면 골조다. 외곽선/채움을 가르지 않는다 ────────
    solid = bytearray(W * H)
    door = bytearray(W * H)
    for y in range(H):
        for x in range(W):
            i = y * W + x
            if op[x, y] >= 128:          # 건물 밖 — 회색이 바깥에도 깔려 있어 먼저 뺀다
                continue
            p = pp[x, y]
            if is_red(p):
                door[i] = solid[i] = 1
                continue
            g = (p[0] * 299 + p[1] * 587 + p[2] * 114) // 1000
            if g < args.solid_thr:
                solid[i] = 1
    area = lambda c: c * mmpx ** 2 / 1e6
    print(f"[2] 골조 {sum(solid)*100/(W*H):.1f}% ({area(sum(solid)):.0f}m²) · "
          f"문 {area(sum(door)):.0f}m² (사람이 칠한 것 — 추측 없음)")

    # ── ③ 샤프트 분리 — 두께가 벽 상한을 넘으면 벽이 아니다 (blueprint-extract 와 같다) ──
    #
    # 두께 = min(가로연속, 세로연속). 가로 벽이면 세로연속이 두께이고 세로 벽이면 그 반대다.
    # 두 값의 작은 쪽을 쓰면 방향을 안 물어도 된다.
    hr, vr = bytearray(W * H), bytearray(W * H)
    for y in range(H):
        x = 0
        while x < W:
            if not solid[y * W + x]:
                x += 1
                continue
            s0 = x
            while x < W and solid[y * W + x]:
                x += 1
            L = min(x - s0, 255)
            for i in range(s0, x):
                hr[y * W + i] = L
    for x in range(W):
        y = 0
        while y < H:
            if not solid[y * W + x]:
                y += 1
                continue
            s0 = y
            while y < H and solid[y * W + x]:
                y += 1
            L = min(y - s0, 255)
            for i in range(s0, y):
                vr[i * W + x] = L
    lim = args.shaft_mm / mmpx
    wall, shaft, desk = bytearray(W * H), bytearray(W * H), bytearray(W * H)
    for i in range(W * H):
        if not solid[i] or door[i]:
            continue
        thick = min(hr[i], vr[i])
        if fur and fur[i % W, i // W] >= 128:
            desk[i] = 1
        elif thick > lim:
            shaft[i] = 1
        else:
            wall[i] = 1
    print(f"[3] 벽 {area(sum(wall)):.0f}m² · 샤프트 {area(sum(shaft)):.0f}m² "
          f"(두께 {args.shaft_mm:.0f}mm 초과) · 데스크 {area(sum(desk)):.0f}m²")

    # ── ⑥ 방 판정 게이트 ─────────────────────────────────────────────────────
    bar = solid
    _, rooms, lab = flood_regions(bar, W, H, int(args.min_room_m2 * 1e6 / mmpx ** 2))
    print(f"[6] 방 {len(rooms)}개 · 방면적 {area(sum(rooms)):.0f}m²")
    if rooms:
        print("      큰 방: " + ", ".join(f"{area(s):.0f}" for s in rooms[:10]) + " m²")
    if len(rooms) <= 1:
        print("\n[중단] 방 판정 실패 — 방이 갈라지지 않았다.")
        print("   floorplan-door.png 에 빠진 문을 #ED1C24 로 칠하고 다시 돌릴 것.")
        sys.exit(2)

    # ── ⑦ 2.5D — 깊이는 높이 x 투영계수 (두께가 아니다) ──────────────────────
    depth_of = lambda mm: max(1, int(round(mm * proj / mmpx)))
    KIND = {
        "door": (DTOP, DFACE, depth_of(h["doorMm"])),
        "desk": (FTOP, FFACE, depth_of(h["furnitureMm"])),
        "shaft": (STOP, SFACE, depth_of(h.get("shaftMm", h["ceilingMm"]))),
        "wall": (TOP, FACE, depth_of(h["ceilingMm"])),
    }
    cls = [None] * (W * H)
    for i in range(W * H):
        cls[i] = ("door" if door[i] else "desk" if desk[i]
                  else "shaft" if shaft[i] else "wall" if wall[i] else None)
    tile = Image.new("RGB", (W, H), OUT_C)
    tp = tile.load()
    for y in range(H):
        for x in range(W):
            i = y * W + x
            k = cls[i]
            tp[x, y] = KIND[k][0] if k else OUT_C if op[x, y] >= 128 else FLOOR

    # 남쪽 경계의 연속 구간을 **한 조각**으로 보고 조각마다 색·깊이를 하나 정한다.
    # 픽셀별로 고르면 접합부에서 정면이 톱니가 된다.
    for y in range(H):
        x = 0
        while x < W:
            if not (bar[y * W + x] and (y + 1 >= H or not bar[(y + 1) * W + x])):
                x += 1
                continue
            s0 = x
            while x < W and bar[y * W + x] and (y + 1 >= H or not bar[(y + 1) * W + x]):
                x += 1
            run = range(s0, x)
            n = {}
            for i in run:
                k = cls[y * W + i]
                n[k] = n.get(k, 0) + 1
            _, col, depth = KIND[max(n, key=lambda k: n[k])]
            for i in run:
                for yy in range(y + 1, min(H, y + 1 + depth)):
                    j = yy * W + i
                    if not bar[j] and op[i, yy] < 128:
                        tp[i, yy] = col
    lines = [f"[7] 2.5D · " + " · ".join(
        f"{k} {KIND[k][2]}px" for k in ("wall", "door", "shaft", "desk"))]
    from collections import Counter
    cnt = Counter(tile.get_flattened_data())
    tot = W * H
    NAME = {FLOOR: "초록 바닥", TOP: "파랑 벽윗면", FACE: "빨강 벽정면",
            DTOP: "주황 문윗면", DFACE: "핫핑크 문정면", STOP: "보라 샤프트윗면",
            SFACE: "진보라 샤프트정면", FTOP: "하늘 데스크윗면", FFACE: "감청 데스크정면",
            OUT_C: "검정 건물밖"}
    for c, k in sorted(cnt.items(), key=lambda kv: -kv[1]):
        lines.append(f"      {NAME.get(c, str(c)):<18} {k:9,}px ({k/tot*100:5.2f}%)")
    print("\n".join(lines))

    if args.dry_run:
        print("\n--dry-run — 쓰지 않았다")
        return
    dst = os.path.join(out_dir, "tiling-map.png")
    tile.save(dst)
    print(f"\nsaved {dst}")
    print("[통과] 방 판정 게이트")


if __name__ == "__main__":
    main()
