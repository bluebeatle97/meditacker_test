/**
 * 통제구역(벽) 격자 + A* 경로탐색.
 *
 * 위치 추정 좌표가 방 A → 방 B 로 바뀔 때 직선으로 이으면 벽을 뚫고 지나간다.
 * 실제 사람은 문을 통해 돌아가므로, 통행 가능 격자에서 A* 로 경로를 찾아
 * 아바타가 그 경로를 따라 걷게 한다.
 */

export interface WalkableGrid {
  cell: number;
  cols: number;
  rows: number;
  grid: string[];
}

export class Pathfinder {
  readonly cell: number;
  readonly cols: number;
  readonly rows: number;
  private walk: Uint8Array;

  constructor(data: WalkableGrid) {
    this.cell = data.cell;
    this.cols = data.cols;
    this.rows = data.rows;
    this.walk = new Uint8Array(this.cols * this.rows);
    for (let gy = 0; gy < this.rows; gy++) {
      const row = data.grid[gy];
      for (let gx = 0; gx < this.cols; gx++) {
        if (row.charCodeAt(gx) === 49) this.walk[gy * this.cols + gx] = 1;
      }
    }
  }

  isWalkable(px: number, py: number): boolean {
    const gx = Math.floor(px / this.cell);
    const gy = Math.floor(py / this.cell);
    if (gx < 0 || gy < 0 || gx >= this.cols || gy >= this.rows) return false;
    return this.walk[gy * this.cols + gx] === 1;
  }

