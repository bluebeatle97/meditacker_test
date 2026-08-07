"""환자 캐릭터 조합용 파츠 추출기 (Character Generator 2.0).

    python tools/build-charparts.py "<Character Pieces 폴더>"

원본은 파츠(몸·눈·머리·옷·액세서리)마다 **896x640 아틀라스**를 준다. 56x20 = 1,120프레임이고
그중 우리가 쓰는 건 네 줄뿐이다. 그 네 줄만 잘라 한 줄로 이어 붙인다:

    [ idle 24 ][ walk 24 ][ sit 12 ][ phone 12 ]   = 72프레임 · 1152x32

한 줄로 합치는 이유: 브라우저에서 레이어를 겹칠 때 **한 번만 합성**하면 네 동작이 다 나온다.
파일도 파츠당 하나라 200개짜리 머리 목록도 관리가 된다.

프레임 크기(16x32)와 방향 배치(오른쪽·위·왼쪽·아래 x 6프레임)가 기존 시트와 같아서
좌표·축척은 손댈 게 없다.

⚠️ 라이선스: Modern Interiors **유료판**은 상업 프로젝트에 쓸 수 있고 크레딧
   (limezu.itch.io) 표기를 요구한다. 다만 **에셋 자체의 재배포는 금지**다 —
   공개 정적 배포(GitHub Pages)에 파츠를 통째로 올리는 건 피할 것.
"""
import json
import os
import sys

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

# 고르기 화면에 쓸 미리보기 = idle 정면(아래) 첫 프레임.
# 방향 배치가 오른쪽·위·왼쪽·아래라 아래는 4번째 묶음 = 18번 프레임
THUMB_FRAME = 18


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

    manifest = {}
    for key, folder in CATEGORIES:
        d = os.path.join(src, folder, "16x16")
        if not os.path.isdir(d):
            print(f"  ! 없음, 건너뜀: {folder}/16x16")
            continue
        os.makedirs(os.path.join(OUT, key), exist_ok=True)

        ids = []
        thumbs = []
        for f in sorted(os.listdir(d)):
            if not f.lower().endswith(".png"):
                continue
            name = os.path.splitext(f)[0]
            img = Image.open(os.path.join(d, f)).convert("RGBA")
            sheet = strip(img)
            sheet.save(os.path.join(OUT, key, f"{name}.png"))
            ids.append(name)
            thumbs.append(sheet.crop((THUMB_FRAME * FW, 0, (THUMB_FRAME + 1) * FW, FH)))

        # 고르기 화면은 미리보기만 있으면 된다 — 파츠 원본을 200개 받게 하지 않으려는 것.
        # 고른 것만 나중에 따로 받아 합성한다.
        sheet = Image.new("RGBA", (len(thumbs) * FW, FH), (0, 0, 0, 0))
        for i, t in enumerate(thumbs):
            sheet.paste(t, (i * FW, 0))
        sheet.save(os.path.join(OUT, f"{key}-thumbs.png"))

        manifest[key] = ids
        print(f"  {key}: {len(ids)}개")

    manifest["frames"] = {k: [sum(n for _, _, n in ROWS[:i]), c] for i, (k, _, c) in enumerate(ROWS)}
    with open(os.path.join(OUT, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=1)
    print(f"[charparts] → {os.path.relpath(OUT, ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
