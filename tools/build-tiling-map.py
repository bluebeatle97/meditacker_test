#!/usr/bin/env python3
"""바닥·벽·벽 윗면을 색으로 갈라 놓은 지도 — 에셋 자동 배치용 입력.

    python tools/build-tiling-map.py [--face 24] [--desk-face 8]

입력:  packages/server/src/config/wall-mask.png       (흰색 = 벽)
       packages/server/src/config/outside-mask.png    (흰색 = 건물 밖)
       packages/server/src/config/furniture-mask.png  (흰색 = 가구, 선택)
       packages/server/src/config/door.json           (문 사각형, 선택)
출력:  packages/server/src/config/tiling-map.png

## 왜 마스크로 충분한가

`wall.png`(사람이 그린 2.5D 그림)는 명도가 205단계지만 그 음영은 **사람 눈을 위한 것**이다.
에셋을 깔 때 필요한 건 "여기는 바닥, 여기는 벽" 이라는 경계뿐이고, 그건 마스크에 다 있다.
실측으로 마스크의 벽 두께 중앙값이 40px 인데 평면상 벽은 15px 남짓이라, **마스크가 이미
윗면 + 정면을 합친 골조**를 담고 있다.

## 색

    초록     (0,255,0)     바닥 — 타일을 깐다
    빨강     (255,0,0)     벽 정면 — 세로로 서서 보이는 면
    파랑     (0,0,255)     벽 윗면 — 천장과 맞닿는 면
    주황     (255,165,0)   문 윗면 — 문틀 위, 천장과 맞닿는 면
    핫핑크   (255,105,180) 문 정면 — 문짝이 서서 보이는 면
    검정     (0,0,0)       건물 밖 — 아무것도 깔지 않는다

문도 **벽과 똑같이 윗면/정면으로 갈린다.** 문은 벽 높이의 개구부라 위에서 내려다볼 때
벽과 같은 입체로 보인다 — 한 색으로 칠하면 받는 쪽이 문짝과 문틀 위를 구분할 수 없다.
판정은 아래의 같은 규칙을 쓰고, 그러려면 문을 **벽과 함께 solid 로 묶어** 거리를 재야 한다
(문만 따로 재면 벽에 난 틈이라 두께가 0 이 되어 전부 정면으로 찍힌다).

순수 원색만 쓴다. 중간색을 섞으면 받는 쪽이 임계값을 정해야 하고, 그 임계값이 또 하나의
합의 사항이 된다 — 색을 정확히 비교하면 끝나게 둔다.

## 정면과 윗면을 가르는 기준 — **남쪽에 바닥이 있는가**

처음엔 "위 가장자리에서 N px" 를 윗면으로 잡았다가 갈아엎었다. 그 규칙은 **세로 벽에서
틀린다** — 북쪽 끝만 윗면이 되고 긴 몸통이 전부 정면으로 찍혀서, 위에서 내려다보면
윗면이어야 할 자리에 벽면 타일이 깔린다.

2.5D 에서 정면이 보이는 건 **그 아래에 바닥이 있을 때뿐**이다. 그래서 벽 픽셀에서
**아래로** 내려가 벽이 끝날 때까지의 거리가 `--face` 이하면 정면, 나머지는 전부 윗면이다.

    가로 벽        → 아래 띠가 정면, 위쪽은 윗면
    세로 벽        → 남쪽 끝만 정면, 긴 몸통은 윗면
    양쪽이 바닥인 벽 → 북쪽은 윗면, 남쪽은 정면

즉 **윗면이 기본이고 정면이 예외**다.

## 가구는 벽보다 낮다

안내데스크는 벽이 아니라 곡선 책상이다. 벽과 같은 높이로 치면 정면이 너무 넓게 잡혀
책상 상판이 사라진다 — 위에서 보면 상판(윗면)이 넓게 보여야 한다. `furniture-mask.png`
에 칠해 둔 곳은 `--desk-face` 만큼만 정면으로 잡는다.

⚠️ 가구는 **자동으로 못 가려낸다.** 안내데스크 곡선이 주변 벽과 같은 연결 덩어리라
   (실측 확인) 형태·연결로는 갈리지 않는다. 손으로 칠한 마스크가 유일한 방법이다 —
   `staff-area.png` 를 손으로 칠하는 것과 같은 이유다.
"""
import argparse
import json
import os
import sys

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CFG = os.path.join(ROOT, "packages", "server", "src", "config")

