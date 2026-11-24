import type { FillRun, Point, Stroke } from "../game/types";

/**
 * Flood fill works on a fixed 250 x 188 logical raster (the 4:3 canvas at
 * 1000 x 750 divided by four). Every committed action is replayed into it so
 * the bucket and eyedropper see exactly what the drawer sees.
 */
export const GRID_W = 250;
export const GRID_H = 188;
export const WHITE = "#FFFFFF";
const MAX_RUNS = 1200;

export const emptyGrid = (): string[] => new Array(GRID_W * GRID_H).fill(WHITE);

const index = (x: number, y: number) => y * GRID_W + x;
const clampX = (x: number) => Math.max(0, Math.min(GRID_W - 1, Math.floor(x)));
const clampY = (y: number) => Math.max(0, Math.min(GRID_H - 1, Math.floor(y)));

const setPixel = (grid: string[], x: number, y: number, color: string) => {
  if (x < 0 || y < 0 || x >= GRID_W || y >= GRID_H) return;
  grid[index(x, y)] = color;
};

const paintDisc = (grid: string[], cx: number, cy: number, radius: number, color: string) => {
  const r = Math.max(0.5, radius);
  const x0 = Math.floor(cx - r);
  const x1 = Math.ceil(cx + r);
  const y0 = Math.floor(cy - r);
  const y1 = Math.ceil(cy + r);
  const rr = r * r;
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= rr) setPixel(grid, x, y, color);
    }
  }
};

const paintSegment = (
  grid: string[],
  a: Point,
  b: Point,
  widthUnits: number,
  color: string,
) => {
  const ax = a.x * GRID_W;
  const ay = a.y * GRID_H;
  const bx = b.x * GRID_W;
  const by = b.y * GRID_H;
  const radius = Math.max(0.6, (widthUnits / 1000) * GRID_W) / 2;
  const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 0.75));
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    paintDisc(grid, ax + (bx - ax) * t, ay + (by - ay) * t, radius, color);
  }
};

const paintShape = (grid: string[], action: Stroke) => {
  if (action.x1 == null || action.y1 == null || action.x2 == null || action.y2 == null) return;
  const a = { x: action.x1, y: action.y1 };
  const b = { x: action.x2, y: action.y2 };
  const width = action.width || 4;
  if (action.kind === "line") {
    paintSegment(grid, a, b, width, action.color);
    return;
  }
  if (action.kind === "rect") {
    const corners = [
      { x: a.x, y: a.y },
      { x: b.x, y: a.y },
      { x: b.x, y: b.y },
      { x: a.x, y: b.y },
    ];
    for (let i = 0; i < 4; i += 1) paintSegment(grid, corners[i]!, corners[(i + 1) % 4]!, width, action.color);
    return;
  }
  if (action.kind === "ellipse") {
    const cx = (a.x + b.x) / 2;
    const cy = (a.y + b.y) / 2;
    const rx = Math.abs(b.x - a.x) / 2;
    const ry = Math.abs(b.y - a.y) / 2;
    const steps = Math.max(48, Math.ceil((rx + ry) * GRID_W));
    let previous = { x: cx + rx, y: cy };
    for (let i = 1; i <= steps; i += 1) {
      const angle = (i / steps) * Math.PI * 2;
      const point = { x: cx + Math.cos(angle) * rx, y: cy + Math.sin(angle) * ry };
      paintSegment(grid, previous, point, width, action.color);
      previous = point;
    }
  }
};

const paintFill = (grid: string[], action: Stroke) => {
  for (const run of action.runs ?? []) {
    const x0 = Math.floor(run.x * GRID_W);
    const y0 = Math.floor(run.y * GRID_H);
    const x1 = Math.ceil((run.x + run.w) * GRID_W);
    const y1 = Math.ceil((run.y + run.h) * GRID_H);
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) setPixel(grid, x, y, action.color);
    }
  }
};

/** Replays every committed action (including clear markers) into the grid. */
export function rasterize(actions: Stroke[]): string[] {
  let grid = emptyGrid();
  for (const action of actions) {
    if (action.kind === "clear") {
      grid = emptyGrid();
      continue;
    }
    if (action.kind === "fill") {
      paintFill(grid, action);
      continue;
    }
    if (action.kind === "line" || action.kind === "rect" || action.kind === "ellipse") {
      paintShape(grid, action);
      continue;
    }
    const color = action.tool === "eraser" ? WHITE : action.color;
    const points = action.points ?? [];
    if (points.length === 1) {
      paintDisc(grid, points[0]!.x * GRID_W, points[0]!.y * GRID_H, Math.max(0.6, (action.width / 1000) * GRID_W) / 2, color);
    }
    for (let i = 1; i < points.length; i += 1) {
      paintSegment(grid, points[i - 1]!, points[i]!, action.width, color);
    }
  }
  return grid;
}

export function sampleColor(grid: string[], point: Point): string {
  return grid[index(clampX(point.x * GRID_W), clampY(point.y * GRID_H))] ?? WHITE;
}

/**
 * Scanline BFS flood fill. Returns merged horizontal runs normalized to the
 * 1000 x 750 canvas so every client can render the exact same fill.
 */
export function floodFillRuns(grid: string[], point: Point, color: string): FillRun[] {
  const startX = clampX(point.x * GRID_W);
  const startY = clampY(point.y * GRID_H);
  const target = grid[index(startX, startY)]!;
  if (target === color) return [];

  const visited = new Uint8Array(GRID_W * GRID_H);
  const stack: Array<[number, number]> = [[startX, startY]];
  const runs: FillRun[] = [];

  while (stack.length && runs.length < MAX_RUNS) {
    const [sx, sy] = stack.pop()!;
    if (visited[index(sx, sy)] || grid[index(sx, sy)] !== target) continue;

    let left = sx;
    let right = sx;
    while (left - 1 >= 0 && !visited[index(left - 1, sy)] && grid[index(left - 1, sy)] === target) left -= 1;
    while (right + 1 < GRID_W && !visited[index(right + 1, sy)] && grid[index(right + 1, sy)] === target) right += 1;

    for (let x = left; x <= right; x += 1) {
      visited[index(x, sy)] = 1;
      grid[index(x, sy)] = color;
    }
    runs.push({ x: left / GRID_W, y: sy / GRID_H, w: (right - left + 1) / GRID_W, h: 1 / GRID_H });

    for (const ny of [sy - 1, sy + 1]) {
      if (ny < 0 || ny >= GRID_H) continue;
      let x = left;
      while (x <= right) {
        if (!visited[index(x, ny)] && grid[index(x, ny)] === target) {
          stack.push([x, ny]);
          while (x <= right && grid[index(x, ny)] === target) x += 1;
        } else {
          x += 1;
        }
      }
    }
  }

  return runs;
}
