"""환자용 캐릭터 스프라이트 추출기.

    python tools/build-characters.py "<Modern tiles_Free 폴더>"

원본 타일셋의 포즈 시트를 앱이 쓰는 이름으로 복사한다. 변환은 없다 — 원본이 이미
16x32 프레임이라 이름만 바꾸면 된다. 그런데도 스크립트를 두는 이유:

  1. **idle → idle_anim 매핑이 안 보인다.** 원본에는 `Adam_idle`(4프레임 정지)과
     `Adam_idle_anim`(24프레임 숨쉬기)이 따로 있고, 앱이 쓰는 `adam-idle.png` 는
     후자다. 손으로 복사하면 다음 사람이 4프레임짜리를 집어 캐릭터가 굳는다.
  2. 어떤 포즈를 쓰고 있는지가 코드가 아니라 파일 이름에만 남아 있었다.

⚠️ 라이선스: 무료판은 **비상업 프로젝트 전용**이다. 실제 병원 운영 배포에는 유료판을
   사야 한다. packages/web-patient/public/characters/ASSET-LICENSE.txt 참고.
"""
import os
import shutil
import sys

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "packages", "web-patient", "public", "characters")
DEFAULT_ASSETS = r"C:\Users\LG gram\Desktop\메디트레커(가칭)\에셋\Modern tiles_Free"

CHARACTERS = ["Adam", "Alex", "Amelia", "Bob"]

# 앱에서 쓰는 이름 → (원본 접미사, 원본 프레임 폭).
#
# ⚠️ 포즈마다 프레임 폭이 다르다. idle·run·phone 은 16px 인데 **sit 만 32px** 이고,
#    그 안에서 사람은 16px 폭으로 좌우 여백을 두고 들어 있다. 이걸 16px 로 자르면
#    사람이 정확히 반으로 쪼개져 두 프레임에 나뉜다 (실제로 그렇게 보였다).
#    그래서 sit 은 내용 기준으로 16px 창을 잘라 다른 포즈와 같은 규격으로 맞춘다 —
#    앱에서 sit 만 특별 취급하지 않아도 되게 하려는 것이다.
POSES = {
    "idle": ("idle_anim_16x16", 16),
    "run": ("run_16x16", 16),
    "sit": ("sit_16x16", 32),
    "phone": ("phone_16x16", 16),
}

OUT_W = 16  # 앱이 기대하는 프레임 폭 (모든 포즈 공통)


def content_bounds(px, x0, x1, h):
    """[x0,x1) 구간에서 실제로 그림이 있는 가로 범위. 없으면 None"""
    lo = hi = None
    for x in range(x0, x1):
        if any(px[x, y][3] > 0 for y in range(h)):
            lo = x if lo is None else lo
            hi = x
    return None if lo is None else (lo, hi)


def repack(src, frame_w):
    """프레임을 내용 중심으로 OUT_W 폭에 다시 담는다 (폭이 이미 맞으면 그대로)"""
    im = Image.open(src).convert("RGBA")
    if frame_w == OUT_W:
        return im
    w, h = im.size
    px = im.load()
    n = w // frame_w
    out = Image.new("RGBA", (n * OUT_W, h), (0, 0, 0, 0))
    for f in range(n):
        b = content_bounds(px, f * frame_w, (f + 1) * frame_w, h)
        if b is None:
            continue
        centre = (b[0] + b[1] + 1) / 2
        left = int(round(centre - OUT_W / 2))
        # 프레임 밖으로 넘어가지 않게 (넘어가면 옆 프레임 사람이 딸려 들어온다)
        left = max(f * frame_w, min(left, (f + 1) * frame_w - OUT_W))
        out.paste(im.crop((left, 0, left + OUT_W, h)), (f * OUT_W, 0))
    return out


def main() -> int:
    assets = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_ASSETS
    src_dir = os.path.join(assets, "Characters_free")
    if not os.path.isdir(src_dir):
        print(f"원본 캐릭터 폴더가 없습니다: {src_dir}")
        print('사용법: python tools/build-characters.py "<Modern tiles_Free 폴더>"')
        return 1

    os.makedirs(OUT, exist_ok=True)
    made = 0
    for char in CHARACTERS:
        for name, (suffix, frame_w) in POSES.items():
            src = os.path.join(src_dir, f"{char}_{suffix}.png")
            if not os.path.exists(src):
                print(f"  ! 없음, 건너뜀: {os.path.basename(src)}")
                continue
            dst = os.path.join(OUT, f"{char.lower()}-{name}.png")
            if frame_w == OUT_W:
                shutil.copyfile(src, dst)  # 손댈 게 없으면 원본 그대로
            else:
                img = repack(src, frame_w)
                img.save(dst)
                print(f"  {char.lower()}-{name}: {frame_w}px → {OUT_W}px 재정렬 ({img.size[0] // OUT_W}프레임)")
            made += 1
    print(f"[characters] {made}개 시트 → {os.path.relpath(OUT, ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
