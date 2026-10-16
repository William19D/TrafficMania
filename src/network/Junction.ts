// Junction plans: light phases per movement, protected lefts and turn bans. Value imports from RoadGraph would be circular: types only.
import type { Node, Edge } from './RoadGraph.ts';
import { TIERS } from '../core/config.ts';
import type { Tier } from '../core/config.ts';

export const LIGHT_PERIOD = 5, PHASE_MIN = 3, PHASE_MAX = 30, MAX_PHASES = 6;
// Movement classes; a U-turn counts as a left
export const LEFT = 0, STRAIGHT = 1, RIGHT = 2;
export type Move = 0 | 1 | 2;
export type Signal = 0 | 1 | 2; // red, go but yield (a permissive left gives way to the opposite approach), protected
// sig[approach][move]; ban[approach][move]. approaches: angles of the edges leaving the node, sorted.
export interface Phase { seconds: number; sig: Signal[][] }
// lanes[approach]: lane arrows, a move bitmask (1 << Move) per incoming lane, left to right; null / missing = auto (the default lane choice)
export interface JunctionPlan { approaches: number[]; phases: Phase[]; ban: boolean[][]; lanes?: (number[] | null)[] }
export type Preset = 'two' | 'lefts' | 'each';
const MATCH = Math.PI / 12; // 15 degrees

const other = (n: Node, e: Edge): Node => e.a === n ? e.b : e.a;
export const edgeAngle = (n: Node, e: Edge): number => { const o = other(n, e); return Math.atan2(o.y - n.y, o.x - n.x); };
const diff = (a: number, b: number): number => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
// Light axis group of an approach angle: opposite approaches share one
const group = (a: number): number => ((Math.round(a / (Math.PI / 2)) % 2) + 2) % 2;
export const lightGroup = (n: Node, e: Edge): number => group(edgeAngle(n, e));

// Turn from p through n to q: 1 right, -1 left or U-turn, 0 straight. y points down, so a positive cross product is a right turn on screen.
export function turnAt(p: { x: number; y: number }, n: { x: number; y: number }, q: { x: number; y: number }): -1 | 0 | 1 {
  const ax = n.x - p.x, ay = n.y - p.y, bx = q.x - n.x, by = q.y - n.y;
  const a = Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
  return Math.abs(a) > Math.PI * 0.95 ? -1 : a > Math.PI / 6 ? 1 : a < -Math.PI / 6 ? -1 : 0;
}
// Movement into n by edge 'in' and out by edge 'out'
export const moveOf = (n: Node, inE: Edge, out: Edge): Move => (turnAt(other(n, inE), n, other(n, out)) + 1) as Move;

export function approachOf(p: JunctionPlan, n: Node, e: Edge): number {
  const a = edgeAngle(n, e);
  let best = 0;
  p.approaches.forEach((x, i) => { if (diff(x, a) < diff(p.approaches[best], a)) best = i; });
  return best;
}
// The approach most opposite i (more than 150 degrees away), or -1
export function oppositeOf(p: JunctionPlan, i: number): number {
  let best = -1, d = Math.PI * 5 / 6;
  p.approaches.forEach((x, j) => { if (diff(x, p.approaches[i]) > d) { best = j; d = diff(x, p.approaches[i]); } });
  return best;
}

const grid = <T>(n: number, v: T): T[][] => Array.from({ length: n }, () => [v, v, v]);
// Presets on the approach angles: two = one phase per axis (lefts yield); lefts = per axis a protected-left phase then a through phase;
// each = one approach at a time
export function presetPhases(approaches: number[], kind: Preset): Phase[] {
  if (kind === 'each') return approaches.map((_, i) => ({ seconds: LIGHT_PERIOD, sig: approaches.map((__, j) => (i === j ? [2, 2, 2] : [0, 0, 0]) as Signal[]) }));
  const ph = (g: number, s: Signal[], seconds: number): Phase => ({ seconds, sig: approaches.map(a => (group(a) === g ? [...s] : [0, 0, 0]) as Signal[]) });
  if (kind === 'two') return [ph(0, [1, 2, 2], LIGHT_PERIOD), ph(1, [1, 2, 2], LIGHT_PERIOD)];
  return [ph(0, [2, 0, 2], PHASE_MIN), ph(0, [0, 2, 2], LIGHT_PERIOD), ph(1, [2, 0, 2], PHASE_MIN), ph(1, [0, 2, 2], LIGHT_PERIOD)];
}

// Default plan: no bans, two phases from lightGroup (phase 0 = group 0), so a light behaves as before plans existed
export function defaultPlan(n: Node): JunctionPlan {
  const approaches = n.edges.map(e => edgeAngle(n, e)).sort((a, b) => a - b);
  return { approaches, phases: presetPhases(approaches, 'two'), ban: grid(approaches.length, false) };
}

