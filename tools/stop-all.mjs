/**
 * 로컬 스택 완전 정지.
 *
 *   npm run stop
 *
 * **왜 필요한가.** `dev:all` 래퍼(npm)가 죽어도 **자식 프로세스는 살아남는다**. 창을
 * 닫거나 Ctrl+C 가 제대로 안 먹은 뒤 다시 띄우면 둘 중 하나가 된다:
 *
 *   - 포트가 잡혀 있어 `EADDRINUSE` 로 죽거나,
 *   - `dev:all` 이 "이미 떠 있네" 하고 건너뛰어 **옛날 코드가 계속 도는데 모르고 넘어간다**.
 *
 * 두 번째가 특히 나쁘다 — 설정을 고쳤는데 반영이 안 된 채로 한참 디버깅하게 된다.
 * 그래서 다시 띄우기 전에 이걸 한 번 돌린다.
 *
 * 목 게이트웨이는 포트를 안 쓰므로 명령줄로 찾아서 같이 정리한다.
 */
import { execSync } from 'node:child_process';

const PORTS = [1883, 8080, 5173, 5174];
const isWin = process.platform === 'win32';

function sh(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

/** 포트를 LISTEN 하고 있는 PID 들 */
function pidsOnPort(port) {
  if (isWin) {
    // netstat 은 cmd·PowerShell·Git Bash 어디서든 같게 동작한다.
    // ⚠️ `-p TCP` 를 붙이면 안 된다 — 윈도우에서 그 필터는 IPv4 만 남기고 IPv6(TCPv6)를
    //    버린다. Vite 는 `[::1]` 에 바인딩하므로 5173/5174 를 통째로 놓친다(실제로 놓쳤다).
    return [
      ...new Set(
        sh(`netstat -ano`)
          .split('\n')
          .filter((l) => /LISTENING/i.test(l) && new RegExp(`[:.]${port}\\s`).test(l))
          .map((l) => l.trim().split(/\s+/).pop())
          .filter((p) => p && p !== '0'),
      ),
    ];
  }
  return sh(`lsof -ti tcp:${port} -sTCP:LISTEN`).split('\n').filter(Boolean);
}

/**
 * 포트를 안 쓰는 프로세스(감독·목 게이트웨이)는 명령줄로 찾는다.
 *
 * ⚠️ PowerShell 안에서 큰따옴표를 쓰면 안 된다 — `-Command "..."` 의 따옴표와 겹쳐
 *    조용히 빈 결과가 나온다(실제로 그래서 감독을 못 찾고 계속 되살아났다).
 *    전부 작은따옴표로 쓴다.
 */
function pidsByCommandLine(needle) {
  if (!isWin) return sh(`pgrep -f ${needle}`).split('\n').filter(Boolean);
  const ps =
    `Get-CimInstance Win32_Process | ` +
    `Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*${needle}*' } | ` +
    `ForEach-Object { $_.ProcessId }`;
  return sh(`powershell -NoProfile -Command "${ps}"`)
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

function kill(pid) {
  sh(isWin ? `taskkill /F /PID ${pid}` : `kill -9 ${pid}`);
}

let killed = 0;

// ⚠️ 순서가 중요하다. `dev:all` 은 **자식이 죽으면 다시 띄우는 감독 프로세스**다.
//    포트부터 죽이면 감독이 즉시 되살려서 아무리 죽여도 계속 살아 있다(실제로 그랬다).
//    감독을 먼저 없앤 다음 포트를 정리한다.
for (const needle of ['dev-all', 'mock-gateway']) {
  for (const pid of pidsByCommandLine(needle)) {
    kill(pid);
    console.log(`  ${needle} → pid ${pid} 종료 (감독)`);
    killed++;
  }
}

for (const port of PORTS) {
  for (const pid of pidsOnPort(port)) {
    kill(pid);
    console.log(`  :${port} → pid ${pid} 종료`);
    killed++;
  }
}

// 남은 게 있는지 확인해서 알린다 — "정지했다" 고만 하고 실제로 안 죽으면 더 헷갈린다
const still = PORTS.filter((p) => pidsOnPort(p).length > 0);
console.log(
  killed === 0
    ? '[stop] 떠 있는 프로세스 없음'
    : `[stop] ${killed}개 종료${still.length ? ` — ⚠️ 아직 잡혀 있음: ${still.join(', ')}` : ''}`,
);
process.exit(still.length ? 1 : 0);
