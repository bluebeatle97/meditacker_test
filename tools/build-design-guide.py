#!/usr/bin/env python3
"""디자이너용 2.5D 마감 가이드 (`docs/design-guide-2p5d.png`).

## 역할 분담

**구조는 이쪽에서 만든다** — 방·복도·벽의 위치, 벽 압출로 세운 높이, 문, 통제구역.
전부 도면에서 나오므로 디자이너가 정할 게 없다.

**마감은 디자이너가 고른다** — 이 벽엔 어떤 벽지, 이 바닥엔 어떤 타일. 도배·타일 시공과
같은 관계다. 벽을 세우거나 옮기지 않고, 이미 서 있는 벽에 무엇을 붙일지만 정한다.

그래서 이 가이드는 **골조(마감 없는 회색 상태)** 와 **마감 예시** 를 나란히 보여준다.
디자이너는 골조를 보고 "여기엔 이걸 붙이자" 를 정한다.

    python tools/build-design-guide.py
"""
import importlib.util
import json
import os
import tempfile

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CFG = os.path.join(ROOT, "packages", "server", "src", "config")
FINISHED = os.path.join(ROOT, "packages", "web-patient", "public", "pixelmap.png")
OUT = os.path.join(ROOT, "docs", "design-guide-2p5d.png")

_spec = importlib.util.spec_from_file_location(
    "build_pixel_map", os.path.join(ROOT, "tools", "build-pixel-map.py")
)
_bpm = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_bpm)

BG = (26, 29, 41)
FG = (226, 232, 240)
DIM = (148, 163, 184)
ACC = (94, 234, 212)
WARN = (251, 191, 36)


def font(sz, bold=False):
    return ImageFont.truetype(r"C:\Windows\Fonts\malgun%s.ttf" % ("bd" if bold else ""), sz)


def render_shell():
    """마감 없는 골조 — 바닥·벽지를 전부 중립 회색으로 덮어 다시 렌더한다.

    모듈 전역을 갈아끼우고 main() 을 다시 부른다. 같은 파이프라인을 쓰므로 골조와 마감이
    **구조적으로 100% 같은 그림**이다 — 따로 그리면 어긋난다.
    """
    tmp = os.path.join(tempfile.gettempdir(), "meditracker-shell.png")
    keep = (_bpm.FLOOR_BY_TYPE, _bpm.CORRIDOR, _bpm.WALL_BY_TYPE, _bpm.WALL_CORRIDOR,
            _bpm.OUT, _bpm.FLOORS)
    _bpm.FLOOR_BY_TYPE = {k: "concrete" for k in _bpm.FLOOR_BY_TYPE}
    # elev_hall 은 mat_for 안에서 brick 으로 특례 처리된다 — dict 로는 못 막으니
    # brick 타일 좌표 자체를 concrete 로 바꿔 둔다.
    _bpm.FLOORS = {**_bpm.FLOORS, "brick": _bpm.FLOORS["concrete"]}
    _bpm.CORRIDOR = "concrete"
    _bpm.WALL_BY_TYPE = {k: "gray" for k in _bpm.WALL_BY_TYPE}
    _bpm.WALL_CORRIDOR = "gray"
    _bpm.OUT = tmp
    try:
        _bpm.main()
    finally:
        (_bpm.FLOOR_BY_TYPE, _bpm.CORRIDOR, _bpm.WALL_BY_TYPE,
         _bpm.WALL_CORRIDOR, _bpm.OUT, _bpm.FLOORS) = keep
    return Image.open(tmp).convert("RGB")


def swatch_sheet(sheet, table, title, note, cell=64):
    """마감재 스와치 한 줄"""
    pad = 12
    w = max(pad + len(table) * (cell + pad), 1100)
    img = Image.new("RGB", (w, cell + 88), BG)
    d = ImageDraw.Draw(img)
    d.text((pad, 4), title, font=font(20, True), fill=FG)
    d.text((pad, 28), note, font=font(14), fill=DIM)
    for i, (name, box) in enumerate(table.items()):
        x = pad + i * (cell + pad)
        c, r = box[0], box[1]
        pat = sheet.crop((c * 16, r * 16, (c + 2) * 16, (r + 2) * 16)).resize(
            (cell, cell), Image.NEAREST)
        img.paste(pat, (x, 52))
        d.rectangle([x - 1, 51, x + cell, 52 + cell], outline=(70, 80, 105))
        d.text((x, 52 + cell + 4), name, font=font(14, True), fill=ACC)
    return img


