/**
 * Generates the Neo-Brutalist launcher icon, adaptive foreground, splash mark
 * and favicon as crisp PNGs with no image dependencies.
 *
 * Run from apps/mobile: `node scripts/generate-assets.mjs`
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), "..", "assets");

const PAPER = "#FFFDF7";
const INK = "#000000";
const YELLOW = "#FFD600";
const WHITE = "#FFFFFF";
const AMBER = "#FFE082";

const hex = (value) => {
  const clean = value.replace("#", "");
  return [
    Number.parseInt(clean.slice(0, 2), 16),
    Number.parseInt(clean.slice(2, 4), 16),
    Number.parseInt(clean.slice(4, 6), 16),
    255,
  ];
};

const SAMPLES = 3;

function createSurface(width, height) {
  return {
    width,
    height,
    w: width * SAMPLES,
    h: height * SAMPLES,
    data: Buffer.alloc(width * SAMPLES * height * SAMPLES * 4),
  };
}

function put(surface, px, py, rgba) {
  const index = (py * surface.w + px) * 4;
  surface.data[index] = rgba[0];
  surface.data[index + 1] = rgba[1];
  surface.data[index + 2] = rgba[2];
  surface.data[index + 3] = rgba[3];
}

function fillAll(surface, color) {
  const rgba = hex(color);
  for (let y = 0; y < surface.h; y += SAMPLES) {
    for (let x = 0; x < surface.w; x += SAMPLES) {
      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) put(surface, x + sx, y + sy, rgba);
      }
    }
  }
}

const roundedRectSdf = (px, py, x, y, width, height, radius) => {
  const cx = x + width / 2;
  const cy = y + height / 2;
  const qx = Math.abs(px - cx) - (width / 2 - radius);
  const qy = Math.abs(py - cy) - (height / 2 - radius);
  return (
    Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius
  );
};

function paint(surface, bounds, test, color) {
  const rgba = hex(color);
  const [x0, y0, x1, y1] = bounds(
    Math.floor,
    Math.ceil,
  );
  const startX = Math.max(0, x0);
  const startY = Math.max(0, y0);
  const endX = Math.min(surface.w, x1);
  const endY = Math.min(surface.h, y1);
  for (let py = startY; py < endY; py += 1) {
    for (let px = startX; px < endX; px += 1) {
      if (test((px + 0.5) / SAMPLES, (py + 0.5) / SAMPLES)) put(surface, px, py, rgba);
    }
  }
}

function fillRoundedRect(surface, x, y, width, height, radius, color) {
  paint(
    surface,
    (floor, ceil) => [
      floor((x - 1) * SAMPLES),
      floor((y - 1) * SAMPLES),
      ceil((x + width + 1) * SAMPLES),
      ceil((y + height + 1) * SAMPLES),
    ],
    (px, py) => roundedRectSdf(px, py, x, y, width, height, radius) <= 0,
    color,
  );
}

function strokeRoundedRect(surface, x, y, width, height, radius, stroke, color) {
  const half = stroke / 2;
  paint(
    surface,
    (floor, ceil) => [
      floor((x - stroke) * SAMPLES),
      floor((y - stroke) * SAMPLES),
      ceil((x + width + stroke) * SAMPLES),
      ceil((y + height + stroke) * SAMPLES),
    ],
    (px, py) => Math.abs(roundedRectSdf(px, py, x, y, width, height, radius)) <= half,
    color,
  );
}

function fillPolygon(surface, points, color) {
  const xs = points.map(([px]) => px);
  const ys = points.map(([, py]) => py);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  paint(
    surface,
    (floor, ceil) => [floor(minX * SAMPLES), floor(minY * SAMPLES), ceil(maxX * SAMPLES), ceil(maxY * SAMPLES)],
    (px, py) => {
      let inside = false;
      for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
        const [xi, yi] = points[i];
        const [xj, yj] = points[j];
        if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
      }
      return inside;
    },
    color,
  );
}

function strokeSegment(surface, x1, y1, x2, y2, width, color) {
  const half = width / 2;
  paint(
    surface,
    (floor, ceil) => [
      floor((Math.min(x1, x2) - width) * SAMPLES),
      floor((Math.min(y1, y2) - width) * SAMPLES),
      ceil((Math.max(x1, x2) + width) * SAMPLES),
      ceil((Math.max(y1, y2) + width) * SAMPLES),
    ],
    (px, py) => {
      const dx = x2 - x1;
      const dy = y2 - y1;
      const lengthSq = dx * dx + dy * dy;
      const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lengthSq));
      return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy)) <= half;
    },
    color,
  );
}

function strokePolyline(surface, points, width, color) {
  for (let index = 1; index < points.length; index += 1) {
    const [x1, y1] = points[index - 1];
    const [x2, y2] = points[index];
    strokeSegment(surface, x1, y1, x2, y2, width, color);
  }
}

function strokePolygon(surface, points, width) {
  strokePolyline(surface, [...points, points[0]], width, INK);
}

function downsample(surface) {
  const out = Buffer.alloc(surface.width * surface.height * 4);
  const count = SAMPLES * SAMPLES;
  for (let y = 0; y < surface.height; y += 1) {
    for (let x = 0; x < surface.width; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const index = ((y * SAMPLES + sy) * surface.w + (x * SAMPLES + sx)) * 4;
          const alpha = surface.data[index + 3];
          r += surface.data[index] * alpha;
          g += surface.data[index + 1] * alpha;
          b += surface.data[index + 2] * alpha;
          a += alpha;
        }
      }
      const index = (y * surface.width + x) * 4;
      if (a > 0) {
        out[index] = Math.round(r / a);
        out[index + 1] = Math.round(g / a);
        out[index + 2] = Math.round(b / a);
        out[index + 3] = Math.round(a / count);
      }
    }
  }
  return out;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function writePng(path, width, height, rgba) {
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * stride] = 0;
    rgba.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  writeFileSync(path, png);
}

const COS = Math.SQRT1_2;
const SIN = -Math.SQRT1_2;

/** Pencil + scribble, authored in tile-local coordinates centred on (372,372). */
function drawPencil(surface, tile) {
  const { x, y, size } = tile;
  const k = size / 744;
  const centerX = x + size / 2;
  const centerY = y + size / 2;
  const map = ([lx, ly]) => [
    centerX + (lx * COS - ly * SIN) * k,
    centerY + (lx * SIN + ly * COS) * k,
  ];
  const outline = Math.max(7, 32 * k);
  const detail = Math.max(4, 15 * k);

  const body = [
    [-136, -58],
    [144, -58],
    [144, 58],
    [-136, 58],
  ].map(map);
  const eraser = [
    [144, -58],
    [196, -58],
    [196, 58],
    [144, 58],
  ].map(map);
  const tip = [
    [-136, -58],
    [-196, 0],
    [-136, 58],
  ].map(map);
  const lead = [
    [-196, 0],
    [-172, -17],
    [-172, 17],
  ].map(map);
  const scribble = [
    [-122, 238],
    [-52, 198],
    [18, 248],
    [88, 198],
    [158, 248],
    [228, 213],
  ].map(map);

  // Chunkier outer outline, then interior fills leave the crisp ink edge.
  strokePolygon(surface, body, outline);
  strokePolygon(surface, eraser, outline);
  strokePolygon(surface, tip, outline);
  strokePolyline(surface, scribble, outline * 0.85, INK);

  fillPolygon(surface, body, WHITE);
  fillPolygon(surface, eraser, AMBER);
  fillPolygon(surface, tip, WHITE);
  fillPolygon(surface, lead, INK);

  const bandTop = map([144, -58]);
  const bandBottom = map([144, 58]);
  strokeSegment(surface, bandTop[0], bandTop[1], bandBottom[0], bandBottom[1], detail, INK);

  const tipTop = map([-136, -58]);
  const tipBottom = map([-136, 58]);
  strokeSegment(surface, tipTop[0], tipTop[1], tipBottom[0], tipBottom[1], detail, INK);
}

