// Lane connection editor on the map (Edit tool, a junction open in the panel): a handle at each incoming lane's stop line, a target
// zone on each road out, and a curve from a lane to each road its connections lead onto. Shared by Input (hit tests) and the renderer.
import type { Node, Edge } from '../network/RoadGraph.ts';
import { NODE_R } from '../network/RoadGraph.ts';
import type { Move } from '../network/Junction.ts';
import { approachOf, inLanes, links, moveOf, planOf } from '../network/Junction.ts';
import type { Vec } from '../util/geom.ts';
import { dist } from '../util/geom.ts';

export interface Handle { e: Edge; j: number; x: number; y: number; a: number; key: string } // a: approach (its colour)
export interface Target { o: Edge; x: number; y: number; ux: number; uy: number; w: number } // zone centre, direction out, half width
export interface Link { h: Handle; t: Target; mv: Move; c: number[]; key: string } // c: the cubic, sx sy c1x c1y c2x c2y ex ey
// The drag in progress (from a lane handle, or a line pressed on: was) and the hovered handle / line key; Input writes, the renderer reads
export const linkUI: { drag: { h: Handle; was: Link | null; x: number; y: number; t: Target | null; moved: boolean } | null; hover: string } = { drag: null, hover: '' };

export const editable = (n: Node | null): n is Node => !!n && n.control !== 'roundabout';
const roads = (n: Node): Edge[] => n.edges.filter(e => !e.drive);
// stop line distance: past the kerb of the widest road crossing
const stop = (n: Node): number => Math.max(NODE_R + 4, ...roads(n).map(e => e.width / 2 + 3));
const unit = (n: Node, e: Edge): [number, number] => {
  const o = e.a === n ? e.b : e.a, l = Math.hypot(o.x - n.x, o.y - n.y) || 1;
  return [(o.x - n.x) / l, (o.y - n.y) / l];
};
// Lane j into n (out: lane j out of n) at the stop line
const laneAt = (n: Node, e: Edge, j: number, out: boolean): Vec => {
  const [ux, uy] = unit(n, e), d = stop(n), o = e.lanes.filter(l => out ? l.from === n : l.to === n)[j]!.offset, f = out ? 1 : -1;
  return { x: n.x + ux * d - f * uy * o, y: n.y + uy * d + f * ux * o };
};

export function handles(n: Node): Handle[] {
  const p = planOf(n);
  return roads(n).flatMap(e => Array.from({ length: inLanes(n, e) }, (_, j) => ({ e, j, ...laneAt(n, e, j, false), a: approachOf(p, n, e), key: `${e.id}:${j}` })));
}
export function targets(n: Node): Target[] {
  return roads(n).filter(o => o.lanes.some(l => l.from === n)).map(o => {
    const ls = o.lanes.filter(l => l.from === n), [ux, uy] = unit(n, o), a = laneAt(n, o, 0, true), b = laneAt(n, o, ls.length - 1, true);
    return { o, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, ux, uy, w: dist(a, b) / 2 + 3.5 };
  });
}
// The curve from h onto t (move mv): it lands on the outer lane for a turn, the matching lane straight on
export function curve(n: Node, h: Handle, t: Target, mv: Move): number[] {
  const ko = t.o.lanes.filter(l => l.from === n).length, e = laneAt(n, t.o, mv === 0 ? 0 : mv === 2 ? ko - 1 : Math.min(h.j, ko - 1), true);
  return [h.x, h.y, h.x + (n.x - h.x) * 0.6, h.y + (n.y - h.y) * 0.6, e.x + (n.x - e.x) * 0.6, e.y + (n.y - e.y) * 0.6, e.x, e.y];
}
// ponytail: connections are per move class, so at a 5+ arm junction two roads out the same way share one (drawn to both)
export function linksOf(n: Node): Link[] {
  const p = planOf(n), ts = targets(n), m = new Map<Edge, number[]>();
  return handles(n).flatMap(h => {
    const x = m.get(h.e) ?? m.set(h.e, links(p, n, h.e)).get(h.e)!;
    return ts.filter(t => t.o !== h.e).flatMap(t => {
      const mv = moveOf(n, h.e, t.o);
      return x[h.j] >> mv & 1 ? [{ h, t, mv, c: curve(n, h, t, mv), key: `${h.key}:${t.o.id}` }] : [];
    });
  });
}

const near = <T extends Vec>(xs: T[], w: Vec, r: number): T | null => {
  let best: T | null = null, bd = r;
  for (const x of xs) { const d = dist(x, w); if (d < bd) { best = x; bd = d; } }
  return best;
};
export const handleAt = (n: Node, w: Vec, r: number): Handle | null => near(handles(n), w, r);
// A road out for a drag from h: the nearest zone (not h's own road) within a generous radius
export const targetAt = (n: Node, w: Vec, r: number, h: Handle): Target | null => near(targets(n).filter(t => t.o !== h.e), w, Math.max(NODE_R, r * 2.2));
export function linkAt(n: Node, w: Vec, r: number): Link | null {
  let best: Link | null = null, bd = r;
  for (const l of linksOf(n)) {
    const [sx, sy, ax, ay, bx, by, ex, ey] = l.c;
    for (let i = 1; i < 16; i++) {
      const t = i / 16, u = 1 - t;
      const d = dist(w, { x: u * u * u * sx + 3 * u * u * t * ax + 3 * u * t * t * bx + t * t * t * ex, y: u * u * u * sy + 3 * u * u * t * ay + 3 * u * t * t * by + t * t * t * ey });
      if (d < bd) { best = l; bd = d; }
    }
  }
  return best;
}
