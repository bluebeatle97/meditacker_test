#!/usr/bin/env python3
"""도면의 축척(mm/px)을 확정한다 — 치수 사슬이 1순위, 벽 두께 역산이 대안.

    python tools/blueprint-scale.py <wall-mask.png> --dpi 150 --pdf <도면.pdf>
    python tools/blueprint-scale.py <wall-mask.png> --dpi 150        # 치수 없는 도면

## 왜 필요한가

이 도구가 없을 때 파이프라인의 모든 문턱이 **근거 없는 픽셀값**이었다 — 정면 띠 24px,
문 폭 50~160cm, 방 최소 1500칸. 그 값들은 도면 하나에만 맞고, 다른 병원 도면에 쓰면
조용히 틀린다. mm 를 알면 문턱을 물리값으로 적을 수 있고 **그건 건물이 바뀌어도 그대로
쓴다** (벽 100~300mm, 문 700~1200mm).

## 두 가지 방법과 그 순서

**1순위 — 치수 사슬.** 도면에 적힌 치수 숫자가 곧 실측값이다. 같은 줄에 늘어선 숫자들을
모아 `합 ÷ 그 숫자들이 걸친 거리` 를 낸다. 사슬마다 독립으로 나오므로 여러 개를 비교해
이상치를 버릴 수 있다 (실측: 사슬 3개가 19.585·19.616·19.636 으로 0.3% 안에서 일치).

   주의: 텍스트는 자기 구간의 **중앙**에 놓인다. 그래서 첫 숫자 중앙~끝 숫자 중앙 거리는
   전체 합에서 양 끝 구간의 절반씩을 뺀 값에 대응한다. 이걸 빼먹으면 사슬 길이에 따라
   값이 달라진다.

**2순위 — 벽 두께 역산.** 도면 축척(1:50·1:100 …)과 시공 벽 두께(75·100·150·200 …)가
둘 다 이산집합이라, 두께 히스토그램의 봉우리를 표에 맞춰 보면 축척이 나온다. 치수가 없는
도면의 유일한 수단이다.

   주의: **이 방법은 PDF 가 진척(true scale)일 때만 맞는다.** 실측 사례 — 두께 역산은
   1:100(16.933mm/px)을 골랐지만 치수 사슬은 19.616 이었다. 19.616/0.1693 = 115.9 로
   표준 축척이 아니다(A3 를 줄여 export 한 도면). 그래서 치수가 있으면 치수를 쓰고,
   두 값이 어긋나면 **멈춘다.** 조용히 16% 틀린 축척으로 넘어가면 이후 모든 판정이
   같이 틀어지고, 틀린 걸 한참 뒤에 발견한다.
"""
import argparse
import json
import os
import re
import sys
from collections import defaultdict

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STD = os.path.join(ROOT, "tools", "wall-standards.json")
MM_PER_INCH = 25.4
MIN_CHAIN = 4          # 사슬로 인정할 최소 숫자 개수
INLIER_PCT = 5.0       # 중앙값에서 이만큼 안이면 같은 값으로 본다
MIN_INLIERS = 2


# ── 1순위: 치수 사슬 ────────────────────────────────────────────────────────

