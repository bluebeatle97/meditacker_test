#!/usr/bin/env python3
"""벽 골조만 뽑는다 — 바닥 마감을 전부 뺀 어두운 틀 (`docs/wall-frame.png`).

디자이너가 바닥·가구를 올릴 **빈 틀**이다. 벽은 2.5D(천장캡 + 남향 벽면 + 걸레받이 +
접지 그림자)로 서 있고, 바닥은 타일 무늬 없이 비워 둔다.

## 구현 방식 — 코드를 복제하지 않는다

벽 압출은 `build-pixel-map.py` 안에 있다. 그걸 여기 옮겨 적으면 두 벌이 되어 반드시
어긋난다. 그래서 **에셋 시트를 갈아치우고** 같은 파이프라인을 그대로 돌린다:

  - 바닥 타일 자리 → 단색으로 덮음 (무늬가 사라진다)
  - 벽지 자리 → 어두운 단색 그라디언트로 덮음

시트만 바꾸므로 벽 위치·높이·그림자는 실제 화면과 100% 같다.

    python tools/build-wall-frame.py
"""
import importlib.util
import os
import sys
import tempfile

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "docs", "wall-frame.png")
OUT3X = os.path.join(ROOT, "docs", "wall-frame@3x.png")

_spec = importlib.util.spec_from_file_location(
    "build_pixel_map", os.path.join(ROOT, "tools", "build-pixel-map.py")
)
_bpm = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_bpm)

T = _bpm.T
FLOOR_FLAT = (255, 255, 255)     # 바닥 — 마감 없는 빈 상태 (흰 바탕)
CAP = (92, 99, 118)              # 벽 윗면
FACE_TOP = (116, 123, 145)       # 벽면 위 (빛 받는 쪽)
FACE_BOTTOM = (72, 78, 98)       # 벽면 아래
BASEBOARD = (44, 48, 62)
OUTLINE = (26, 29, 40)
VOID = (12, 14, 20)              # 통제구역 · 건물 밖


def patched_sheet():
    """바닥은 단색, 벽지는 어두운 그라디언트로 덮은 시트"""
    src = os.path.join(_bpm.DEFAULT_ASSETS, "Interiors_free", "16x16",
                       "Room_Builder_free_16x16.png")
    if not os.path.exists(src):
        sys.exit(f"타일셋을 못 찾음: {src}")
    sheet = Image.open(src).convert("RGBA")
    d = ImageDraw.Draw(sheet)

    for _name, (c, r, w, h) in _bpm.FLOORS.items():
        d.rectangle([c * T, r * T, (c + w) * T - 1, (r + h) * T - 1],
                    fill=FLOOR_FLAT + (255,))

    # 벽지 블록은 아래에서 잘라 쓰므로(걸레받이 유지) 같은 배치로 다시 칠한다.
    for _name, (bc, br) in _bpm.WALL_BLOCK.items():
        by = br * T
        x0, x1 = bc * T, (bc + 3) * T - 1
        face_top = by + 6
        face_bot = by + _bpm.FACE_BAND_BOTTOM - 1
        span = max(1, face_bot - face_top)
        for y in range(face_top, face_bot + 1):
            t = (y - face_top) / span
            col = tuple(int(a + (b - a) * t) for a, b in zip(FACE_TOP, FACE_BOTTOM))
            d.line([(x0, y), (x1, y)], fill=col + (255,))
        for i in range(_bpm.BASEBOARD_H):
            d.line([(x0, by + _bpm.FACE_BAND_BOTTOM + i),
                    (x1, by + _bpm.FACE_BAND_BOTTOM + i)], fill=BASEBOARD + (255,))
    return sheet


def main():
    tmp = tempfile.mkdtemp(prefix="meditracker-frame-")
    dst = os.path.join(tmp, "Interiors_free", "16x16")
    os.makedirs(dst, exist_ok=True)
    patched_sheet().save(os.path.join(dst, "Room_Builder_free_16x16.png"))

    keep = (_bpm.CAP_RGB, _bpm.WALL_RGB, _bpm.VOID_RGB, _bpm.OUT)
    _bpm.CAP_RGB, _bpm.WALL_RGB, _bpm.VOID_RGB, _bpm.OUT = CAP, OUTLINE, VOID, OUT
    argv = sys.argv[:]
    sys.argv = [argv[0], tmp]
    try:
        _bpm.main()
    finally:
        _bpm.CAP_RGB, _bpm.WALL_RGB, _bpm.VOID_RGB, _bpm.OUT = keep
        sys.argv = argv

    img = Image.open(OUT).convert("RGB")
    img.resize((img.width * 3, img.height * 3), Image.NEAREST).save(OUT3X, optimize=True)
    print(f"saved {OUT}  {img.size}")
    print(f"saved {OUT3X}  ({os.path.getsize(OUT3X) / 1024:.0f} KB) — 위에 그려 넣을 용")


if __name__ == "__main__":
    main()
