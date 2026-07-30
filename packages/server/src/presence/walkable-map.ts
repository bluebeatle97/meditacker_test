import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

interface WalkableFile {
  cell: number;
  cols: number;
  rows: number;
  grid: string[]; // '1' = 통행 가능, '0' = 벽/샤프트
}

/**
 * 워크어블 맵 — 도면에서 추출한 벽 정보로 위치 추정 좌표를 보정한다.
 *
 * RSSI 가중평균 좌표는 물리적 벽을 모르기 때문에 방 경계(벽) 위나 벽 너머에
 * 찍힐 수 있다. 이 맵으로 벽에 걸린 좌표를 가장 가까운 통행 가능 지점으로 스냅.
 *
 * ⚠️ 운영 화면(/staff, /patient)에만 적용. 관제 페이지(/monitor)는 raw 좌표를
 *    그대로 봐야 신호 품질·게이트웨이 배치를 튜닝할 수 있다.
 */
export class WalkableMap {
  private cell: number;
  private cols: number;
  private rows: number;
  private walkable: Uint8Array;
  /** 각 셀 → 가장 가까운 통행가능 셀 인덱스 (multi-source BFS 로 사전 계산) */
  private nearest: Int32Array;

  constructor(file?: string) {
    const path = file ?? join(here, '../config/walkable.json');
    const data = JSON.parse(readFileSync(path, 'utf-8')) as WalkableFile;
    this.cell = data.cell;
    this.cols = data.cols;
    this.rows = data.rows;

    const n = this.cols * this.rows;
    this.walkable = new Uint8Array(n);
    for (let gy = 0; gy < this.rows; gy++) {
      const row = data.grid[gy];
      for (let gx = 0; gx < this.cols; gx++) {
        if (row.charCodeAt(gx) === 49 /* '1' */) this.walkable[gy * this.cols + gx] = 1;
      }
    }

    // 통행가능 셀을 시드로 BFS → 모든 셀의 최근접 통행가능 셀
    this.nearest = new Int32Array(n).fill(-1);
    const queue = new Int32Array(n);
    let head = 0;
    let tail = 0;
    for (let i = 0; i < n; i++) {
      if (this.walkable[i]) {
        this.nearest[i] = i;
        queue[tail++] = i;
      }
    }
    while (head < tail) {
      const i = queue[head++];
      const gx = i % this.cols;
      const gy = (i - gx) / this.cols;
      const src = this.nearest[i];
      if (gx > 0) tail = this.expand(i - 1, src, queue, tail);
      if (gx < this.cols - 1) tail = this.expand(i + 1, src, queue, tail);
      if (gy > 0) tail = this.expand(i - this.cols, src, queue, tail);
      if (gy < this.rows - 1) tail = this.expand(i + this.cols, src, queue, tail);
    }
  }

  /** BFS 확장 — 미방문 셀에 최근접 통행가능 셀을 전파 */
  private expand(idx: number, src: number, queue: Int32Array, tail: number): number {
    if (this.nearest[idx] === -1) {
      this.nearest[idx] = src;
      queue[tail++] = idx;
    }
    return tail;
  }

  /** 좌표(도면 픽셀)를 통행 가능 지점으로 보정. 이미 유효하면 그대로 반환 */
  clamp(x: number, y: number): { x: number; y: number } {
    let gx = Math.floor(x / this.cell);
    let gy = Math.floor(y / this.cell);
    gx = Math.max(0, Math.min(this.cols - 1, gx));
    gy = Math.max(0, Math.min(this.rows - 1, gy));
    const i = gy * this.cols + gx;
    if (this.walkable[i]) return { x, y };

    const near = this.nearest[i];
    if (near < 0) return { x, y }; // 통행가능 셀이 아예 없는 경우(비정상)
    const nx = near % this.cols;
    const ny = (near - nx) / this.cols;
    return { x: (nx + 0.5) * this.cell, y: (ny + 0.5) * this.cell };
  }

  stats(): { cols: number; rows: number; cell: number; walkable: number } {
    let w = 0;
    for (const v of this.walkable) w += v;
    return { cols: this.cols, rows: this.rows, cell: this.cell, walkable: w };
  }
}
