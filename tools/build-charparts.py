"""환자 캐릭터 조합용 파츠 추출기 (Character Generator 2.0).

    python tools/build-charparts.py "<Character Pieces 폴더>"

원본은 파츠(몸·눈·머리·옷·액세서리)마다 **896x640 아틀라스**를 준다. 56x20 = 1,120프레임이고
그중 우리가 쓰는 건 네 줄뿐이다. 그 네 줄만 잘라 한 줄로 이어 붙인다:

    [ idle 24 ][ walk 24 ][ sit 12 ][ phone 12 ]   = 72프레임 · 1152x32

한 줄로 합치는 이유: 브라우저에서 레이어를 겹칠 때 **한 번만 합성**하면 네 동작이 다 나온다.
파일도 파츠당 하나라 200개짜리 머리 목록도 관리가 된다.

manifest 는 파츠를 `모양 → 색` 두 단계로 묶어서 준다. 고르는 화면이 메이플스토리
캐릭터 생성창처럼 **모양은 화살표, 색은 동그라미**로 갈라지기 때문이다. 동그라미에
칠할 대표색도 파츠에서 직접 뽑아 넣는다 ("3번 색"이 아니라 눈으로 고르게).

프레임 크기(16x32)와 방향 배치(오른쪽·위·왼쪽·아래 x 6프레임)가 기존 시트와 같아서
좌표·축척은 손댈 게 없다.

⚠️ 라이선스: Modern Interiors **유료판**은 상업 프로젝트에 쓸 수 있고 크레딧
   (limezu.itch.io) 표기를 요구한다. 다만 **에셋 자체의 재배포는 금지**다 —
   공개 정적 배포(GitHub Pages)에 파츠를 통째로 올리는 건 피할 것.
"""
import json
import os
import re
import sys
from collections import Counter, OrderedDict

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "packages", "web-patient", "public", "charparts")
DEFAULT_SRC = (
    r"C:\Users\LG gram\Desktop\GAMEASSET\Character Generator 2.0 Linux Build"
    r"\Character Generator 2.0 Linux Build\Character Pieces"
)

FW, FH = 16, 32

# 아틀라스에서 가져올 줄과 그 줄에서 쓸 프레임 수 (눈으로 확인한 배치)
#   1 = idle(4방향x6) · 2 = 걷기(4방향x6) · 4 = 앉기 · 6 = 폰 보기
ROWS = [("idle", 1, 24), ("walk", 2, 24), ("sit", 4, 12), ("phone", 6, 12)]
TOTAL = sum(n for _, _, n in ROWS)

# 겹치는 순서(뒤 → 앞). 눈이 몸 위, 옷이 그 위, 머리가 옷 위, 액세서리가 맨 앞
CATEGORIES = [
    ("body", "Bodies"),
    ("eyes", "Eyes"),
    ("outfit", "Outfits"),
    ("hair", "Hairstyles"),
    ("accessory", "Accessories"),
]

# 파츠 이름은 `<모양>_<색>` 이다 (Hairstyle_07_03 = 7번 모양의 3번 색).
# 실제로 뽑아서 대조해 보니 한 모양 안에서는 **실루엣이 픽셀 단위로 동일**하고 색만 바뀐다.
# 그래서 고르는 화면을 모양(화살표)과 색(동그라미)으로 나눌 수 있다.
SHAPE_COLOR = re.compile(r"^(.*)_(\d+)$")

# 대표색은 idle 24프레임(4방향)만 보고 뽑는다. 정면만 보면 등에 멘 가방처럼
# 뒤에서만 보이는 파츠가 통째로 빈 칸이 된다.
SWATCH_FRAMES = 24


def swatch_colors(sheets):
    """한 모양의 색 변형들에서 각자의 대표색을 뽑는다.

    밝기로 외곽선을 걸러내려 했더니 외곽선(#3a3a50)이 경계에 딱 걸려서 옷·장식의
    동그라미가 전부 같은 색으로 나왔다. 밝기는 애초에 잘못된 기준이다 —
    **변형끼리 실제로 달라지는 픽셀**이 곧 그 파츠의 '색'이고, 외곽선은 정의상
    안 변한다. 그래서 문턱값 없이 차이나는 자리만 세면 된다.
    """
    px = [list(s.crop((0, 0, SWATCH_FRAMES * FW, FH)).getdata()) for s in sheets]
    if len(px) > 1:
        spots = [i for i, group in enumerate(zip(*px)) if len(set(group)) > 1]
    else:
        spots = [i for i, p in enumerate(px[0]) if p[3] > 200]  # 변형이 하나뿐이면 비교할 게 없다

    out = []
    for one in px:
        pool = [one[i] for i in spots if one[i][3] > 200]
        if not pool:
            out.append("#888888")
            continue
        r, g, b = Counter(pool).most_common(1)[0][0][:3]
        out.append(f"#{r:02x}{g:02x}{b:02x}")
    return out


def strip(src_img):
    """아틀라스에서 필요한 네 줄만 잘라 한 줄로 잇는다"""
    out = Image.new("RGBA", (TOTAL * FW, FH), (0, 0, 0, 0))
    x = 0
    for _, row, count in ROWS:
        part = src_img.crop((0, row * FH, count * FW, (row + 1) * FH))
        out.paste(part, (x * FW, 0))
        x += count
    return out


def main() -> int:
    src = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_SRC
    if not os.path.isdir(src):
        print(f"원본 폴더가 없습니다: {src}")
        return 1

    parts = OrderedDict()
    for key, folder in CATEGORIES:
        d = os.path.join(src, folder, "16x16")
        if not os.path.isdir(d):
            print(f"  ! 없음, 건너뜀: {folder}/16x16")
            continue
        os.makedirs(os.path.join(OUT, key), exist_ok=True)

        shapes = OrderedDict()
        for f in sorted(os.listdir(d)):
            if not f.lower().endswith(".png"):
                continue
            name = os.path.splitext(f)[0]
            sheet = strip(Image.open(os.path.join(d, f)).convert("RGBA"))
            sheet.save(os.path.join(OUT, key, f"{name}.png"))

            # 피부·눈은 모양이 없고 색만 있다 — 이름에 번호가 하나뿐이라 통째로 한 모양이 된다
            m = SHAPE_COLOR.match(name)
            shape = m.group(1) if m else name
            shapes.setdefault(shape, []).append((name, sheet))

        parts[key] = [
            {
                "id": shape,
                "colors": [
                    {"id": n, "hex": hexv}
                    for (n, _), hexv in zip(items, swatch_colors([s for _, s in items]))
                ],
            }
            for shape, items in shapes.items()
        ]
        n = sum(len(s["colors"]) for s in parts[key])
        print(f"  {key}: 모양 {len(parts[key])}종 · 파츠 {n}개")

    manifest = {
        "frames": {k: [sum(n for _, _, n in ROWS[:i]), c] for i, (k, _, c) in enumerate(ROWS)},
        "parts": parts,
    }
    with open(os.path.join(OUT, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=1)
    print(f"[charparts] → {os.path.relpath(OUT, ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
