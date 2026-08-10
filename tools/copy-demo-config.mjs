/**
 * 서버의 정적 설정(도면 메타·존·벽 격자)을 두 프론트의 public/config/ 로 복사한다.
 *
 *   node tools/copy-demo-config.mjs
 *
 * **왜 복사인가.** 이 세 파일은 런타임 데이터가 아니라 **고정 설정**이다. 서버가 없는
 * 시연 모드(정적 호스팅)에서도 도면을 그리려면 화면 쪽에 같이 들어 있어야 한다.
 *
 * **왜 커밋하지 않고 빌드 때 복사하나.** 원본(`packages/server/src/config/`)이 단일
 * 출처다. 사본을 저장소에 두면 도면·벽을 고친 뒤 한쪽만 갱신되어, 화면과 서버 판정이
 * 어긋난 채로 한참 굴러간다. 빌드마다 다시 긁어오면 그럴 일이 없다.
 */
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FROM = join(ROOT, 'packages/server/src/config');
const FILES = [
  'floorplan.json',
  'zones.json',
  'walkable.json',
  'gateways.json',
  'staff-area.json',
  'corridor.json', // 안내 경로가 복도로 다니게 하는 마스크 (tools/build-rooms.py)
];
const APPS = ['web-staff', 'web-patient'];

for (const app of APPS) {
  const to = join(ROOT, 'packages', app, 'public/config');
  mkdirSync(to, { recursive: true });
  for (const f of FILES) copyFileSync(join(FROM, f), join(to, f));
  console.log(`[demo-config] ${app}/public/config ← ${FILES.length}개`);
}
