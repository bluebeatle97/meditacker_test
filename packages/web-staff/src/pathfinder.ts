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

/**
 * 벽에 붙지 않게 하는 값.
 *
 * 균일 비용 A* 는 **최단이기만 하면 어느 길이든 같은 값**이라, 타이브레이크에 따라
 * 벽을 스치는 경로가 그대로 나온다. 사람은 복도 한가운데로 걷고, 길안내 화살표가
 * 벽에 붙어 있으면 어디로 가라는 건지 읽히지 않는다. 벽에서 이 칸 수 안쪽이면
 * 가까울수록 비용을 더해 가운데로 밀어낸다.
 *
 * 문처럼 좁은 곳은 어느 칸을 골라도 똑같이 비싸므로 그대로 통과한다 — 우회하지 않는다.
 */
const CLEAR_CELLS = 4; // 격자 한 칸 4px → 16px, 캐릭터 폭만큼
const CLEAR_WEIGHT = 1.6; // 벽에 딱 붙은 칸이 한가운데보다 2.6배 비싸진다

export class Pathfinder {
  readonly cell: number;
  readonly cols: number;
  readonly rows: number;
  private walk: Uint8Array;
  /** 칸마다 더해지는 벽 근접 비용 (0 = 충분히 넓은 곳) */
  private wallCost: Float32Array;

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
    this.wallCost = this.buildWallCost();
  }

  /**
   * 벽에서 몇 칸 떨어졌는지를 벽에서 시작하는 너비우선 탐색으로 한 번에 구한다
   * (칸마다 주변을 훑으면 격자가 412x397 이라 눈에 띄게 느리다).
   */
  private buildWallCost(): Float32Array {
    const n = this.cols * this.rows;
    const dist = new Int16Array(n).fill(-1);
    let frontier: number[] = [];
    for (let i = 0; i < n; i++) {
      if (this.walk[i] === 0) {
        dist[i] = 0;
        frontier.push(i);
      }
    }
    for (let d = 1; d <= CLEAR_CELLS && frontier.length; d++) {
      const next: number[] = [];
      for (const i of frontier) {
        const gx = i % this.cols;
        const gy = (i - gx) / this.cols;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = gx + dx;
            const ny = gy + dy;
            if (nx < 0 || ny < 0 || nx >= this.cols || ny >= this.rows) continue;
            const ni = ny * this.cols + nx;
            if (dist[ni] !== -1) continue;
            dist[ni] = d;
            next.push(ni);
          }
        }
      }
      frontier = next;
    }
    const cost = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      // -1 = CLEAR_CELLS 보다 멀다 = 벽 신경 쓸 것 없음
      if (dist[i] > 0) cost[i] = (CLEAR_WEIGHT * (CLEAR_CELLS - dist[i] + 1)) / CLEAR_CELLS;
    }
    return cost;
  }

  isWalkable(px: number, py: number): boolean {
    const gx = Math.floor(px / this.cell);
    const gy = Math.floor(py / this.cell);
    if (gx < 0 || gy < 0 || gx >= this.cols || gy >= this.rows) return false;
    return this.walk[gy * this.cols + gx] === 1;
  }

  /**
   * 그 지점에서 좌우로 벽까지 이어지는 통행 가능 폭 (도면 px).
   * 방 이름 라벨을 방 안에 넣기 위한 가용 폭 측정용.
   */
  freeWidthAt(px: number, py: number): number {
    if (!this.isWalkable(px, py)) return 0;
    const maxX = this.cols * this.cell;
    let l = px;
    while (l - this.cell > 0 && this.isWalkable(l - this.cell, py)) l -= this.cell;
    let r = px;
    while (r + this.cell < maxX && this.isWalkable(r + this.cell, py)) r += this.cell;
    return r - l;
  }

  /** 그 지점에서 위아래로 벽까지 이어지는 통행 가능 구간 (도면 px) */
  freeSpanY(px: number, py: number): { top: number; bottom: number } {
    if (!this.isWalkable(px, py)) return { top: py, bottom: py };
    const maxY = this.rows * this.cell;
    let t = py;
    while (t - this.cell > 0 && this.isWalkable(px, t - this.cell)) t -= this.cell;
    let b = py;
    while (b + this.cell < maxY && this.isWalkable(px, b + this.cell)) b += this.cell;
    return { top: t, bottom: b };
  }

  private freeSpanX(px: number, py: number): { left: number; right: number } {
    if (!this.isWalkable(px, py)) return { left: px, right: px };
    const maxX = this.cols * this.cell;
    let l = px;
    while (l - this.cell > 0 && this.isWalkable(l - this.cell, py)) l -= this.cell;
    let r = px;
    while (r + this.cell < maxX && this.isWalkable(r + this.cell, py)) r += this.cell;
    return { left: l, right: r };
  }

  /**
   * 그 지점이 속한 방의 중심·크기 (도면 px). 방 이름 라벨을 방 가운데 놓는 데 쓴다.
   *
   * 연결영역 flood fill 은 못 쓴다 — 문이 열려 있어 복도·다른 방까지 번진다.
   * 통행가능 셀만의 최대 사각형도 못 쓴다 — 방 안 가구선에 걸려 얄쌍한 조각이 나온다.
   * 그래서 앵커 주변 몇 줄의 좌우/상하 벽 위치를 재고 **가장 좁은 쪽으로 교집합**을 잡는다.
   * 한 줄이 문틈을 지나 옆방까지 이어져도 나머지 줄이 그 폭을 되돌려 깎는다 —
   * 라벨이 옆방을 침범하지 않는 게 조금 큰 글씨보다 중요하다.
   */
  roomBoxAt(
    px: number,
    py: number,
    probe = 3,
  ): { cx: number; cy: number; w: number; h: number } | null {
    if (!this.isWalkable(px, py)) return null;
    let l = -Infinity;
    let r = Infinity;
    for (let i = -probe; i <= probe; i++) {
      const y = py + i * this.cell;
      if (!this.isWalkable(px, y)) continue;
      const s = this.freeSpanX(px, y);
      l = Math.max(l, s.left);
      r = Math.min(r, s.right);
    }
    let t = -Infinity;
    let b = Infinity;
    for (let i = -probe; i <= probe; i++) {
      const x = px + i * this.cell;
      if (!this.isWalkable(x, py)) continue;
      const s = this.freeSpanY(x, py);
      t = Math.max(t, s.top);
      b = Math.min(b, s.bottom);
    }
    if (!Number.isFinite(l) || !Number.isFinite(t)) return null;
    const x1 = r + this.cell;
    const y1 = b + this.cell;
    return { cx: (l + x1) / 2, cy: (t + y1) / 2, w: x1 - l, h: y1 - t };
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
          // 벽 근접 비용을 더한다 — 최단만 보면 벽을 스치는 경로가 나온다.
          // 휴리스틱은 거리만 보므로 여전히 하한이다(비용은 더해지기만 한다)
          const step = (dx !== 0 && dy !== 0 ? Math.SQRT2 : 1) + this.wallCost[ni];
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

  /**
   * 꺾은선을 **가로·세로 직선 구간으로만** 다시 만든다 (대각선 하나 → ㄱ자 둘).
   *
   * A* 는 대각선을 허용해서 방을 비스듬히 가로지르는 경로가 나온다. 아바타가 걸을 때는
   * 자연스럽지만 **바닥에 깔린 길안내 화살표는 비스듬하면 지저분하고 어디로 가라는 건지
   * 덜 읽힌다** — 복도를 쭉 가다 90도로 꺾는 편이 훨씬 명확하다.
   *
   * 모퉁이는 가로 먼저 / 세로 먼저 두 가지가 있는데, 둘 다 벽에 안 걸리면 **벽에서 먼
   * 쪽**을 고른다. 둘 다 걸리면(좁은 통로) 그 구간만 대각선으로 남긴다 — 억지로 펴면
   * 벽을 뚫는다.
   */
  orthogonalize(pts: Array<{ x: number; y: number }>): Array<{ x: number; y: number }> {
    if (pts.length < 2) return pts;
    const out = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      const a = out[out.length - 1];
      const b = pts[i];
      if (Math.abs(a.x - b.x) < 1 || Math.abs(a.y - b.y) < 1) {
        out.push(b); // 이미 가로 또는 세로
        continue;
      }
      const h = { x: b.x, y: a.y }; // 가로 먼저 꺾는 모퉁이
      const v = { x: a.x, y: b.y }; // 세로 먼저 꺾는 모퉁이
      const okH =
        this.hasLineOfSight(a.x, a.y, h.x, h.y) && this.hasLineOfSight(h.x, h.y, b.x, b.y);
      const okV =
        this.hasLineOfSight(a.x, a.y, v.x, v.y) && this.hasLineOfSight(v.x, v.y, b.x, b.y);
      if (okH && okV) out.push(this.wallCostAt(h) <= this.wallCostAt(v) ? h : v);
      else if (okH) out.push(h);
      else if (okV) out.push(v);
      else out.push(...this.elbowVia(a, b, 3)); // 한 번에 못 펴면 잘라서 다시 시도
      out.push(b);
    }
    return mergeCollinear(out);
  }

  /**
   * 한 번의 ㄱ자로는 벽에 걸리는 구간 — 가운데를 짚어 두 토막으로 나눠 각각 펴 본다.
   * 좁은 통로에서 통째로 펴면 벽을 뚫으므로, 여기서도 안 되면 그 구간만 비스듬히 둔다.
   */
  private elbowVia(
    a: { x: number; y: number },
    b: { x: number; y: number },
    depth: number,
  ): Array<{ x: number; y: number }> {
    if (depth <= 0) return [];
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    if (!this.isWalkable(mid.x, mid.y)) return [];
    const left = this.orthogonalStep(a, mid, depth - 1);
    const right = this.orthogonalStep(mid, b, depth - 1);
    if (!left || !right) return [];
    return [...left, mid, ...right];
  }

  /** 두 점 사이를 ㄱ자로 잇는 모퉁이 (안 되면 더 잘라서, 그래도 안 되면 null) */
  private orthogonalStep(
    a: { x: number; y: number },
    b: { x: number; y: number },
    depth: number,
  ): Array<{ x: number; y: number }> | null {
    if (Math.abs(a.x - b.x) < 1 || Math.abs(a.y - b.y) < 1) {
      return this.hasLineOfSight(a.x, a.y, b.x, b.y) ? [] : null;
    }
    const h = { x: b.x, y: a.y };
    const v = { x: a.x, y: b.y };
    const okH = this.hasLineOfSight(a.x, a.y, h.x, h.y) && this.hasLineOfSight(h.x, h.y, b.x, b.y);
    const okV = this.hasLineOfSight(a.x, a.y, v.x, v.y) && this.hasLineOfSight(v.x, v.y, b.x, b.y);
    if (okH && okV) return [this.wallCostAt(h) <= this.wallCostAt(v) ? h : v];
    if (okH) return [h];
    if (okV) return [v];
    const deeper = this.elbowVia(a, b, depth);
    return deeper.length ? deeper : null;
  }

  /** 이 지점의 벽 근접 비용 (모퉁이를 고를 때 더 넓은 쪽을 쓰려고) */
  private wallCostAt(p: { x: number; y: number }): number {
    const i = this.idxOf(p.x, p.y);
    return i < 0 ? Infinity : this.wallCost[i];
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

/** 같은 방향으로 이어지는 구간을 하나로 — 같은 직선 위 중간점은 그릴 것이 없다 */
function mergeCollinear(
  pts: Array<{ x: number; y: number }>,
): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  for (const p of pts) {
    const n = out.length;
    if (n >= 2) {
      const a = out[n - 2];
      const b = out[n - 1];
      // 세 점이 한 직선 위면 가운데를 버린다 (외적이 0)
      if (Math.abs((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) < 0.5) {
        out[n - 1] = p;
        continue;
      }
    }
    if (n === 0 || Math.hypot(p.x - out[n - 1].x, p.y - out[n - 1].y) > 0.5) out.push(p);
  }
  return out;
}