def main():
    shell = render_shell()
    fin = Image.open(FINISHED).convert("RGB")
    assets = _bpm.DEFAULT_ASSETS
    sheet = Image.open(os.path.join(assets, "Interiors_free", "16x16",
                                    "Room_Builder_free_16x16.png")).convert("RGBA")
    zones = json.load(open(os.path.join(CFG, "zones.json"), encoding="utf-8"))

    # 확대해서 보여줄 두 곳 — 방 하나와 복도 하나 (출력 좌표 = 도면 x0.5)
    def out_xy(name):
        for z in zones:
            if z["name"] == name:
                return (int(z["tilePosition"]["x"] * _bpm.MAP_SCALE),
                        int(z["tilePosition"]["y"] * _bpm.MAP_SCALE))
        raise SystemExit(f"존을 못 찾음: {name}")

    rx, ry = out_xy("시술실 1")
    ZOOMS = [
        ("방 — 시술실 1 (북벽 벽면이 보이는 자리)", (rx - 58, 2, rx + 58, 82)),
        ("복도", (330, 250, 450, 340)),
    ]

    S_FULL = 1
    ZS = 4
    gap, pad = 26, 30
    zoom_imgs = []
    for label, box in ZOOMS:
        a = shell.crop(box).resize(((box[2] - box[0]) * ZS, (box[3] - box[1]) * ZS), Image.NEAREST)
        b = fin.crop(box).resize(a.size, Image.NEAREST)
        strip = Image.new("RGB", (a.width * 2 + gap, a.height + 56), BG)
        sd = ImageDraw.Draw(strip)
        sd.text((0, 2), label, font=font(21, True), fill=FG)
        for i, (im, t) in enumerate([(a, "골조 (제가 만드는 것)"), (b, "마감 (디자이너가 고르는 것)")]):
            x = i * (a.width + gap)
            sd.text((x, 30), t, font=font(15), fill=DIM if i == 0 else ACC)
            strip.paste(im, (x, 52))
            sd.rectangle([x - 1, 51, x + im.width, 52 + im.height], outline=(70, 80, 105))
        zoom_imgs.append(strip)

    wall_tbl = {k: v for k, v in _bpm.WALL_BLOCK.items()}
    floor_tbl = {k: v for k, v in _bpm.FLOORS.items()}
    sw_wall = swatch_sheet(sheet, wall_tbl, "붙일 수 있는 벽지",
                           "3종. 줄무늬 벽지는 아래 절반이 다른 색 굽도리라 42cm 높이로 자르면 그 색만 남아 제외했습니다")
    sw_floor = swatch_sheet(sheet, floor_tbl, "붙일 수 있는 바닥 타일", "6종")

    fw = shell.width * S_FULL
    body_w = max(fw * 2 + gap, max(z.width for z in zoom_imgs), sw_wall.width, sw_floor.width)
    H = 200 + shell.height + 40 + sum(z.height + 30 for z in zoom_imgs) + sw_wall.height + sw_floor.height + 80
    img = Image.new("RGB", (body_w + pad * 2, H), BG)
    d = ImageDraw.Draw(img)
    d.text((pad, 24), "환자용 화면 2.5D 마감 가이드", font=font(40, True), fill=FG)
    d.text((pad, 78),
           "구조(방·복도·벽·벽 높이·문)는 도면에서 자동으로 나옵니다. 디자이너는 그 위에 "
           "벽지와 바닥 타일, 가구만 고릅니다 — 도배·타일 시공과 같습니다.",
           font=font(20), fill=DIM)
    d.text((pad, 112),
           f"한 타일 = 16px = 52cm  ·  캐릭터 = 1 x 2타일 (52 x 104cm)  ·  "
           f"벽면 높이 = {_bpm.FACE_H}px 약 {_bpm.FACE_H * _bpm.TILE_FP * _bpm.CM_PER_PX / 16:.0f}cm  ·  "
           "에셋 = Modern Interiors 무료판 16x16",
           font=font(18), fill=WARN)
    y = 168
    d.text((pad, y), "층 전체 — 왼쪽이 골조, 오른쪽이 마감을 입힌 상태", font=font(22, True), fill=FG)
    y += 32
    img.paste(shell, (pad, y))
    img.paste(fin, (pad + fw + gap, y))
    d.rectangle([pad - 1, y - 1, pad + fw, y + shell.height], outline=(70, 80, 105))
    d.rectangle([pad + fw + gap - 1, y - 1, pad + fw + gap + fw, y + shell.height],
                outline=(70, 80, 105))
    y += shell.height + 40
    for z in zoom_imgs:
        img.paste(z, (pad, y))
        y += z.height + 30
    img.paste(sw_wall, (pad, y))
    y += sw_wall.height + 10
    img.paste(sw_floor, (pad, y))
    y += sw_floor.height + 16
    d.text((pad, y),
           "벽면은 카메라 쪽(남향) 벽에만 세웁니다 — 방 밖에서는 그 방 벽의 윗면만 보입니다. "
           "그래서 벽지는 '그 방 안에서 보는 사람' 기준으로 고르세요.",
           font=font(17), fill=DIM)

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    img.save(OUT, optimize=True)
    print(f"saved {OUT}  {img.size}  ({os.path.getsize(OUT) / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