  /** 두 점을 직선으로 이을 때 벽에 걸리지 않는지 (경로 단순화에 사용) */
  hasLineOfSight(x0: number, y0: number, x1: number, y1: number): boolean {
    const dist = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.max(1, Math.ceil(dist / (this.cell / 2)));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      if (!this.isWalkable(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t)) return false;
    }
    return true;
  }

  /** 가장 가까운 통행 가능 셀 중심 (좌표가 벽에 있을 때 보정) */
  nearestWalkable(px: number, py: number, maxRing = 40): { x: number; y: number } {
    if (this.isWalkable(px, py)) return { x: px, y: py };
    const cgx = Math.floor(px / this.cell);
    const cgy = Math.floor(py / this.cell);
    for (let r = 1; r <= maxRing; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const gx = cgx + dx;
          const gy = cgy + dy;
          if (gx < 0 || gy < 0 || gx >= this.cols || gy >= this.rows) continue;
          if (this.walk[gy * this.cols + gx] === 1) {
            return { x: (gx + 0.5) * this.cell, y: (gy + 0.5) * this.cell };
          }
        }
      }
    }
    return { x: px, y: py };
  }

  /**
   * A* 경로 (도면 픽셀 좌표 waypoint 배열). 실패 시 null.
   * 8방향 이동, 대각선은 양옆이 모두 통행 가능할 때만 허용(벽 코너 관통 방지).
   */
  findPath(
    sx: number,
    sy: number,
    tx: number,
    ty: number,
    maxNodes = 60000,
  ): Array<{ x: number; y: number }> | null {
    const s = this.nearestWalkable(sx, sy);
    const t = this.nearestWalkable(tx, ty);
    const startIdx = this.idxOf(s.x, s.y);
    const goalIdx = this.idxOf(t.x, t.y);
    if (startIdx < 0 || goalIdx < 0) return null;
    if (startIdx === goalIdx) return [{ x: tx, y: ty }];

    const n = this.cols * this.rows;
    const gScore = new Float32Array(n).fill(Infinity);
    const fScore = new Float32Array(n).fill(Infinity);
    const cameFrom = new Int32Array(n).fill(-1);
    const closed = new Uint8Array(n);
    // 간단한 이진 힙
    const heap: number[] = [];
    const heapPush = (idx: number): void => {
      heap.push(idx);
      let i = heap.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (fScore[heap[p]] <= fScore[heap[i]]) break;
        [heap[p], heap[i]] = [heap[i], heap[p]];
        i = p;
      }
    };
    const heapPop = (): number => {
      const top = heap[0];
      const last = heap.pop()!;
      if (heap.length > 0) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1;
          const r = l + 1;
          let m = i;
          if (l < heap.length && fScore[heap[l]] < fScore[heap[m]]) m = l;
          if (r < heap.length && fScore[heap[r]] < fScore[heap[m]]) m = r;
          if (m === i) break;
          [heap[m], heap[i]] = [heap[i], heap[m]];
          i = m;
        }
      }
      return top;
    };

    const gxOf = (i: number): number => i % this.cols;
    const gyOf = (i: number): number => (i - (i % this.cols)) / this.cols;
    const h = (i: number): number => {
      const dx = Math.abs(gxOf(i) - gxOf(goalIdx));
      const dy = Math.abs(gyOf(i) - gyOf(goalIdx));
      return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
    };

    gScore[startIdx] = 0;
    fScore[startIdx] = h(startIdx);
    heapPush(startIdx);
    let expanded = 0;

    while (heap.length > 0) {
      const cur = heapPop();
      if (cur === goalIdx) break;
      if (closed[cur]) continue;
      closed[cur] = 1;
      if (++expanded > maxNodes) return null;

      const cgx = gxOf(cur);
      const cgy = gyOf(cur);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const ngx = cgx + dx;
          const ngy = cgy + dy;
          if (ngx < 0 || ngy < 0 || ngx >= this.cols || ngy >= this.rows) continue;
          const ni = ngy * this.cols + ngx;
          if (this.walk[ni] === 0 || closed[ni]) continue;
          if (dx !== 0 && dy !== 0) {
            // 대각선: 인접 두 칸이 모두 열려 있어야 (벽 코너 뚫기 방지)
            if (this.walk[cgy * this.cols + ngx] === 0 || this.walk[ngy * this.cols + cgx] === 0) {
              continue;
            }
          }
          const step = dx !== 0 && dy !== 0 ? Math.SQRT2 : 1;
          const tentative = gScore[cur] + step;
          if (tentative < gScore[ni]) {
            gScore[ni] = tentative;
            fScore[ni] = tentative + h(ni);
            cameFrom[ni] = cur;
            heapPush(ni);
          }
        }
      }
    }

    if (cameFrom[goalIdx] === -1 && goalIdx !== startIdx) return null;

    // 역추적 → 셀 중심 좌표
    const cells: number[] = [];
    for (let i: number = goalIdx; i !== -1; i = cameFrom[i]) {
      cells.push(i);
      if (i === startIdx) break;
    }
    cells.reverse();
    const raw = cells.map((i) => ({
      x: (gxOf(i) + 0.5) * this.cell,
      y: (gyOf(i) + 0.5) * this.cell,
    }));

    // 가시선 기반 단순화 — 격자 계단 모양을 직선 구간으로 합침.
    // ⚠️ 시작·끝은 보정된 좌표(s, t)를 써야 한다. 원본(sx,sy / tx,ty)은 벽·가구 위일 수
    //    있어서 그대로 쓰면 경로의 첫/마지막 구간이 벽을 통과한다.
    const simplified: Array<{ x: number; y: number }> = [];
    let anchor = { x: s.x, y: s.y };
    for (let i = 1; i < raw.length; i++) {
      if (!this.hasLineOfSight(anchor.x, anchor.y, raw[i].x, raw[i].y)) {
        simplified.push(raw[i - 1]);
        anchor = raw[i - 1];
      }
    }
    simplified.push({ x: t.x, y: t.y });
    return simplified;
  }

  private idxOf(px: number, py: number): number {
    const gx = Math.floor(px / this.cell);
    const gy = Math.floor(py / this.cell);
    if (gx < 0 || gy < 0 || gx >= this.cols || gy >= this.rows) return -1;
    return gy * this.cols + gx;
  }

  /** 통제구역 오버레이 텍스처용 캔버스 (blocked 셀만 반투명 채색) */
  makeOverlayCanvas(): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = this.cols * this.cell;
    c.height = this.rows * this.cell;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = 'rgba(220, 40, 40, 0.42)';
    for (let gy = 0; gy < this.rows; gy++) {
      for (let gx = 0; gx < this.cols; gx++) {
        if (this.walk[gy * this.cols + gx] === 0) {
          ctx.fillRect(gx * this.cell, gy * this.cell, this.cell, this.cell);
        }
      }
    }
    return c;
  }
}
