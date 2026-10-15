// Basic geometry utilities
export interface Vec { x: number; y: number }

export const dist = (a: Vec, b: Vec): number => Math.hypot(a.x - b.x, a.y - b.y);

// p turned around a to the nearest multiple of 'step' radians, same distance
export function snapAngle(a: Vec, p: Vec, step: number): Vec {
  const d = dist(a, p), t = Math.round(Math.atan2(p.y - a.y, p.x - a.x) / step) * step;
  return { x: a.x + d * Math.cos(t), y: a.y + d * Math.sin(t) };
}

// Distance from p to segment ab; t clamped to 0..1
export function distToSegment(p: Vec, a: Vec, b: Vec): { d: number; t: number; point: Vec } {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  let t = l2 === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  const point = { x: a.x + dx * t, y: a.y + dy * t };
  return { d: dist(p, point), t, point };
}

// Proper intersection between ab and cd; null if parallel or the crossing is at an endpoint
export function segmentsCross(a: Vec, b: Vec, c: Vec, d: Vec): { t: number; u: number } | null {
  const rx = b.x - a.x, ry = b.y - a.y;
  const sx = d.x - c.x, sy = d.y - c.y;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-9) return null;
  const qx = c.x - a.x, qy = c.y - a.y;
  const t = (qx * sy - qy * sx) / den;
  const u = (qx * ry - qy * rx) / den;
  const e = 1e-3;
  if (t <= e || t >= 1 - e || u <= e || u >= 1 - e) return null;
  return { t, u };
}