def chain_scale(pdf_path, dpi):
    """치수 숫자 사슬에서 mm/px 를 구한다. (확정값 또는 None, 사슬 목록)"""
    try:
        import fitz
    except ImportError:
        print("   PyMuPDF 없음 — 치수 사슬을 못 읽는다")
        return None, []
    pg = fitz.open(pdf_path)[0]
    nums = []
    for w in pg.get_text("words"):
        t = w[4].strip().replace(",", "")
        if re.fullmatch(r"\d{3,5}", t) and int(t) >= 300:
            nums.append((int(t), (w[0] + w[2]) / 2, (w[1] + w[3]) / 2))

    pt_per_px = 72.0 / dpi
    ests = []
    for horiz in (True, False):
        groups = defaultdict(list)
        for v, x, y in nums:
            groups[round((y if horiz else x) / 3)].append((v, x if horiz else y))
        for _, g in sorted(groups.items()):
            if len(g) < MIN_CHAIN:
                continue
            g.sort(key=lambda a: a[1])
            span = g[-1][1] - g[0][1]
            if span < 50:
                continue
            total = sum(v for v, _ in g)
            eff = total - (g[0][0] + g[-1][0]) / 2   # 양 끝 구간은 절반만 걸친다
            if eff <= 0:
                continue
            ests.append({
                "axis": "가로" if horiz else "세로",
                "count": len(g), "total": total, "span_pt": span,
                "mmpx": (eff / span) * pt_per_px, "inlier": False,
            })
    if not ests:
        return None, []
    vals = sorted(e["mmpx"] for e in ests)
    med = vals[len(vals) // 2]
    inl = []
    for e in ests:
        if abs(e["mmpx"] - med) / med * 100 <= INLIER_PCT:
            e["inlier"] = True
            inl.append(e)
    if len(inl) < MIN_INLIERS:
        return None, ests
    return sum(e["mmpx"] for e in inl) / len(inl), ests


# ── 2순위: 벽 두께 역산 ─────────────────────────────────────────────────────

def thickness_hist(path):
    """벽 픽셀마다 '가로·세로 연속길이 중 작은 쪽' = 그 픽셀이 속한 벽의 두께."""
    im = Image.open(path).convert("L")
    W, H = im.size
    p = im.load()
    wall = bytearray(W * H)
    for y in range(H):
        for x in range(W):
            if p[x, y] >= 128:
                wall[y * W + x] = 1
    hrun = bytearray(W * H)
    vrun = bytearray(W * H)
    for y in range(H):
        x = 0
        while x < W:
            if wall[y * W + x]:
                s = x
                while x < W and wall[y * W + x]:
                    x += 1
                L = min(x - s, 255)
                for i in range(s, x):
                    hrun[y * W + i] = L
            else:
                x += 1
    for x in range(W):
        y = 0
        while y < H:
            if wall[y * W + x]:
                s = y
                while y < H and wall[y * W + x]:
                    y += 1
                L = min(y - s, 255)
                for i in range(s, y):
                    vrun[i * W + x] = L
            else:
                y += 1
    hist = {}
    for i in range(W * H):
        if wall[i]:
            t = min(hrun[i], vrun[i])
            hist[t] = hist.get(t, 0) + 1
    return hist, (W, H)


def peaks(hist, min_share=0.02):
    """의미 있는 봉우리만. 전체의 min_share 미만은 잡티로 버린다."""
    total = sum(hist.values()) or 1
    sm = {t: hist.get(t - 1, 0) + hist.get(t, 0) * 2 + hist.get(t + 1, 0) for t in hist}
    out = []
    for t in sorted(sm):
        if t < 2:
            continue
        if sm[t] >= sm.get(t - 1, 0) and sm[t] >= sm.get(t + 1, 0):
            mass = sum(hist.get(k, 0) for k in (t - 1, t, t + 1))
            if mass / total >= min_share:
                out.append((t, mass / total))
    return sorted(out, key=lambda a: -a[1])


def table_scale(pk, std, dpi):
    """봉우리를 표준 축척마다 mm 로 바꿔 표와 맞춰 본다. (점수, 축척분모, mm/px)"""
    table = [w["mm"] for w in std["walls"]]
    tol = std["tolerancePct"] / 100.0
    paper = MM_PER_INCH / dpi
    best = None
    for denom in std["drawingScales"]:
        mmpx = paper * denom
        score = 0.0
        for t, share in pk:
            mm = t * mmpx
            near = min(table, key=lambda v: abs(v - mm))
            err = abs(near - mm) / near
            if err <= tol:
                score += share * (1 - err / tol)
        if best is None or score > best[0]:
            best = (score, denom, mmpx)
    return best


def classify(pk, mmpx, std):
    table = {w["mm"]: (w["kind"], w["label"]) for w in std["walls"]}
    tol = std["tolerancePct"] / 100.0
    print("두께 봉우리 분류:")
    for t, _share in sorted(pk, key=lambda a: a[0]):
        mm = t * mmpx
        near = min(table, key=lambda v: abs(v - mm))
        err = abs(near - mm) / near
        if err <= tol:
            kind, label = table[near]
            print(f"   {t:3}px -> {mm:6.0f}mm ~ {near}mm  {kind:11} {label}")
        else:
            print(f"   {t:3}px -> {mm:6.0f}mm   표에 없음 — 벽이 아닐 가능성"
                  f" (샤프트·코어·해칭 덩어리)")
    h = std["heights"]
    print(f"\n2.5D 밀어내기: 구조벽 {h['structuralMm']}mm = {h['structuralMm']/mmpx:.0f}px"
          f" · 가벽 {h['partitionMm']}mm = {h['partitionMm']/mmpx:.0f}px"
          f" · 문 {h['doorMm']}mm = {h['doorMm']/mmpx:.0f}px")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mask", help="벽 마스크 png (흰색 = 벽)")
    ap.add_argument("--dpi", type=float, required=True, help="마스크를 렌더한 DPI")
    ap.add_argument("--pdf", default=None, help="원본 PDF — 치수 사슬을 읽는다 (1순위)")
    ap.add_argument("--standards", default=STD)
    ap.add_argument("--max-disagree", type=float, default=10.0,
                    help="두 방법이 이 퍼센트를 넘게 어긋나면 실패로 멈춘다")
    ap.add_argument("--json-out", default=None, help="확정값을 이 경로에 JSON 으로 쓴다")
    args = ap.parse_args()

    if not os.path.exists(args.mask):
        sys.exit(f"마스크가 없다: {args.mask}")
    std = json.load(open(args.standards, encoding="utf-8"))

    print("[1순위] 치수 사슬")
    chain = None
    if args.pdf and os.path.exists(args.pdf):
        chain, ests = chain_scale(args.pdf, args.dpi)
        for e in ests:
            mark = "" if e["inlier"] else "   <- 이상치(버림)"
            print(f"   {e['axis']} 숫자 {e['count']:2}개 합 {e['total']:6}mm "
                  f"span {e['span_pt']:6.1f}pt -> {e['mmpx']:6.3f} mm/px{mark}")
        print(f"   확정 {chain:.3f} mm/px" if chain else "   사슬이 부족하거나 서로 안 맞는다")
    else:
        print("   PDF 미지정 — 건너뜀")

    print("\n[2순위] 벽 두께 역산")
    hist, (W, H) = thickness_hist(args.mask)
    pk = peaks(hist)
    if not pk:
        sys.exit("봉우리를 못 찾았다 — 마스크가 비었거나 벽이 너무 얇다")
    print(f"   {W}x{H} @{args.dpi:g}dpi · 벽 {sum(hist.values()):,}px")
    print("   봉우리: " + " · ".join(f"{t}px({s*100:.0f}%)" for t, s in pk[:5]))
    score, denom, tmmpx = table_scale(pk, std, args.dpi)
    print(f"   최적 1:{denom} -> {tmmpx:.3f} mm/px (점수 {score:.3f})")

    source = None
    if chain:
        diff = abs(chain - tmmpx) / chain * 100
        print(f"\n두 방법 차이 {diff:.1f}%")
        mmpx, source = chain, "dimension-chain"
        if diff > args.max_disagree:
            print(f"[중단] {args.max_disagree:.0f}% 초과 — 두 방법이 안 맞는다.")
            print("   치수 사슬이 맞다면 이 PDF 는 진척이 아니다(줄여서 export).")
            print("   그 경우 두께 역산의 전제가 깨진 것이므로 추출이 틀린 건 아닐 수 있다.")
            print("   축척은 치수 사슬 값을 쓰고, 두께 역산은 참고로만 볼 것.")
            print(f"\n== 축척(치수 사슬): {mmpx:.3f} mm/px ==")
            classify(pk, mmpx, std)
            write_json(args, mmpx, source, chain, tmmpx, diff, ok=False)
            sys.exit(2)
        print("[통과] 두 방법이 일치 — 치수 사슬 값을 쓴다")
    else:
        mmpx, source = tmmpx, "thickness-table"
        print("\n[주의] 치수 사슬이 없어 두께 역산 값을 쓴다 — 진척 도면이 아니면 틀린다")

    print(f"\n== 축척: {mmpx:.3f} mm/px ({source}) ==")
    classify(pk, mmpx, std)
    write_json(args, mmpx, source, chain, tmmpx,
               abs(chain - tmmpx) / chain * 100 if chain else None, ok=True)


def write_json(args, mmpx, source, chain, tmmpx, diff, ok):
    if not args.json_out:
        return
    json.dump({
        "mmPerPx": round(mmpx, 4), "dpi": args.dpi, "source": source,
        "dimensionChainMmPerPx": round(chain, 4) if chain else None,
        "thicknessTableMmPerPx": round(tmmpx, 4),
        "disagreePct": round(diff, 2) if diff is not None else None,
        "passed": ok,
    }, open(args.json_out, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print(f"saved {args.json_out}")


if __name__ == "__main__":
    main()
