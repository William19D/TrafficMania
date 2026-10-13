// Cubic Bezier helpers for the click-click curve road tool
import type { Vec } from './geom.ts';
import { dist } from './geom.ts';
import { TILE } from '../network/RoadGraph.ts';

const bez = (a: Vec, p1: Vec, p2: Vec, b: Vec, t: number): Vec => {
  const u = 1 - t;
  const k0 = u * u * u, k1 = 3 * u * u * t, k2 = 3 * u * t * t, k3 = t * t * t;
  return { x: k0 * a.x + k1 * p1.x + k2 * p2.x + k3 * b.x, y: k0 * a.y + k1 * p1.y + k2 * p2.y + k3 * b.y };
};

// Samples the curve at equal arc-length steps of spacing..2*spacing; first point is a, last is b.
export function cubicPoints(a: Vec, p1: Vec, p2: Vec, b: Vec, spacing = TILE): Vec[] {
  const SUB = 64;
  const pts: Vec[] = [a];
  const acc: number[] = [0];
  for (let i = 1; i <= SUB; i++) {
    pts.push(bez(a, p1, p2, b, i / SUB));
    acc.push(acc[i - 1] + dist(pts[i - 1], pts[i]));
  }
  const len = acc[SUB];
  // floor, not round: every edge is >= spacing, so demolish (floor(length / TILE) per edge) refunds the curve
  const n = Math.max(1, Math.floor(len / spacing));
  const out: Vec[] = [{ x: a.x, y: a.y }];
  let j = 1;
  for (let k = 1; k < n; k++) {
    const target = (len * k) / n;
    while (j < SUB && acc[j] < target) j++;
    const seg = acc[j] - acc[j - 1];
    const f = seg > 0 ? (target - acc[j - 1]) / seg : 0;
    out.push({ x: pts[j - 1].x + (pts[j].x - pts[j - 1].x) * f, y: pts[j - 1].y + (pts[j].y - pts[j - 1].y) * f });
  }
  out.push({ x: b.x, y: b.y });
  return out;
}

// Control points from endpoint tangents (unit vectors pointing away from their endpoint); null = straight-ish.
export function autoControls(a: Vec, b: Vec, ta: Vec | null, tb: Vec | null): [Vec, Vec] {
  const L = dist(a, b) / 3;
  const dx = (b.x - a.x) / 3, dy = (b.y - a.y) / 3;
  const p1 = ta ? { x: a.x + ta.x * L, y: a.y + ta.y * L } : { x: a.x + dx, y: a.y + dy };
  const p2 = tb ? { x: b.x + tb.x * L, y: b.y + tb.y * L } : { x: b.x - dx, y: b.y - dy };
  return [p1, p2];
}

// Quadratic-equivalent controls so the curve bends toward handle q.
export function bendControls(a: Vec, b: Vec, q: Vec): [Vec, Vec] {
  return [
    { x: a.x + (2 / 3) * (q.x - a.x), y: a.y + (2 / 3) * (q.y - a.y) },
    { x: b.x + (2 / 3) * (q.x - b.x), y: b.y + (2 / 3) * (q.y - b.y) },
  ];
}