function drawBadge(surface, tile, background) {
  if (background) fillAll(surface, background);
  const { x, y, size, radius, shadow } = tile;
  if (shadow > 0) {
    fillRoundedRect(surface, x + shadow, y + shadow, size, size, radius, INK);
  }
  fillRoundedRect(surface, x, y, size, size, radius, YELLOW);
  strokeRoundedRect(surface, x, y, size, size, radius, Math.max(6, size * 0.037), INK);
  drawPencil(surface, tile);
}

function render(name, width, height, background, tile) {
  const surface = createSurface(width, height);
  drawBadge(surface, tile, background);
  writePng(join(ASSETS, name), width, height, downsample(surface));
  console.log(`wrote assets/${name} (${width}x${height})`);
}

mkdirSync(ASSETS, { recursive: true });

render("icon.png", 1024, 1024, PAPER, { x: 140, y: 140, size: 744, radius: 150, shadow: 34 });
render("adaptive-icon.png", 1024, 1024, null, {
  x: 252,
  y: 252,
  size: 520,
  radius: 112,
  shadow: 22,
});
render("splash-icon.png", 1024, 1024, null, {
  x: 122,
  y: 122,
  size: 780,
  radius: 168,
  shadow: 36,
});
render("favicon.png", 192, 192, PAPER, { x: 26, y: 26, size: 140, radius: 32, shadow: 8 });