FLOOR = (0, 255, 0)
FACE = (255, 0, 0)
TOP = (0, 0, 255)
DOOR_TOP = (255, 165, 0)      # 주황 — 문 윗면(2D 평면에서 보이는 문틀 위)
DOOR_FACE = (255, 105, 180)   # 핫핑크 — 문짝이 서서 보이는 면
OUTSIDE = (0, 0, 0)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--face", type=int, default=24, help="벽 정면으로 볼 띠 두께(px)")
    ap.add_argument("--desk-face", type=int, default=8, help="가구 정면 띠 두께(px)")
    ap.add_argument("--door-face", type=int, default=24,
                    help="문 정면 띠 두께(px). 문은 벽 높이라 기본은 --face 와 같게 둔다")
    ap.add_argument("--extrude", action="store_true",
                    help="평면 마스크를 2.5D 로 밀어낸다. 깊이는 **그 벽 두께 x faceRatio** 다 "
                         "(wall-standards.json). 주지 않으면 마스크에 이미 높이가 들어 있다고 "
                         "보고 두께를 갈라 쓴다 (손으로 그린 wall.png 계열)")
    ap.add_argument("--face-ratio", type=float, default=None,
                    help="정면 깊이 / 벽 두께. 기본은 wall-standards.json 의 faceRatio")
    ap.add_argument("--config-dir", default=CFG,
                    help="입력·출력을 둘 폴더. 다른 건물 도면을 시험할 때 쓴다")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    std_path = os.path.join(ROOT, "tools", "wall-standards.json")
    std_heights = {}
    if os.path.exists(std_path):
        std_heights = json.load(open(std_path, encoding="utf-8")).get("heights", {})
    cfg = args.config_dir
    if args.out is None:
        args.out = os.path.join(cfg, "tiling-map.png")
    wall_p = os.path.join(cfg, "wall-mask.png")
    out_p = os.path.join(cfg, "outside-mask.png")
    fur_p = os.path.join(cfg, "furniture-mask.png")
    door_p = os.path.join(cfg, "door.json")
    for p in (wall_p, out_p):
        if not os.path.exists(p):
            sys.exit(f"입력이 없다: {p}")

    wall = Image.open(wall_p).convert("L")
    outside = Image.open(out_p).convert("L")
    if wall.size != outside.size:
        sys.exit(f"두 마스크 크기가 다르다: {wall.size} vs {outside.size}")
    W, H = wall.size

    fur = None
    if os.path.exists(fur_p):
        fur = Image.open(fur_p).convert("L")
        if fur.size != (W, H):
            sys.exit(f"가구 마스크 크기가 다르다: {fur.size} vs {(W, H)}")

    wp, op = wall.load(), outside.load()
    fp = fur.load() if fur else None
    img = Image.new("RGB", (W, H))
    px = img.load()

    # 문 사각형을 먼저 읽어 **벽과 같은 solid** 로 묶는다.
    #
    # ⚠️ door.json 의 사각형은 **문짝 두께**(실측 9~16px = 15~26cm)이고, 마스크의 벽
    #    구멍은 **벽 두께**(실측 35~46px)다. 사각형을 그대로 칠하면 구멍 한가운데
    #    얇은 띠만 색이 들어가고 나머지는 바닥으로 남는다 — 문이 벽처럼 안 보인다.
    #
    #    그래서 문을 **옆 벽의 두께까지 넓힌다.** 문 좌우(세로문이면 위아래) 바로 옆에서
    #    벽 구간을 찾아 그 범위를 문의 두께로 쓴다. 그러면 문이 벽과 같은 두께가 되고,
    #    아래의 같은 규칙을 태웠을 때 윗면/정면 비율도 벽과 같아진다.
    # 문은 **옆 벽과 똑같은 구간에 똑같은 규칙**으로 칠한다. 색만 다르다.
    #
    # 두 번 헤맸다. door.json 사각형(실측 9px)만 칠하면 40px 구멍에 얇은 띠만 들어가
    # 나머지가 바닥으로 새고, 사각형 아래에 정면 띠를 따로 붙이면 **문 띠와 벽 띠가
    # 7px 어긋나** 문마다 턱이 생긴다(실측: 벽 정면 y256~279 vs 문 정면 y250~273).
    #
    # 그래서 문의 두께를 **옆 벽의 단면 그대로** 잡고, 아래의 같은 down 규칙에 태운다.
    # 같은 구간·같은 규칙이면 띠가 어긋날 수 없다 — 벽에서 색만 바뀐 구간이 된다.
    MAX_WALL_THICK = 70

    def wall_span(fixed, mid, vertical):
        """문 옆에서 벽 단면의 [시작, 끝] 을 찾는다. 못 찾거나 너무 길면 None."""
        ok = (wp[fixed, mid] >= 128) if vertical else (wp[mid, fixed] >= 128)
        if not ok:
            return None
        limit = (H - 1) if vertical else (W - 1)
        a = b = mid
        while a > 0 and (wp[fixed, a - 1] >= 128 if vertical else wp[a - 1, fixed] >= 128):
            a -= 1
            if mid - a > MAX_WALL_THICK:
                return None
        while b < limit and (wp[fixed, b + 1] >= 128 if vertical else wp[b + 1, fixed] >= 128):
            b += 1
            if b - mid > MAX_WALL_THICK:
                return None
        return (a, b)

    door_px = set()
    door_n = 0
    aligned = 0
    if os.path.exists(door_p):
        spec = json.load(open(door_p, encoding="utf-8"))
        door_n = len(spec.get("doors", []))
        for d in spec.get("doors", []):
            x0, y0, w, h = d["x"], d["y"], d["w"], d["h"]
            if d.get("axis") == "h":
                spans = [sp for sx in (x0 - 1, x0 + w)
                         if 0 <= sx < W for sp in [wall_span(sx, y0 + h // 2, True)] if sp]
                if spans:
                    a, b = min(spans, key=lambda sp: sp[1] - sp[0])
                    y0, h = a, b - a + 1
                    aligned += 1
            else:
                spans = [sp for sy in (y0 - 1, y0 + h)
                         if 0 <= sy < H for sp in [wall_span(sy, x0 + w // 2, False)] if sp]
                if spans:
                    a, b = min(spans, key=lambda sp: sp[1] - sp[0])
                    x0, w = a, b - a + 1
                    aligned += 1
            for y in range(max(0, y0), min(H, y0 + h)):
                for x in range(max(0, x0), min(W, x0 + w)):
                    door_px.add((x, y))

    def solid(x, y):
        """벽 판정용 — 문도 solid 로 센다. 문만 빼면 문 위 벽이 정면으로 오판된다."""
        return wp[x, y] >= 128 or (x, y) in door_px

    # 아래로 몇 픽셀 만에 solid 가 끝나는가 — 아래에서 위로 한 번 훑으면 전부 구해진다
    down = [0] * (W * H)
    for x in range(W):
        run = 0
        for y in range(H - 1, -1, -1):
            run = run + 1 if solid(x, y) else 0
            down[y * W + x] = run

    # ── 평면 → 2.5D 밀어내기 ────────────────────────────────────────────────
    #
    # 설계도면 마스크는 **평면**이라 높이가 없다. 발자국 = 윗면으로 두고 남쪽으로 밀어내
    # 정면을 만든다. 깊이는 **그 벽 두께 x faceRatio** 다 (고정 mm 로 줬다가 실패했다 —
    # 벽 243mm 도면에 맞춘 389mm 를 벽 119mm 도면에 주니 정면이 벽의 3.3배가 됐다).
    #
    # 두께를 **픽셀마다** 재면 교차점에서 무너진다. 十자·T자 자리의 가로연속이 교차하는
    # 벽의 길이가 되어 깊이가 폭발했다(실측: 빨강 3.6% -> 8.4%, 세로 벽 끝마다 수십 px).
    #
    # 그래서 **남쪽 경계의 연속 구간을 한 조각으로** 보고 조각마다 두께를 하나 정한다:
    #
    #     두께 = min(구간 길이, 그 구간 세로연속의 중앙값)
    #
    # 가로 벽이면 구간 길이가 길고 세로연속이 두께이므로 두께가 잡힌다. 세로 벽의 남쪽
    # 끝이면 구간 길이가 곧 두께이고 세로연속은 벽 길이이므로 역시 두께가 잡힌다.
    # 중앙값을 쓰는 것이 교차점 이상값을 걸러내는 부분이다.
    ratio = args.face_ratio if args.face_ratio is not None else std_heights.get("faceRatio", 1.6)
    ext_wall = set()
    ext_door = set()
    if args.extrude:
        solid = bytearray(W * H)
        for y in range(H):
            for x in range(W):
                if wp[x, y] >= 128 or (x, y) in door_px:
                    solid[y * W + x] = 1
        vr = bytearray(W * H)
        for x in range(W):
            y = 0
            while y < H:
                if solid[y * W + x]:
                    s0 = y
                    while y < H and solid[y * W + x]:
                        y += 1
                    L = min(y - s0, 255)
                    for i in range(s0, y):
                        vr[i * W + x] = L
                else:
                    y += 1

        # 세로 벽에 든 문(axis='h')은 정면을 만들지 않는다 — 세로 벽이 길이 방향으로
        # 정면을 안 보이는 것과 같은 규칙이다. 규칙이 갈리면 문이 벽과 안 맞물린다.
        no_face = set()
        if os.path.exists(door_p):
            for d in json.load(open(door_p, encoding="utf-8")).get("doors", []):
                if d.get("axis") == "h":
                    for y in range(max(0, d["y"]), min(H, d["y"] + d["h"])):
                        for x in range(max(0, d["x"]), min(W, d["x"] + d["w"])):
                            no_face.add((x, y))

        # 남쪽 경계 픽셀을 가로로 이어 조각으로 묶는다
        MAX_T = 40      # 표의 가장 두꺼운 벽(400mm)보다 두꺼우면 벽이 아니다 — 깊이 폭발 방지
        pieces = 0
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
                # 구간을 **문 경계에서 쪼갠다.** 안 쪼개면 벽의 남쪽 경계가 문을 관통해
                # 이어지면서 문이 소수가 되고, 문의 정면이 벽 색으로 칠해진다
                # (실측: 문 정면이 0.1% 로 사라졌다).
                for i0 in range(s0, x):
                    pass
                sub = []
                cur = s0
                is_door = (s0, y) in door_px
                for i in range(s0 + 1, x + 1):
                    d = (i, y) in door_px if i < x else None
                    if i == x or d != is_door:
                        sub.append((cur, i, is_door))
                        cur, is_door = i, d
                for a, b, dr_flag in sub:
                    run = list(range(a, b))
                    if not run or all((i, y) in no_face for i in run):
                        continue
                    vs = sorted(vr[y * W + i] for i in run)
                    t = min(len(run), vs[len(vs) // 2])
                    if t > MAX_T:
                        continue
                    depth = max(1, int(round(t * ratio)))
                    pieces += 1
                    tgt = ext_door if dr_flag else ext_wall
                    for i in run:
                        if (i, y) in no_face:
                            continue
                        for k in range(y + 1, min(H, y + 1 + depth)):
                            if wp[i, k] < 128 and (i, k) not in door_px:
                                tgt.add((i, k))
        print(f"밀어내기: 조각 {pieces:,}개 · 비율 {ratio}배 · 두께 상한 {MAX_T}px")

    n = {"floor": 0, "face": 0, "top": 0, "outside": 0,
         "desk": 0, "door_face": 0, "door_top": 0}
    for y in range(H):
        for x in range(W):
            is_door = (x, y) in door_px
            if is_door or wp[x, y] >= 128:
                if args.extrude:
                    # 밀어내기 모드에서는 발자국이 곧 윗면이다
                    px[x, y] = DOOR_TOP if is_door else TOP
                    n["door_top" if is_door else "top"] += 1
                    continue
                is_fur = fp is not None and fp[x, y] >= 128 and not is_door
                if is_fur:
                    n["desk"] += 1
                band = args.desk_face if is_fur else args.face
                face = down[y * W + x] <= band
                if is_door:
                    px[x, y] = DOOR_FACE if face else DOOR_TOP
                    n["door_face" if face else "door_top"] += 1
                else:
                    px[x, y] = FACE if face else TOP
                    n["face" if face else "top"] += 1
            elif (x, y) in ext_door:
                px[x, y] = DOOR_FACE
                n["door_face"] += 1
            elif (x, y) in ext_wall:
                px[x, y] = FACE
                n["face"] += 1
            elif op[x, y] >= 128:
                px[x, y] = OUTSIDE
                n["outside"] += 1
            else:
                px[x, y] = FLOOR
                n["floor"] += 1

    img.save(args.out)
    tot = W * H
    print(f"{W}x{H} · 벽 정면 {args.face}px · 가구 정면 {args.desk_face}px"
          + (f" · 가구 {n['desk']:,}px" if fur else " · 가구 마스크 없음"))
    for k, label in (("floor", "초록 바닥"), ("face", "빨강 벽정면"), ("top", "파랑 벽윗면"),
                     ("door_face", "핫핑크 문정면"), ("door_top", "주황 문윗면"),
                     ("outside", "검정 건물밖")):
        print(f"  {label:16} {n[k]:9,}px ({n[k] / tot * 100:5.1f}%)")
    print(f"  문 {door_n}개 (옆 벽 단면에 맞춘 것 {aligned}개)")
    print(f"saved {args.out}")


if __name__ == "__main__":
    main()
