/**
 * 로컬 스택 전체를 한 번에 띄운다 (상시 개발용).
 *
 *   npm run dev:all
 *
 *   MQTT 브로커(1883) · 서버(8080) · 직원용(5173) · 환자용(5174) · 목 게이트웨이
 *
 * - **이미 떠 있는 포트는 건너뛴다** — 다른 창에서 일부만 켜 놨어도 충돌 없이 나머지만 올린다.
 * - 프로세스가 죽으면 자동 재시작한다 (몇 초 간격, 연속 실패는 포기).
 * - Ctrl+C 한 번으로 전부 정리한다.
 *
 * 목 게이트웨이는 포트를 안 쓰므로 실행 여부를 알 수 없다 → 이미 돌고 있으면
 * `--no-mock` 으로 빼고 띄운다.
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/** 색깔은 로그를 눈으로 구분하기 위한 것 (없으면 어느 프로세스 로그인지 모른다) */
const SERVICES = [
  { name: 'broker ', color: '\x1b[35m', port: 1883, args: ['run', 'dev:broker', '-w', '@meditracker/server'] },
  { name: 'server ', color: '\x1b[36m', port: 8080, args: ['run', 'dev', '-w', '@meditracker/server'] },
  { name: 'staff  ', color: '\x1b[32m', port: 5173, args: ['run', 'dev', '-w', '@meditracker/web-staff'] },
  { name: 'patient', color: '\x1b[33m', port: 5174, args: ['run', 'dev', '-w', '@meditracker/web-patient'] },
  { name: 'mock:gw', color: '\x1b[34m', port: null, args: ['run', 'mock:gw', '-w', '@meditracker/server'] },
];
const RESET = '\x1b[0m';

function connects(port, host) {
  return new Promise((done) => {
    const sock = net.connect({ port, host });
    const finish = (ok) => {
      sock.destroy();
      done(ok);
    };
    sock.setTimeout(600);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
  });
}

/**
 * 포트가 이미 쓰이는지. IPv4·IPv6 를 **둘 다** 봐야 한다 —
 * Vite 는 localhost(::1)에 붙어서 127.0.0.1 만 확인하면 비어 있는 줄 안다.
 */
async function portBusy(port) {
  return (await connects(port, '127.0.0.1')) || (await connects(port, '::1'));
}

const children = new Set();
let stopping = false;

function start(svc, attempt = 0) {
  // 윈도우에서 npm.cmd 는 shell 없이는 못 띄운다 → 한 줄 명령으로 넘긴다
  //    (args 배열 + shell:true 조합은 Node 가 경고를 뱉는다)
  const child = spawn(`${NPM} ${svc.args.join(' ')}`, { cwd: ROOT, shell: true });
  children.add(child);

  const pipe = (stream) => {
    let buf = '';
    stream.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim()) console.log(`${svc.color}[${svc.name}]${RESET} ${line}`);
      }
    });
  };
  pipe(child.stdout);
  pipe(child.stderr);

  child.on('exit', (code) => {
    children.delete(child);
    if (stopping) return;
    console.log(`${svc.color}[${svc.name}]${RESET} 종료 (code ${code})`);
    if (attempt >= 3) {
      console.log(`${svc.color}[${svc.name}]${RESET} 3회 연속 실패 — 재시작 포기`);
      return;
    }
    setTimeout(() => start(svc, attempt + 1), 3000);
  });
}

for (const svc of SERVICES) {
  if (svc.name.trim() === 'mock:gw' && process.argv.includes('--no-mock')) {
    console.log(`${svc.color}[${svc.name}]${RESET} --no-mock 지정 — 건너뜀`);
    continue;
  }
  if (svc.port && (await portBusy(svc.port))) {
    console.log(`${svc.color}[${svc.name}]${RESET} 포트 ${svc.port} 이미 사용 중 — 건너뜀`);
    continue;
  }
  console.log(`${svc.color}[${svc.name}]${RESET} 시작…`);
  start(svc);
}

console.log(`
  직원용   http://localhost:5173
  환자용   http://localhost:5174
  관제     http://localhost:8080/monitor

  Ctrl+C 로 전부 종료
`);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    stopping = true;
    for (const c of children) c.kill();
    process.exit(0);
  });
}