// ponytail: the default is rebuilt on every call (a few tiny arrays per light per tick); cache it on the node if lights ever show in a profile
export const planOf = (n: Node): JunctionPlan => n.plan ?? defaultPlan(n);
export const clonePlan = (p: JunctionPlan): JunctionPlan => JSON.parse(JSON.stringify(p)) as JunctionPlan;

// The node's roads still match its plan's approaches: one edge per approach, each within 15 degrees
export function planFits(n: Node, p: JunctionPlan): boolean {
  if (n.edges.length !== p.approaches.length) return false;
  const used = new Set(n.edges.map(e => approachOf(p, n, e)));
  return used.size === n.edges.length && n.edges.every(e => diff(edgeAngle(n, e), p.approaches[approachOf(p, n, e)]) < MATCH);
}

// Lane arrows. Auto: one lane takes every move; else the leftmost also turns left, the rightmost also right, all go straight
export const ANY = 7;
export const autoMasks = (k: number): number[] => Array.from({ length: k }, (_, i) => k === 1 ? ANY : (i ? 0 : 1) | 2 | (i === k - 1 ? 4 : 0));
export const inLanes = (n: Node, e: Edge): number => e.lanes.filter(l => l.to === n).length;
// The arrows of e's lanes into n, or null (auto, or the road's lane count changed since they were set)
// ponytail: a lane count change silently drops the arrows back to auto; remap them if players miss that
export function laneMasks(p: JunctionPlan, n: Node, e: Edge): number[] | null {
  const m = p.lanes?.[approachOf(p, n, e)];
  return m && m.length === inLanes(n, e) ? m : null;
}
// A movement is banned by its turn ban, or when no lane's arrow allows it
export const banned = (n: Node, inE: Edge, out: Edge): boolean => {
  const p = n.plan;
  if (!p) return false;
  const mv = moveOf(n, inE, out), m = laneMasks(p, n, inE);
  return p.ban[approachOf(p, n, inE)][mv] || (!!m && !m.some(x => x >> mv & 1));
};

// Priority junction: the main road is its highest tier (more lanes break ties); when more than two arms share it, the straightest pair
const RANK = Object.keys(TIERS) as Tier[];
const rank = (e: Edge): number => RANK.indexOf(e.type.tier) * 4 + e.type.lanes;
export function mainEdges(n: Node): Edge[] {
  const top = Math.max(...n.edges.map(rank));
  const c = n.edges.filter(e => rank(e) === top);
  if (c.length <= 2) return c;
  let pair = [c[0], c[1]], d = -1;
  for (let i = 0; i < c.length; i++) for (let j = i + 1; j < c.length; j++) {
    const x = diff(edgeAngle(n, c[i]), edgeAngle(n, c[j]));
    if (x > d) { d = x; pair = [c[i], c[j]]; }
  }
  return pair;
}

// Plan edits (Game.editPlan applies them to a copy)
export const toggleBan = (p: JunctionPlan, a: number, m: Move): void => { p.ban[a][m] = !p.ban[a][m]; };
export const cycleSig = (p: JunctionPlan, ph: number, a: number, m: Move): void => { p.phases[ph].sig[a][m] = ((p.phases[ph].sig[a][m] + 1) % 3) as Signal; };
export const setSeconds = (p: JunctionPlan, ph: number, s: number): void => { p.phases[ph].seconds = Math.max(PHASE_MIN, Math.min(PHASE_MAX, s)); };
export const addPhase = (p: JunctionPlan): void => {
  if (p.phases.length < MAX_PHASES) p.phases.push({ seconds: LIGHT_PERIOD, sig: grid(p.approaches.length, 0 as Signal) });
};
export const removePhase = (p: JunctionPlan, ph: number): void => { if (p.phases.length > 1) p.phases.splice(ph, 1); };
export const applyPreset = (p: JunctionPlan, kind: Preset): void => { p.phases = presetPhases(p.approaches, kind); };
export type LanePreset = 'auto' | 'left' | 'right' | 'any';
// Lane arrow presets for an approach of k lanes: left / right = the outermost lane only turns that way
export function setLanes(p: JunctionPlan, a: number, k: number, kind: LanePreset): void {
  const m = kind === 'auto' ? null : kind === 'any' ? autoMasks(k).map(() => ANY) : autoMasks(k);
  if (m && kind === 'left') m[0] = 1;
  if (m && kind === 'right') m[k - 1] = 4;
  (p.lanes ??= p.approaches.map(() => null))[a] = m;
}
// Toggles one arrow of lane i (of k); a lane keeps at least one
export function toggleArrow(p: JunctionPlan, a: number, k: number, i: number, mv: Move): void {
  const cur = p.lanes?.[a], m = cur && cur.length === k ? [...cur] : autoMasks(k), x = m[i] ^ (1 << mv);
  if (!x) return;
  m[i] = x;
  (p.lanes ??= p.approaches.map(() => null))[a] = m;
}
