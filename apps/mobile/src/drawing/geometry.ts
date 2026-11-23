import type { Point } from "../game/types";

/** Minimum normalized distance between sampled points (~1.5px on a 420px canvas). */
export const MIN_POINT_DISTANCE = 0.0035;

export function distance(a: Point, b: Point) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

export function clamp01(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Converts a touch position relative to the canvas into the normalized 0..1
 * space shared by every client, so replays match regardless of screen size.
 */
export function normalizeTouch(x: number, y: number, width: number, height: number): Point {
  if (width <= 0 || height <= 0) return { x: 0, y: 0 };
  return { x: clamp01(x / width), y: clamp01(y / height) };
}

export function shouldSamplePoint(previous: Point | undefined, next: Point) {
  if (!previous) return true;
  return distance(previous, next) >= MIN_POINT_DISTANCE;
}
