// Interchange templates: geometry only. A template is drawn in the junction's frame: u along the main road (the through road of a
// trumpet), v along the crossing road (the stem), screen-handed like x/y so right-hand traffic holds; Game maps it onto the real
// arms and builds every path with planPath. ends: the levels at the first / last point; level: the top of its ramp profile;
// ramp: a one-way ramp, else the crossing road rebuilt with its own type.
import type { Vec } from '../util/geom.ts';
import { cubicPoints } from '../util/curve.ts';

export type Ichg = 'diamond' | 'clover' | 'trumpet';
export interface TPath { pts: Vec[]; ends: [number, number]; level: number; ramp: boolean }
export interface TControl { p: Vec; level: number; kind: 'yield' | 'light' }
// arms: roads at the junction; reach: how far the main road must run straight; cut: where the crossing road is cut and rebuilt
export interface Template { label: string; tip: string; arms: 3 | 4; reach: number; cut: number; paths: TPath[]; controls: TControl[] }

const v = (x: number, y: number): Vec => ({ x, y });
const line = (a: Vec, b: Vec, n: number): Vec[] => Array.from({ length: n + 1 }, (_, i) => v(a.x + (b.x - a.x) * i / n, a.y + (b.y - a.y) * i / n));
// Clockwise on screen from angle t0 to t1 (t1 > t0), about every 40px
const arc = (cx: number, cy: number, r: number, t0: number, t1: number): Vec[] => {
  const n = Math.max(2, Math.round(r * (t1 - t0) / 40));
  return Array.from({ length: n + 1 }, (_, i) => v(cx + r * Math.cos(t0 + (t1 - t0) * i / n), cy + r * Math.sin(t0 + (t1 - t0) * i / n)));
};
const cubic = (a: Vec, p: Vec, q: Vec, b: Vec): Vec[] => cubicPoints(a, p, q, b);
// Catmull-Rom through the waypoints
const spline = (w: Vec[]): Vec[] => w.slice(1).flatMap((b, i) => {
  const a = w[i], p = w[i - 1] ?? a, q = w[i + 2] ?? b;
  return cubic(a, v(a.x + (b.x - p.x) / 6, a.y + (b.y - p.y) / 6), v(b.x - (q.x - a.x) / 6, b.y - (q.y - a.y) / 6), b).slice(i ? 1 : 0);
});
const ramp = (pts: Vec[], ends: [number, number], level = 2): TPath => ({ pts, ends, level, ramp: true });
const yields = (...ps: [number, number, number][]): TControl[] => ps.map(([x, y, level]) => ({ p: v(x, y), level, kind: 'yield' }));
const PI = Math.PI;

// Diamond: the crossing road rises to L2 over the main road; four straight one-way ramps join the main road (yield) to two lit
// terminals on the deck. Eastbound (+u) traffic keeps to the +v side.
const Q = 160, T = 80, DR = 200;
const diamond: Template = {
  label: 'Diamond', tip: 'Overpass with four ramps and two lit junctions on the bridge. Compact, cheap, lights on the crossing road.',
  arms: 4, reach: Q + 20, cut: DR,
  paths: [
    { pts: line(v(0, -DR), v(0, DR), 10), ends: [0, 0], level: 2, ramp: false },
    ramp([v(-Q, 0), v(0, T)], [0, 2]), ramp([v(0, T), v(Q, 0)], [2, 0]),
    ramp([v(Q, 0), v(0, -T)], [0, 2]), ramp([v(0, -T), v(-Q, 0)], [2, 0]),
  ],
  controls: [{ p: v(0, T), level: 2, kind: 'light' }, { p: v(0, -T), level: 2, kind: 'light' }, ...yields([Q, 0, 0], [-Q, 0, 0])],
};

// Cloverleaf: overpass, four 270-degree loops for the lefts (tangent to both roads, joining the deck at its nodes) and four outer
// ramps for the rights; no lights
const C = 60, D = 300, K = 30;
const clover: Template = {
  label: 'Cloverleaf', tip: 'Overpass, four loops and four outer ramps: no lights at all. Needs a boulevard or highway.',
  arms: 4, reach: D + 20, cut: D,
  paths: [
    { pts: line(v(0, -D), v(0, D), 15), ends: [0, 0], level: 2, ramp: false },
    ramp(arc(C, C, C, -PI / 2, PI), [0, 2]), ramp(arc(C, -C, C, PI, PI * 5 / 2), [2, 0]),
    ramp(arc(-C, -C, C, PI / 2, PI * 2), [0, 2]), ramp(arc(-C, C, C, 0, PI * 3 / 2), [2, 0]),
    ramp(cubic(v(0, D), v(0, D - K), v(D - K, 0), v(D, 0)), [0, 0], 0), ramp(cubic(v(D, 0), v(D - K, 0), v(0, K - D), v(0, -D)), [0, 0], 0),
    ramp(cubic(v(0, -D), v(0, K - D), v(K - D, 0), v(-D, 0)), [0, 0], 0), ramp(cubic(v(-D, 0), v(K - D, 0), v(0, D - K), v(0, D)), [0, 0], 0),
  ],
  controls: yields([C, 0, 0], [-C, 0, 0], [0, C, 2], [0, -C, 2], [D, 0, 0], [-D, 0, 0], [0, D, 0], [0, -D, 0]),
};

// Trumpet (stem toward +v): the stem rises over the through road and ends at X; on the near side two direct ramps, on the far side
// a loop (westbound to the stem) and a semi-direct ramp around it (stem to westbound)
const S = 200, TC = 70, X = -TC;
const trumpet: Template = {
  label: 'Trumpet', tip: 'Free-flowing 3-way: the side road crosses over, with a loop and three ramps. No lights.',
  arms: 3, reach: 360, cut: S,
  paths: [
    { pts: line(v(0, S), v(0, X), 6), ends: [0, 2], level: 2, ramp: false },
    ramp(cubic(v(-S, 0), v(-130, 20), v(-40, 160), v(0, S)), [0, 0], 0),
    ramp(cubic(v(0, S), v(40, 160), v(130, 20), v(S, 0)), [0, 0], 0),
    ramp(arc(-TC, -TC, TC, PI / 2, PI * 2), [0, 2]),
    ramp(spline([v(0, X), v(40, -150), v(0, -215), v(-110, -235), v(-215, -170), v(-255, -60), v(-340, 0)]), [2, 0]),
  ],
  controls: yields([0, S, 0], [-S, 0, 0], [S, 0, 0], [-TC, 0, 0], [-340, 0, 0], [0, X, 2]),
};

export const ICHG: Record<Ichg, Template> = { diamond, clover, trumpet };
export const ICHG_KEYS = Object.keys(ICHG) as Ichg[];
