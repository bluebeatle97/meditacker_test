#!/usr/bin/env python3
"""손님 통제구역(직원 전용)을 도면에 칠한다.

    python tools/paint-staff-areas.py <칠한_그림.png> [--apply]

**사람이 칠한 그림을 그대로 옮긴다.** 노란색으로 칠해 준 자리를 도면의 자홍색으로
바꾼다. 자동으로 방을 추정하지 않는다 — 두 번 해봤고 두 번 다 틀렸다:

  1. 방 분할(segment_rooms)로 뽑기 → v2 도면은 문을 안 그려서 방이 복도로 새어 나갔다.
     완전히 막고 재보니 환자 구역 56조합 중 42개가 서로 못 닿았다 (복도가 끊겼다)
  2. 기준점에서 흰 바닥 번지기 → 층 전체가 흰색 하나로 이어져 있어 도면이 통째로 찼다

그래서 사람이 짚어 주는 것이 유일하게 맞는 입력이다.

⚠️ 자홍색인 이유: 이 도면에서 검정은 이미 벽·설비 선이라, 칠하면 통행 불가가 되어
   직원 좌표까지 벽 밖으로 밀려난다. 직원은 그 안에서 일해야 한다.
   자홍색 = "다닐 수는 있지만 직원 전용" (build-walkable.py 가 읽는다).
   환자 화면에서는 이 구역을 **검게** 칠한다 (build-pixel-map.py).
"""
import os
import sys
from collections import deque

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PLAN = os.path.join(ROOT, "packages", "web-staff", "public", "floorplan.png")
STAFF_RGB = (255, 0, 255)
WHITE_MIN = 240


def is_magenta(p):
    return p[0] > 200 and p[1] < 80 and p[2] > 200


def is_yellow(p):
    r, g, b = p[:3]
    return r > 170 and g > 150 and b < 140 and abs(r - g) < 70


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args:
        sys.exit(__doc__)
    apply = "--apply" in sys.argv
    mark = Image.open(args[0]).convert("RGB")
    plan = Image.open(PLAN).convert("RGB")
    W, H = plan.size

    # 칠한 그림이 도면과 크기가 다를 수 있다 (화면 캡처). 도면 크기로 맞춘다 —
    # 가장 가까운 픽셀로 늘려야 칠한 경계가 흐려지지 않는다
    if mark.size != plan.size:
        print(f"칠한 그림 {mark.size} → 도면 {plan.size} 로 맞춤")
        mark = mark.resize(plan.size, Image.NEAREST)

    mpx = mark.load()
    ppx = plan.load()
    painted = 0
    on_wall = 0
    for y in range(H):
        for x in range(W):
            if not is_yellow(mpx[x, y]):
                continue
            # 벽·설비 선은 그대로 둔다 — 칠할 것은 '바닥' 뿐이다
            if min(ppx[x, y]) >= WHITE_MIN:
                ppx[x, y] = STAFF_RGB
                painted += 1
            else:
                on_wall += 1

    # ── 자홍색에 둘러싸인 구멍 메우기 ───────────────────────────────────────
    # 칠한 그림 위에 방 번호 같은 표시가 얹혀 있으면 그 자리가 통째로 빠진다.
    # 바깥에서 번져 들어가지 못하는 자리 = 자홍색이 에워싼 자리 → 메운다.
    # (벽·설비는 흰색이 아니므로 그대로 남는다)
    out_reach = bytearray(W * H)
    q = deque()
    for x in range(W):
        for y in (0, H - 1):
            if not is_magenta(ppx[x, y]) and not out_reach[y * W + x]:
                out_reach[y * W + x] = 1
                q.append((x, y))
    for y in range(H):
        for x in (0, W - 1):
            if not is_magenta(ppx[x, y]) and not out_reach[y * W + x]:
                out_reach[y * W + x] = 1
                q.append((x, y))
    while q:
        x, y = q.popleft()
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if 0 <= nx < W and 0 <= ny < H and not out_reach[ny * W + nx]:
                if not is_magenta(ppx[nx, ny]):
                    out_reach[ny * W + nx] = 1
                    q.append((nx, ny))
    holes = 0
    for y in range(H):
        for x in range(W):
            if out_reach[y * W + x] or is_magenta(ppx[x, y]):
                continue
            if min(ppx[x, y]) >= WHITE_MIN:  # 에워싸인 흰 바닥만
                ppx[x, y] = STAFF_RGB
                holes += 1
    print(f"에워싸인 빈칸 메움 {holes:,}px")

    total_floor = sum(
        1 for y in range(0, H, 4) for x in range(0, W, 4) if min(ppx[x, y]) >= WHITE_MIN
    )
    print(f"칠함 {painted:,}px ({painted * 1.62 * 1.62 / 10000:.1f}m^2) · 벽에 걸쳐 건너뜀 {on_wall:,}px")
    print(f"남은 흰 바닥(표본): {total_floor:,}")

    out = PLAN if apply else os.path.join(ROOT, "floorplan-preview.png")
    plan.save(out)
    print(f"{'도면에 반영' if apply else '미리보기'}: {out}")
    if apply:
        print("\n다음: python tools/build-walkable.py && python tools/build-pixel-map.py")


if __name__ == "__main__":
    main()
