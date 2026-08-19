#!/usr/bin/env python3
"""도면 파이프라인 전체를 순서대로 돌린다.

    python tools/build-maps.py                 # wall.png(벽 그림)에서 시작
    python tools/build-maps.py --from-mask     # wall-mask.png(받은 마스크)에서 시작
    python tools/build-maps.py --assets "<타일셋 폴더>"   # 도트맵까지
    python tools/build-maps.py --dry-run       # 무엇이 돌지만 보기

## 왜 한 곳에 모으나

단계가 아홉이고 **뒤가 앞의 출력을 입력으로 받는다.** 순서를 한 번 틀리면 조용히
낡은 파일이 섞이고, 그 상태로 화면이 그럴듯하게 뜬다 — 어긋난 걸 알아채는 건 한참
뒤다(README 「도면이 바뀌면」의 사고 기록 참고). 손으로 아홉 번 치는 대신 여기서 한 번에 돈다.

## 두 개의 입구

    --from-art (기본)  wall.png ──build-wall-mask──> wall-mask.png + outside-mask.png
    --from-mask        wall-mask.png ──normalize-wall-mask──> (정규화) + outside-mask.png

⚠️ **마스크를 직접 받았으면 반드시 `--from-mask`** 다. 기본 모드는 `wall.png` 에서
   마스크를 생성하므로 받은 마스크를 덮어쓴다. 실제로 그 함정이 있어서 모드를 갈랐다.

## 사람이 손으로 주는 입력 — 자동화의 경계

도안 한 장으로 **전부** 나오지는 않는다. 아래는 자동으로 못 뽑는다(각 스크립트 주석에
왜 두 번씩 실패했는지 적혀 있다). 없으면 그 단계를 건너뛰고 무엇이 빠졌는지 알린다.

    wall.png / wall-mask.png   벽 판정
    floorplan-door.png         문 위치 (문틈을 빨강으로 채운 그림)
    staff-area.png             손님 통제구역 (자홍색)
    furniture-mask.png         가구 (안내데스크처럼 벽이 아닌 구조물)
    zones.json                 방 이름·앵커 좌표
"""
import argparse
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CFG = os.path.join(ROOT, "packages", "server", "src", "config")
TOOLS = os.path.join(ROOT, "tools")


class Step:
    def __init__(self, name, cmd, needs=(), makes=(), optional=False, note=""):
        self.name = name
        self.cmd = cmd
        self.needs = needs
        self.makes = makes
        self.optional = optional
        self.note = note

    def missing(self):
        return [n for n in self.needs if not os.path.exists(os.path.join(CFG, n))]


def plan(args):
    py = [sys.executable]
    steps = []

    if args.from_mask:
        steps.append(Step(
            "벽 마스크 정규화 + 건물 밖",
            py + [os.path.join(TOOLS, "normalize-wall-mask.py")],
            needs=["wall-mask.png"], makes=["wall-mask.png", "outside-mask.png"],
            note="받은 마스크를 기준으로 삼는다 (wall.png 은 건드리지 않는다)",
        ))
    else:
        steps.append(Step(
            "벽 그림 → 벽 마스크",
            py + [os.path.join(TOOLS, "build-wall-mask.py")],
            needs=["wall.png"], makes=["wall-mask.png", "outside-mask.png"],
        ))

    steps += [
        Step("통행 격자 + 그리기용 바닥",
             py + [os.path.join(TOOLS, "build-walkable.py")],
             needs=["wall-mask.png", "outside-mask.png", "zones.json", "floorplan.json"],
             makes=["walkable.json", "floor.json"]),
        Step("손님 통제구역 마스크",
             py + [os.path.join(TOOLS, "build-staff-areas.py")],
             needs=["staff-area.png"], makes=["staff-area.json"], optional=True),
        Step("문 위치",
             py + [os.path.join(TOOLS, "build-doors.py")],
             needs=["floorplan-door.png"], makes=["door.json"], optional=True),
        Step("방 분할 + 복도 마스크",
             py + [os.path.join(TOOLS, "build-rooms.py")],
             needs=["walkable.json", "door.json", "zones.json"],
             makes=["rooms.json", "corridor.json", "private-area.json"], optional=True,
             note="문이 없으면 방이 복도로 새어 한 덩어리가 된다"),
        Step("에셋 배치용 색 지도",
             py + [os.path.join(TOOLS, "build-tiling-map.py"),
                   "--face", str(args.face), "--desk-face", str(args.desk_face)],
             needs=["wall-mask.png", "outside-mask.png"], makes=["tiling-map.png"]),
    ]

    if args.assets:
        steps.append(Step("환자용 도트맵",
                          py + [os.path.join(TOOLS, "build-pixel-map.py"), args.assets],
                          needs=["walkable.json", "zones.json"], makes=["pixelmap.png"]))
    steps += [
        Step("문 2.5D 레이어",
             py + [os.path.join(TOOLS, "build-door-map.py")],
             needs=["door.json", "floorplan.json"], makes=["doormap.png"], optional=True),
        Step("시연 배포용 사본",
             ["node", os.path.join(TOOLS, "copy-demo-config.mjs")],
             needs=["walkable.json", "zones.json"], makes=[]),
    ]
    return steps


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--from-mask", action="store_true",
                    help="wall-mask.png 을 받은 그대로 기준으로 쓴다 (wall.png 무시)")
    ap.add_argument("--assets", default=None, help="타일셋 폴더 (도트맵을 만들 때만)")
    ap.add_argument("--face", type=int, default=24, help="벽 정면 띠 두께(px)")
    ap.add_argument("--desk-face", type=int, default=38, help="가구 정면 띠 두께(px)")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--skip-check", action="store_true", help="마지막 벽 판정 검사를 건너뛴다")
    args = ap.parse_args()

    steps = plan(args)
    print(f"입구: {'받은 마스크(--from-mask)' if args.from_mask else '벽 그림 wall.png'}\n")

    ran, skipped, failed = [], [], []
    for i, s in enumerate(steps, 1):
        miss = s.missing()
        if miss:
            mark = "건너뜀" if s.optional else "❌ 필수 입력 없음"
            print(f"[{i}/{len(steps)}] {s.name} — {mark}: {', '.join(miss)}")
            (skipped if s.optional else failed).append(s.name)
            if not s.optional:
                break
            continue
        print(f"[{i}/{len(steps)}] {s.name}" + (f"  — {s.note}" if s.note else ""))
        if args.dry_run:
            print("        " + " ".join(s.cmd))
            ran.append(s.name)
            continue
        r = subprocess.run(s.cmd, cwd=ROOT)
        if r.returncode != 0:
            print(f"        ❌ 실패 (exit {r.returncode}) — 뒤 단계는 이 결과를 쓰므로 멈춘다")
            failed.append(s.name)
            break
        ran.append(s.name)

    if not args.dry_run and not failed and not args.skip_check:
        print("\n[검사] 벽 판정")
        subprocess.run(["npm", "run", "check:walls"], cwd=ROOT, shell=(os.name == "nt"))

    print(f"\n완료 {len(ran)}단계" + (f" · 건너뜀 {len(skipped)}" if skipped else "")
          + (f" · 실패 {len(failed)}" if failed else ""))
    if skipped:
        print("  건너뛴 단계: " + ", ".join(skipped))
        print("  → 사람이 그려 줘야 하는 입력이 빠진 것이다 (이 스크립트 맨 위 설명 참고)")
    if not args.dry_run and not failed:
        print("\n⚠️ 서버를 재시작해야 반영된다 — 격자를 시작할 때 한 번만 읽는다:")
        print("   npm run stop && npm run dev:all")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
