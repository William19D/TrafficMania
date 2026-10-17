import type { Vec } from '../util/geom.ts';
import { dist, distToSegment, segmentsCross } from '../util/geom.ts';
import type { Building } from '../entities/Building.ts';
import { DOOR_R } from '../entities/Building.ts';
import type { Car } from '../entities/Car.ts';
import { TIERS, TUNING } from '../core/config.ts';
import type { Tier } from '../core/config.ts';
import type { JunctionPlan, Move } from './Junction.ts';
import { ANY, LEFT, PRIORITY, STOP, approachOf, edgeAngle, laneMasks, moveOf, oppositeOf, planOf, signOf, turnAt } from './Junction.ts';
export { LIGHT_PERIOD, lightGroup } from './Junction.ts';

export const TILE = 40, ROAD_W = 18, LANE_OFFSET = 4.5, NODE_R = 12, CAR_LEN = 15, CAR_W = 8, GAP = 5;
// Where a car stops before a junction (distance from the node)
export const stopDist = (_n: Node): number => NODE_R + 3;
// Mid-edge lane change: slide seconds, and how far from both nodes it may start (past the node blends, the slide done
// before the end, room left for cars granted into the lane)
export const LC_S = 0.6, LC_M = 110;
// Max braking px/s/s. Merge: a driveway car takes a gap of MERGE_GAP s before road traffic reaches the junction; a car at the front
// of its lane for MERGE_S (a driveway, a yield side road, a permissive left) makes the traffic it gives way to let it in
export const BRAKE = 180, MERGE_GAP = 1, MERGE_S = 1;
// Sign junction: the gap (s) a yielding car needs before crossing traffic with priority reaches the box (CLEAR_M x that merging into its
// road out: it still has to get up to speed), and the wait at the front of its lane after which the crossing traffic lets it in
// (courtesy, so a side road never waits until it gives up)
export const CLEAR_S = 1.2, CLEAR_M = 1.6, STARVE_S = 4;
// px out from a light at which an ambulance turns it green
export const AMB_R = 60;

// Road types: tier (config TIERS), lanes PER DIRECTION; a one-way road only has lanes a->b
export const LANE_W = 9;
export interface RoadType { tier: Tier; lanes: 1 | 2 | 3; oneWay: boolean }
export const DEFAULT_TYPE: RoadType = { tier: 'street', lanes: 1, oneWay: false };
// Half the median: how far a two-way road's lanes sit out from the centre line
const halfMedian = (t: RoadType): number => t.oneWay ? 0 : TIERS[t.tier].median / 2;
export const roadWidth = (t: RoadType): number => t.lanes * (t.oneWay ? 1 : 2) * LANE_W + 2 * TIERS[t.tier].shoulder + 2 * halfMedian(t);
// Asphalt multiplier per tile (a two-way 1-lane road = 1)
export const laneFactor = (t: RoadType): number => (t.lanes * (t.oneWay ? 1 : 2)) / 2;
export const sameType = (a: RoadType, b: RoadType): boolean => a.tier === b.tier && a.lanes === b.lanes && a.oneWay === b.oneWay;
// Clamps lanes into the tier's range and drops one-way where the tier has none
export const fitType = (t: RoadType): RoadType => {
  const T = TIERS[t.tier];
  const lanes = Math.max(T.lanes[0], Math.min(T.lanes[T.lanes.length - 1], t.lanes)) as RoadType['lanes'];
  return { tier: t.tier, lanes, oneWay: t.oneWay && T.oneWay };
};

// Roundabout sizes (docs/design/game-v3.md 1): outer ring lane radius, chords round it, ring speed limit px/s, most arms, most lanes per
// direction on an arm, most ring lanes, cost / upkeep multiplier
export type RingSize = 0 | 1 | 2;
export type RingLanes = 1 | 2 | 3;
export const RINGS: readonly { label: string; r: number; n: number; v: number; arms: number; lanes: number; rl: RingLanes; cost: number }[] = [
  { label: 'Small', r: 22, n: 7, v: 45, arms: 4, lanes: 1, rl: 1, cost: 1 },
  { label: 'Medium', r: 34, n: 11, v: 58, arms: 5, lanes: 2, rl: 2, cost: 1.6 },
  { label: 'Large', r: 50, n: 16, v: 70, arms: 6, lanes: 3, rl: 3, cost: 2.4 },
];
// The ring road: its lanes one way and a shoulder each side (12px for one). Its nodes and outer lane run at RINGS r and more lanes lie
// inside it (buildLanes), so they take room from the island, not the clearance round the ring, and the arms meet the outer lane
const ringType = (k: RingLanes): RoadType => ({ tier: 'avenue', lanes: k, oneWay: true });
export const RING_W = roadWidth(ringType(1));
// Radius of the middle of a ring's road (its lanes centred), and its inner edge (the island's)
export const ringMid = (s: RingSize, k: RingLanes): number => RINGS[s].r - (k - 1) * LANE_W / 2;
export const ringIn = (s: RingSize, k: RingLanes): number => ringMid(s, k) - roadWidth(ringType(k)) / 2;
// Cost / upkeep multiplier of a ring: its size's, half again per extra lane
export const ringCost = (s: RingSize, k: RingLanes): number => RINGS[s].cost * (1 + 0.5 * (k - 1));
// Outer edge of the ring road; no other junction, split or driveway join within clearR
export const ringOut = (s: RingSize): number => RINGS[s].r + RING_W / 2;
export const clearR = (s: RingSize): number => ringOut(s) + 2 * NODE_R;
export const onRing = (n: Node): boolean => n.edges.some(e => !!e.ring);

// none: non-crossing cars together in arrival order; yield: priority signs per approach (Junction.signOf); stop: all-way stop
export type Control = 'none' | 'yield' | 'stop' | 'light' | 'roundabout';

export interface Node {
  id: number; x: number; y: number; edges: Edge[]; building: Building | null; control: Control;
  occupants: Set<Car>; queue: Car[]; phase: number; phaseTimer: number;
  controlDay: number; // day the control was built (refund rule)
  plan: JunctionPlan | null; // edited phases / lane connections; null = the default plan (Junction.planOf)
  ring: RingSize; // a ring's hub: its size (old saves: a 'roundabout' node's)
  delay: number; // EMA of the mean stopped seconds of the cars queued at it (heat map)
}

// INVARIANT: cars sorted ascending by s; the last one is the furthest ahead.
// offset: lateral px to the right of travel
export interface Lane { edge: Edge; from: Node; to: Node; cars: Car[]; offset: number }

export interface Edge {
  id: number; a: Node; b: Node; length: number; lanes: Lane[]; type: RoadType; width: number;
  bridge: boolean; tunnel: boolean; level: number;
  day: number; // build day (refund rule); a split keeps it
  drive: boolean; // auto driveway to a building: free, no upkeep, no refund
  exit: boolean; // a piece of a highway exit's stub (a split keeps it): free, no upkeep, no refund, never demolished
  heat: number; // congestion EMA 0..1: the larger of density and slowness (1 - speed / top speed) of its cars
  ring: Ring | null; // a roundabout's ring road: free, part of the control
}

// A roundabout: one-way ring edges joining its nodes counter-clockwise on screen (nodes[i] -> nodes[i + 1]); the cars entering from an
// arm merge into gaps in the ring traffic. Its hub stands in for it off the graph (the junction panel, the control price): control
// 'roundabout', ring = its size, controlDay, at the centre. spokes: per arm node, the arm piece the build took out there (the cheapest
// type per px, the oldest day), put back as its spoke when the ring goes, so a build and removal never mint a road. lanes: its ring
// lanes, inner to outer in each ring edge's lanes; a car keeps further in the further round it goes (RoadGraph.ringPick).
export interface Spoke { type: RoadType; day: number; drive: boolean; exit: boolean; out: boolean } // out: one-way away from the hub
export interface Ring { hub: Node; nodes: Node[]; spokes: Map<Node, Spoke>; lanes: RingLanes }

export interface EdgeFlags { bridge: boolean; tunnel: boolean; level: number; type: RoadType; drive?: boolean; exit?: boolean; ring?: Ring | null }

// A ramp joint: a plain joint between roads on two levels
export function rampJoint(n: Node): boolean {
  return !n.building && n.edges.length === 2 && n.edges[0].level !== n.edges[1].level;
}

// Deck height of e at its end n, in levels: a ramp joint sits at the lower of its two roads, so each ramp piece climbs one level over
// its length and the slope is continuous; any other node at its highest road.
// ponytail: drawing only (shadows, pillars); the sim keeps whole levels per edge
export function deckH(e: Edge, n: Node): number {
  const h = rampJoint(n) ? Math.min(n.edges[0].level, n.edges[1].level) : Math.max(0, ...n.edges.map(x => x.level));
  return Math.max(e.level - 1, Math.min(e.level, h));
}

export class RoadGraph {
  nodes: Node[] = [];
  edges: Edge[] = [];
  // Edges ignored by snapping / crossings / edgeBetween; only set while planning a bend
  hidden: Set<Edge> = new Set();
  // Traffic events (Events.ts, rebuilt each tick): edges closed to new routes, edges with a top speed factor, the rain's speed factor
  shut: Set<Edge> = new Set();
  slow: Map<Edge, number> = new Map();
  wet = 1;
  speedX(e: Edge): number { return this.wet * (this.slow.get(e) ?? 1); }
  rings: Ring[] = [];
  private nextId = 1;

  // A node off the graph (a ring's hub)
  node(x: number, y: number, building: Building | null = null): Node {
    return { id: this.nextId++, x, y, edges: [], building, control: 'none', occupants: new Set(), queue: [], phase: 0, phaseTimer: 0, controlDay: 0, plan: null, ring: 0, delay: 0 };
  }

  addNode(x: number, y: number, building: Building | null = null): Node {
    const n = this.node(x, y, building);
    if (building) building.node = n;
    this.nodes.push(n);
    return n;
  }

  addEdge(a: Node, b: Node, flags: EdgeFlags, day = 0): Edge {
    const e = {
      id: this.nextId++, a, b, length: dist(a, b),
      bridge: flags.bridge, tunnel: flags.tunnel, level: flags.level, day, drive: !!flags.drive, exit: !!flags.exit, heat: 0, ring: flags.ring ?? null,
    } as Edge;
    this.buildLanes(e, flags.type);
    a.edges.push(e);
    b.edges.push(e);
    this.edges.push(e);
    return e;
  }

  // Two-way: lane k sits (k + 0.5) lanes (plus half the median) right of the centre line; one-way: lanes centred on the axis, a ring's
  // with its outer lane on the axis
  private buildLanes(e: Edge, t: RoadType): void {
    e.type = { ...t };
    e.width = roadWidth(t);
    e.lanes = [];
    const lane = (from: Node, to: Node, offset: number): Lane => ({ edge: e, from, to, cars: [], offset });
    const m = halfMedian(t);
    for (let k = 0; k < t.lanes; k++) {
      if (t.oneWay) e.lanes.push(lane(e.a, e.b, (k - (t.lanes - 1) / (e.ring ? 1 : 2)) * LANE_W));
      else e.lanes.push(lane(e.a, e.b, (k + 0.5) * LANE_W + m), lane(e.b, e.a, (k + 0.5) * LANE_W + m));
    }
  }

  // Unlinks the edge without deleting nodes
  private unlink(e: Edge): void {
    this.edges = this.edges.filter(x => x !== e);
    e.a.edges = e.a.edges.filter(x => x !== e);
    e.b.edges = e.b.edges.filter(x => x !== e);
  }

  dropIfOrphan(n: Node): void {
    if (n.edges.length === 0 && !n.building) this.nodes = this.nodes.filter(x => x !== n);
  }

  removeEdge(e: Edge): Car[] {
    this.unlink(e);
    this.dropIfOrphan(e.a);
    this.dropIfOrphan(e.b);
    return e.lanes.flatMap(l => l.cars);
  }

  splitEdge(e: Edge, p: Vec): Node {
    const { a, b } = e;
    const flags: EdgeFlags = { bridge: e.bridge, tunnel: e.tunnel, level: e.level, type: e.type, drive: e.drive, exit: e.exit, ring: e.ring };
    const n = this.addNode(p.x, p.y);
    this.unlink(e);
    const e1 = this.addEdge(a, n, flags, e.day);
    const e2 = this.addEdge(n, b, flags, e.day);
    e1.heat = e2.heat = e.heat;
    if (e.ring) e.ring.nodes.splice(e.ring.nodes.indexOf(a) + 1, 0, n);
    // Distributes the cars keeping ascending order (iterated from lowest to highest s)
    const move = (old: Lane) => {
      const k = this.lanesFrom(e, old.from).indexOf(old);
      const fwd = old.from === a;
      const first = this.lanesFrom(fwd ? e1 : e2, old.from)[k];
      const second = this.lanesFrom(fwd ? e2 : e1, n)[k];
      const cut = fwd ? e1.length : e2.length;
      for (const c of old.cars) {
        if (c.s < cut) {
          // Now heading to the new node: release turn/queue of the old destination
          const old = second.to;
          if (c.granted === old) { old.occupants.delete(c); c.granted = null; }
          c.queued = false;
          first.cars.push(c); c.lane = first;
        }
        else { c.s -= cut; second.cars.push(c); c.lane = second; }
        c.path = null;
      }
      old.cars = [];
    };
    for (const l of e.lanes) move(l);
    return n;
  }

  // Re-types one edge in place; forward=false makes b->a the travel direction (swaps a/b).
  // Cars keep their direction and s; cars whose direction no longer exists are detached and returned.
  setEdgeType(e: Edge, type: RoadType, forward: boolean): Car[] {
    const old = e.lanes;
    if (!forward) [e.a, e.b] = [e.b, e.a];
    this.buildLanes(e, type);
    const lost: Car[] = [];
    for (const l of old) {
      const k = old.filter(x => x.from === l.from).indexOf(l);
      for (const c of l.cars) {
        const nl = this.lanesFrom(e, l.from)[k] ?? this.pickLane(e, l.from);
        if (!nl) { lost.push(c); continue; }
        c.lane = nl;
        nl.cars.push(c);
      }
    }
    for (const l of e.lanes) l.cars.sort((p, q) => p.s - q.s);
    for (const c of lost) this.detachCar(c);
    // merged lanes: no car overlaps the one ahead
    for (const l of e.lanes) lost.push(...this.respace(l));
    return lost;
  }

  // Pushes l's cars back so none overlaps the one ahead (s sorted already); detaches and returns the ones pushed off its start
  respace(l: Lane): Car[] {
    const lost: Car[] = [];
    let ahead: Car | null = null;
    for (let k = l.cars.length - 1; k >= 0; k--) {
      const c = l.cars[k];
      c.s = Math.min(c.s, l.edge.length, ahead ? ahead.s - (c.len + ahead.len) / 2 : Infinity);
      if (c.s < 0) lost.push(c);
      else ahead = c;
    }
    for (const c of lost) this.detachCar(c);
    return lost;
  }

  // Maximal chain of edges through e between doors / junctions / controlled nodes / dead ends / type changes
  // (a run is one type, so a bend or retype of it never retypes the road next to it). edges[i] joins nodes[i] and nodes[i+1].
  runOf(e: Edge): { edges: Edge[]; nodes: Node[] } {
    const inner = (n: Node) => !n.building && n.edges.length === 2 && n.control === 'none'
      && sameType(n.edges[0].type, n.edges[1].type) && n.edges[0].drive === n.edges[1].drive;
    const other = (x: Edge, n: Node) => x.a === n ? x.b : x.a;
    const step = (x: Edge, n: Node) => n.edges[0] === x ? n.edges[1] : n.edges[0];
    let n = e.a, cur = e;
    while (inner(n) && step(cur, n) !== e) { cur = step(cur, n); n = other(cur, n); }
    const edges = [cur], nodes = [n, other(cur, n)];
    for (let m = nodes[1]; inner(m) && step(cur, m) !== edges[0];) {
      cur = step(cur, m);
      m = other(cur, m);
      edges.push(cur);
      nodes.push(m);
    }
    return { edges, nodes };
  }

  edgeBetween(a: Node, b: Node): Edge | null {
    return a.edges.find(e => !this.hidden.has(e) && ((e.a === a && e.b === b) || (e.a === b && e.b === a))) ?? null;
  }

  // Lanes travelling away from 'from'; [] when the road is one-way against
  lanesFrom(e: Edge, from: Node): Lane[] {
    return e.lanes.filter(l => l.from === from);
  }

  // Turn at the first junction from path[j] on (inner nodes of a bent road don't count): 1 right, -1 left or U-turn, 0 straight / none
  // from: the node before path[0], for j = 0
  turn(path: Node[], j: number, from?: Node): number {
    for (; j < path.length - 1; j++) {
      const n = path[j]!;
      const p = path[j - 1] ?? from!, q = path[j + 1]!;
      // a ring's nodes: the turn that counts is the one past the roundabout, but onto a ring of 2+ lanes the arm's right lane goes to the
      // first exit (the ring's outer lane), its left lane further round (ringGoal)
      const e = onRing(n) && !this.edgeBetween(p, n)?.ring ? this.edgeBetween(n, q) : null;
      if (e?.ring && e.lanes.length > 1) { const g = this.ringGoal(path.slice(j), e); return g === e.lanes.length - 1 ? 1 : g ? 0 : -1; }
      if ((!n.building && n.edges.length === 2 && n.control === 'none') || onRing(n)) continue;
      if (this.drivewayJunction(n) && !this.edgeBetween(p, n)?.drive && !this.edgeBetween(n, q)?.drive) continue;
      return turnAt(p, n, q);
    }
    return 0;
  }

  // Lane arrows: the moves (bits 1 << Move) lane l may make at the node it leads into; ANY without arrows there
  arrows(l: Lane): number {
    const p = l.to.plan, m = p && laneMasks(p, l.to, l.edge);
    return m ? m[this.lanesFrom(l.edge, l.from).indexOf(l)] : ANY;
  }
  // Lanes of e from 'from' whose arrows allow going on to q at its far end; null when that node has no arrows for e
  arrowLanes(e: Edge, from: Node, q: Node | undefined): Lane[] | null {
    const n = e.a === from ? e.b : e.a, out = q && this.edgeBetween(n, q);
    if (!out || !n.plan || !laneMasks(n.plan, n, e)) return null;
    const mv = moveOf(n, e, out);
    return this.lanesFrom(e, from).filter(l => this.arrows(l) >> mv & 1);
  }

  // Lane for the turn after this edge: rightmost / leftmost (lanesFrom is ascending by offset), straight: the most room at its start.
  // q: the node after e's far end; where that junction has lane arrows, the roomiest lane they allow for the move onto q
  pickLane(e: Edge, from: Node, turn = 0, q?: Node): Lane | null {
    const ok = this.arrowLanes(e, from, q), ls = ok?.length ? ok : this.lanesFrom(e, from);
    if (turn && !ok?.length) return ls[turn > 0 ? ls.length - 1 : 0] ?? null;
    let best: Lane | null = null, room = -1;
    for (const l of ls) {
      const r = l.cars[0]?.s ?? Infinity;
      if (r > room) { best = l; room = r; }
    }
    return best;
  }

  lanePos(lane: Pick<Lane, 'from' | 'to' | 'offset'>, s: number, offset = lane.offset): { x: number; y: number; angle: number } {
    const dx = lane.to.x - lane.from.x, dy = lane.to.y - lane.from.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    return {
      x: lane.from.x + ux * s - uy * offset,
      y: lane.from.y + uy * s + ux * offset,
      angle: Math.atan2(uy, ux),
    };
  }

  // Render position of a car along its lane. At plain nodes the lateral offset blends halfway toward the next / from the previous lane.
  carPos(c: Car): { x: number; y: number; angle: number } {
    const lane = c.lane, remaining = lane.edge.length - c.s;
    const next = c.path?.[1];
    // U-turn back down the same edge (dead end / one-way ahead): half circle in the last and first NODE_R
    if (next === lane.from && c.exit?.edge === lane.edge && remaining < NODE_R) return this.uturnPos(lane, c.exit.offset, NODE_R - remaining);
    if (c.prev === lane.to && c.s < NODE_R) return this.uturnPos({ ...lane, from: lane.to, to: lane.from, offset: c.prevOffset }, lane.offset, NODE_R + c.s);
    // Junction or bend: a Bezier arc over the last / first NODE_R or so of the two lanes (exit is stale for a tick after a hand-off)
    // the straight lane's offset blends halfway toward the next / from the previous lane over 2 NODE_R; on a short link an arc's end on
    // this lane takes the other blend there too, so the two arcs meet. Onto an inner ring lane the blend is shorter (it would still pull
    // the car toward the outer lane a chord on), off one only from mid-chord, where a car waits to leave it (Car.update), so it stays put.
    const nl = c.exit, B = 2 * NODE_R, L = lane.edge.length, Bn = lane.edge.ring && lane.offset < 0 && nl && !nl.edge.ring ? L / 2 : B;
    const Bp = lane.edge.ring && lane.offset < 0 && c.prev && !this.edgeBetween(c.prev, lane.from)?.ring ? NODE_R : B;
    const pb = (s: number): number => c.prev && s < Bp ? (c.prevOffset - lane.offset) * 0.5 * (1 - s / Bp) : 0;
    const nb = (s: number): number => nl && next === nl.to && L - s < Bn ? (nl.offset - lane.offset) * 0.5 * (1 - (L - s) / Bn) : 0;
    if (nl && next === nl.to && next !== lane.from) {
      const q = this.arcPos(lane.from, lane.to, nl.to, lane.offset, nl.offset, -remaining, r => pb(L - r) + (nl.offset - lane.offset) * 0.5 * (r / B - r / Bn));
      if (q) return q;
    }
    if (c.prev && c.prev !== lane.to) {
      const q = this.arcPos(c.prev, lane.from, lane.to, c.prevOffset, lane.offset, c.s, undefined, r => nb(r) + (c.prevOffset - lane.offset) * 0.5 * (r / B - r / Bp));
      if (q) return q;
    }
    const o = lane.offset + nb(c.s) + pb(c.s);
    if (!c.lc) return this.lanePos(lane, c.s, o);
    // mid-edge lane change: smoothstep slide from the old lane, nose turned along the sideways speed
    const u = c.lc / LC_S, q = this.lanePos(lane, c.s, o + c.lcOff * u * u * (3 - 2 * u));
    return { ...q, angle: q.angle + Math.atan2(-c.lcOff * 6 * u * (1 - u) / LC_S, Math.max(c.speed, 40)) };
  }

  // Cubic Bezier across node n from lane a->n (offset oi) onto n->b (offset oo); x = signed distance past n, the arc spans |x| <= r
  // (NODE_R on single-lane roads; half a ring's chord).
  // Its ends sit where the straight lane's halfway offset blend is, tangent to the lanes, so the hand-off is seamless.
  // A left turn at a junction bows LANE_OFFSET toward the inside of the turn, so two opposite lefts pass each other side by side.
  // ponytail: ignores the next-node blends that only reach the ends on edges under ~3 NODE_R; a glitch there is cosmetic
  // di / dq: extra offset at its end on a->n / n->b, given r
  private arcPos(a: Node, n: Node, b: Node, oi: number, oo: number, x: number, di = (_r: number) => 0, dq = (_r: number) => 0): { x: number; y: number; angle: number } | null {
    // outer lanes of wide roads start the arc earlier, or a turn from one onto an inner lane is a hook
    const la = dist(a, n), r = Math.min(NODE_R + Math.max(Math.abs(oi), Math.abs(oo)) - LANE_OFFSET, 2 * NODE_R, la / 2, dist(n, b) / 2);
    if (x < -r || x > r) return null;
    const f = 0.5 - r / (4 * NODE_R);
    const P = this.lanePos({ from: a, to: n, offset: 0 }, la - r, oi + (oo - oi) * f + di(r));
    const Q = this.lanePos({ from: n, to: b, offset: 0 }, r, oo + (oi - oo) * f + dq(r));
    const t = (x + r) / (2 * r), m = 1 - t, d = Math.hypot(Q.x - P.x, Q.y - P.y) * 0.4;
    const x1 = P.x + Math.cos(P.angle) * d, y1 = P.y + Math.sin(P.angle) * d, x2 = Q.x - Math.cos(Q.angle) * d, y2 = Q.y - Math.sin(Q.angle) * d;
    const bz = (p0: number, p1: number, p2: number, p3: number) => m * m * m * p0 + 3 * m * t * (m * p1 + t * p2) + t * t * t * p3;
    const dz = (p0: number, p1: number, p2: number, p3: number) => 3 * (m * m * (p1 - p0) + 2 * m * t * (p2 - p1) + t * t * (p3 - p2));
    // the bow: 16 t^2 m^2 (flat at both ends, so the heading stays continuous) along the inside of the turn
    let wx = 0, wy = 0;
    if (n.edges.length > 2 && !onRing(n) && turnAt(a, n, b) < 0) {
      const ux = Math.cos(Q.angle) - Math.cos(P.angle), uy = Math.sin(Q.angle) - Math.sin(P.angle), k = LANE_OFFSET / (Math.hypot(ux, uy) || 1);
      wx = ux * k; wy = uy * k;
    }
    const w = 16 * t * t * m * m, dw = 32 * t * m * (m - t);
    return { x: bz(P.x, x1, x2, Q.x) + wx * w, y: bz(P.y, y1, y2, Q.y) + wy * w, angle: Math.atan2(dz(P.y, y1, y2, Q.y) + wy * dw, dz(P.x, x1, x2, Q.x) + wx * dw) };
  }

  // Left turn from lane l (offset l.offset) onto the opposite lane (offset oo), NODE_R before l.to; p = 0..2*NODE_R
  private uturnPos(l: Lane, oo: number, p: number): { x: number; y: number; angle: number } {
    const t = Math.PI * Math.min(1, p / (2 * NODE_R)), r = (l.offset + oo) / 2;
    const q = this.lanePos(l, l.edge.length - NODE_R + r * Math.sin(t), (l.offset - oo) / 2 + r * Math.cos(t));
    return { ...q, angle: q.angle - t };
  }

  // A node takes a road of this level when all its roads are on it (a ramp joint, on two levels, takes none); doors take ground roads
  nodeLevelOk(n: Node, level: number): boolean {
    return n.building ? level === 0 : n.edges.every(e => this.hidden.has(e) || e.level === level);
  }

  // Level of a node's roads: NaN for a ramp joint (two levels), 'bare' for a node without roads; doors are ground
  levelOf(n: Node, bare = NaN): number {
    if (n.building) return 0;
    const ls = new Set(n.edges.filter(e => !this.hidden.has(e)).map(e => e.level));
    return ls.size === 1 ? [...ls][0] : ls.size ? NaN : bare;
  }

  nearestNode(p: Vec, r: number, level?: number): Node | null {
    let best: Node | null = null, bestD = Infinity;
    for (const n of this.nodes) {
      if (level !== undefined && !this.nodeLevelOk(n, level)) continue;
      if (!n.building && n.edges.length && n.edges.every(e => this.hidden.has(e))) continue;
      const d = dist(p, n);
      if (d <= (n.building ? DOOR_R : r) && d < bestD) { best = n; bestD = d; }
    }
    return best;
  }

  nearestEdge(p: Vec, r: number, level?: number): { edge: Edge; point: Vec; t: number } | null {
    let best: { edge: Edge; point: Vec; t: number } | null = null, bestD = Infinity;
    for (const e of this.edges) {
      if ((level !== undefined && e.level !== level) || this.hidden.has(e)) continue;
      const h = distToSegment(p, e.a, e.b);
      // ponytail: wider roads widen the hit radius; default roads keep r exactly
      if (h.d <= r + Math.max(0, (e.width - ROAD_W) / 2) && h.d < bestD) { best = { edge: e, point: h.point, t: h.t }; bestD = h.d; }
    }
    return best;
  }

  crossings(a: Vec, b: Vec, excludeNodes: Set<Node>, excludeEdges: Set<Edge>, level: number): { edge: Edge; point: Vec; t: number; node: Node | null }[] {
    const out: { edge: Edge; point: Vec; t: number; node: Node | null }[] = [];
    for (const e of this.edges) {
      if (e.level !== level || excludeEdges.has(e) || this.hidden.has(e) || excludeNodes.has(e.a) || excludeNodes.has(e.b)) continue;
      const x = segmentsCross(a, b, e.a, e.b);
      if (!x) continue;
      const point = { x: a.x + (b.x - a.x) * x.t, y: a.y + (b.y - a.y) * x.t };
      const node = dist(point, e.a) < NODE_R ? e.a : dist(point, e.b) < NODE_R ? e.b : null;
      out.push({ edge: e, point, t: x.t, node });
    }
    return out.sort((p, q) => p.t - q.t);
  }

  // via: the edge a car arrives by; the road's own traffic passes a driveway junction like a bend (only held for a merge), ring
  // traffic passes an arm's node
  needsControl(n: Node, via?: Edge | null): boolean {
    return (n.edges.length >= 3 || n.control !== 'none') && !(via && !via.drive && this.drivewayJunction(n)) && !via?.ring;
  }

  // A plain node where driveways meet one road (two road arms): driveway cars merge (update), the road does not stop for it
  drivewayJunction(n: Node): boolean {
    return n.control === 'none' && !n.building && n.edges.length >= 3 && n.edges.filter(e => !e.drive).length === 2;
  }

  // The merge of driveway car m at n meets road edge e's lanes into n (into) or out of it: a right turn only meets the traffic
  // coming toward its exit lane (that lane's own room is fits()'s). A car clearing the box has entered its exit lane already.
  private meets(m: Car, n: Node, e: Edge, into: boolean): boolean {
    const cl = m.clearing === n, from = cl ? m.prev : m.lane.from, exit = cl ? m.lane : m.exit;
    const right = !!from && !!exit && turnAt(from, n, exit.to) > 0;
    return into ? !(right && e === exit!.edge) : !right;
  }

  // Road traffic arriving by 'via' keeps clear of driveway junction n: a merging car in its way is in the box, or has waited MERGE_S.
  // The traffic heading into its exit lane always (a slow queue never leaves it a gap otherwise), the oncoming traffic a left turn
  // crosses only once that lane has room.
  held(n: Node, via: Edge): boolean {
    for (const m of n.occupants) if (this.meets(m, n, via, true)) return true;
    return n.queue.some(m => m.wait > MERGE_S && this.meets(m, n, via, true) && (via !== m.exit?.edge || this.fits(n, m)));
  }

  // A road car in m's way at driveway junction n: in the box, or reaching it before it could stop (with its gap and reaction) plus
  // 'margin' px (the merge gap).
  // Looks back over driveway junctions and bends up to 150px, since a home-lined road is cut into ~40px links.
  private roadNear(n: Node, m: Car, margin: (c: Car) => number): boolean {
    const reach = (c: Car, d: number): boolean => d < stopDist(n) + c.speed * c.speed / (2 * BRAKE) + margin(c);
    const near = (l: Lane, d: number): boolean => {
      const c = l.cars[l.cars.length - 1];
      if (c) return reach(c, d + l.edge.length - c.s);
      const p = l.from, back = p.edges.filter(x => !x.drive && x !== l.edge);
      d += l.edge.length;
      // a car granted onto l at its far end (one leaving its driveway there) is about to be on it
      for (const o of p.occupants) if (o.granted === p && o.exit === l && reach(o, d)) return true;
      return d < 150 && !p.building && p.control === 'none' && back.length === 1 && back[0].lanes.some(x => x.to === p && near(x, d));
    };
    for (const e of n.edges) {
      if (e.drive) continue;
      for (const l of e.lanes) {
        if (!this.meets(m, n, e, l.to === n)) continue;
        // the rear of a road car just past the node
        if (l.from === n && l.cars[0] && l.cars[0].s - l.cars[0].len / 2 < NODE_R) return true;
        if (l.to === n && near(l, 0)) return true;
      }
    }
    return false;
  }

  // The paths of two cars across plain junction n cross, or end on one road. Each arm takes cars in just right of its centre line and
  // out just left of it, so two paths cross when their ends interleave around the node; a U-turn sweeps the whole box.
  private crosses(n: Node, a: Car, b: Car): boolean {
    return this.crossing(n, this.moveAt(n, a), this.moveAt(n, b));
  }
  // Two movements (in, out edge) across n cross; an unknown one counts as yes
  private crossing(n: Node, ma: [Edge, Edge] | null, mb: [Edge, Edge] | null): boolean {
    if (!ma || !mb || ma[0] === ma[1] || mb[0] === mb[1] || ma[1] === mb[1]) return true;
    if (ma[0] === mb[0]) return false;
    const T = 2 * Math.PI, at = (e: Edge, d: number) => edgeAngle(n, e) + d, p = at(ma[0], -0.01), span = (at(ma[1], 0.01) - p + 2 * T) % T;
    const inside = (x: number) => (x - p + 2 * T) % T < span;
    return inside(at(mb[0], -0.01)) !== inside(at(mb[1], 0.01));
  }

  // In and out edge of a car queued at, granted into or clearing n
  private moveAt(n: Node, c: Car): [Edge, Edge] | null {
    if (c.clearing === n) { const e = c.prev && this.edgeBetween(c.prev, n); return e ? [e, c.lane.edge] : null; }
    return c.exit ? [c.lane.edge, c.exit.edge] : null;
  }
  // ... or of a car still a link or more out, by its route
  private moveVia(n: Node, c: Car): [Edge, Edge] | null {
    if (c.lane.to === n || c.clearing === n) return this.moveAt(n, c);
    const p = c.path, i = p ? p.indexOf(n) : -1, a = i > 0 ? this.edgeBetween(p![i - 1], n) : null, b = i >= 0 && p![i + 1] ? this.edgeBetween(n, p![i + 1]) : null;
    return a && b ? [a, b] : null;
  }

  // Sign junction n: a car coming in on another arm that car c gives way to (better: its rank goes first) and whose path crosses c's,
  // queued at n or reaching the box before it could stop plus margin px (none once c starves: then only cars that can't stop count).
  // A car that has no room to go anyway doesn't count. Looks back over bends up to 300px.
  // ponytail: stops at driveway junctions on the way; a priority car behind one is only seen once it is past it
  private giveWay(n: Node, c: Car, better: (o: Car, m: [Edge, Edge] | null) => boolean, margin: (o: Car, m: [Edge, Edge] | null) => number): boolean {
    const mc = this.moveAt(n, c);
    const scan = (l: Lane, d: number): boolean => {
      for (let i = l.cars.length - 1; i >= 0; i--) {
        const o = l.cars[i], od = d + l.edge.length - o.s;
        if (od > 300) return false;
        const m = this.moveVia(n, o), k = margin(o, m);
        if ((od < stopDist(n) + o.speed * o.speed / (2 * BRAKE) + k || (k > 0 && o.queued && o.lane.to === n)) && better(o, m) && this.crossing(n, mc, m) && (o.lane.to !== n || this.fits(n, o))) return true;
      }
      const p = l.from, back = p.edges.filter(x => !x.drive && x !== l.edge);
      d += l.edge.length;
      return d < 300 && !p.building && p.control === 'none' && back.length === 1 && back[0].lanes.some(x => x.to === p && scan(x, d));
    };
    return n.edges.some(e => e !== c.lane.edge && e.lanes.some(l => l.to === n && scan(l, 0)));
  }

  // How far out from n a car on 'via' queues for its turn: 70px, or where it still could stop when it has right of way (a plain
  // junction, a priority road at a sign junction), so a clear junction grants it at speed
  queueAt(n: Node, via: Edge, c: Car): number {
    const free = n.control === 'yield' ? signOf(n, via) === PRIORITY : n.control === 'none' && !this.drivewayJunction(n) && !onRing(n);
    return free ? Math.max(70, stopDist(n) + GAP + 10 + c.speed * (c.react + c.speed / (2 * BRAKE))) : 70;
  }

  private grant(n: Node, c: Car): void {
    c.granted = n;
    n.occupants.add(c);
  }

  // Don't block the box: the exit lane needs the car's length of room past the junction, after the cars already granted into it.
  // A driveway or ring entry only needs room past the node: the road does not keep its box clear.
  // Two lanes never feed one exit lane at once: a car granted into it from another lane enters first (else they meet in the box).
  private fits(n: Node, c: Car): boolean {
    const l = c.exit;
    if (!l) return false;
    const f = l.cars[0];
    let room = (f ? f.s - f.len / 2 : Infinity) - (this.drivewayJunction(n) || onRing(n) ? 0 : CAR_LEN / 2 + stopDist(n));
    for (const o of n.occupants) {
      if (o.granted !== n || o.exit !== l) continue;
      if (o.lane !== c.lane) return false;
      room -= o.len + GAP;
    }
    return room >= c.len + GAP;
  }

  // Ring traffic at ring node n for car m crossing ring lanes lo and out there: entering (lo: the lane it takes) or leaving from an inner
  // lane (lo: the one past its own). A car in those lanes (or moving out into one by n) reaching n before it could stop plus
  // MERGE_GAP s past m's own time to the node, or the rear of one just past it. An entering car never meets one leaving the ring at n
  // from the outer lane, but always one leaving from an inner lane. Past n: the rear of a car in those lanes still in the box, or one
  // moving out into them at the next node (it would cut in just ahead). No courtesy merge for entering cars: held ring traffic would
  // gridlock the ring. A starved inner exit (starved) only meets cars that can't stop; the rest keep clear for it (ringHeld).
  private ringNear(n: Node, m: Car, lo: number, starved = false): boolean {
    const out = this.ringEdge(n, false), L = out.lanes.length, enter = !m.lane.edge.ring;
    // the outermost ring lane c is in or heading for by n (its goal there: it only moves out)
    const k = (c: Car): number => {
      const p = c.path, i = p ? p.indexOf(n) : -1, own = Math.max(c.lane.edge.ring ? this.ringIdx(c.lane) : -1, c.exit?.edge.ring ? this.ringIdx(c.exit) : -1);
      return i >= 0 && p![i + 1] === out.b ? Math.max(own, this.ringGoal(p!.slice(i), out)) : own;
    };
    if (out.lanes.some((l, i) => l.cars.some(c => k(c) >= lo && (i < lo || c.s - c.len / 2 < NODE_R)))) return true;
    // m's time to the node; past the plain arc (Car.update) it slows to half the corner speed, ~22px/s
    const plain = !m.exit || (m.exit.offset === 0 && Math.abs(m.lane.offset) <= LANE_W / 2);
    const te = (m.lane.edge.length - m.s) / Math.max(plain ? m.speed : Math.min(m.speed, 22), 20);
    const reach = (c: Car, d: number): boolean => d < (starved ? stopDist(n) : NODE_R + c.speed * (MERGE_GAP + te) + CAR_LEN) + c.speed * c.speed / (2 * BRAKE);
    const meets = (c: Car): boolean => {
      const p = c.path, i = p ? p.indexOf(n) : -1, leaves = i >= 0 && !!p![i + 1] && !this.edgeBetween(n, p![i + 1])?.ring;
      if (p && i < 0) return false;
      return enter && leaves ? k(c) < L - 1 : k(c) >= lo;
    };
    for (let e = this.ringEdge(n, true), d = 0; d < 250; e = this.ringEdge(e.a, true)) {
      for (const l of e.lanes) for (const c of l.cars) if (meets(c) && reach(c, d + e.length - c.s)) return true;
      d += e.length;
      if (e.a === n) break;
      // a car granted in at e's start is about to be on the ring
      for (const o of e.a.occupants) if (o.granted === e.a && meets(o) && reach(o, d + o.lane.edge.length - o.s)) return true;
    }
    return false;
  }

  // Ring traffic in ring lane k keeps clear of ring node n (Car.update, where it still can stop) for a car leaving the ring there from a
  // lane further in: granted, or queued at the front of its lane for STARVE_S with room to go (steady outer traffic never leaves it a
  // gap). It leaves the ring, so holding the lanes it crosses can't gridlock it.
  ringHeld(n: Node, k: number): boolean {
    const inner = (m: Car): boolean => !!m.lane.edge.ring && m.lane.to === n && this.ringIdx(m.lane) < k;
    for (const m of n.occupants) if (m.granted === n && inner(m)) return true;
    return n.queue.some(m => inner(m) && m.wait > STARVE_S && m.lane.cars[m.lane.cars.length - 1] === m && this.fits(n, m));
  }

  // The ring edge into (or out of) ring node v
  private ringEdge(v: Node, into: boolean): Edge {
    return v.edges.find(e => e.ring && (into ? e.b : e.a) === v)!;
  }

  // Cars c (queued) and o (in the box) at ring node n enter side by side: from a multi-lane arm, the one in the arm's right lane to the
  // outer ring lane, a car's length behind (level, their swings at different radii clip). Anything else (a car leaving the ring there
  // from an inner lane) goes alone.
  private beside(n: Node, c: Car, o: Car): boolean {
    const g = o.granted === n, to = g ? o.exit : o.lane, from = g ? o.lane.edge : o.prev && this.edgeBetween(o.prev, n);
    if (c.lane.edge.ring || !from || from.ring || !to?.edge.ring) return false;
    const behind = c.lane.edge.length - c.s - (g ? o.lane.edge.length - o.s : -o.s);
    if (behind < CAR_LEN) return false;
    return (c.lane.offset - (g ? o.lane.offset : o.prevOffset)) * (this.ringIdx(c.exit!) - this.ringIdx(to)) > 0;
  }

  // Ring lane index of lane l (inner 0)
  private ringIdx(l: Lane): number { return l.edge.lanes.indexOf(l); }

  // The lane car c takes onto ring edge e out of v. Entering: the one for how far round it goes (ringGoal), within the share of ring lanes
  // its arm lane feeds (an arm's right lane the outer one, the others the rest, inner ones from the left). On the ring: its own, or
  // at a plain ring node one lane out toward its goal when there is room there (ringGap); never in, never at an arm (where entering cars
  // cross the lanes), never two chords running (one swing, then a chord straight).
  ringPick(c: Car, v: Node, e: Edge): Lane {
    const goal = this.ringGoal(c.path, e), L = e.lanes.length;
    if (!c.lane.edge.ring) {
      const ls = this.lanesFrom(c.lane.edge, c.lane.from), a = ls.indexOf(c.lane), A = ls.length;
      const lo = A > 1 ? Math.floor(a * (L - 1) / (A - 1)) : 0, hi = a === A - 1 ? L - 1 : Math.max(lo, Math.floor((a + 1) * (L - 1) / (A - 1)) - 1);
      return e.lanes[Math.min(hi, Math.max(lo, goal))];
    }
    const k = Math.min(this.ringIdx(c.lane), L - 1), to = e.lanes[k + 1];
    return to && goal > k && v.edges.every(x => x.ring) && c.prevOffset === c.lane.offset && this.ringGap(c, to) ? to : e.lanes[k];
  }

  // Ring lane for a route p heading onto ring edge e (p[0] its start, p[1] its end): the outer one to leave at the next arm, one further
  // in per arm it passes first. An unknown route: the outer lane.
  private ringGoal(p: Node[] | null, e: Edge): number {
    const L = e.lanes.length;
    let m = 0;
    for (let j = 1; p && j + 1 < p.length && this.edgeBetween(p[j], p[j + 1])?.ring; j++) if (p[j].edges.some(x => !x.ring)) m++;
    return Math.max(0, L - 1 - m);
  }

  // Room for ring car c to move out into lane 'to' past the plain ring node ahead: room behind to's first car, and a car's length more
  // behind the car it pulls out from behind (its swing would clip it); no entering car granted into 'to', into the lane beside c or into
  // that lane past 'to' (c would be on it before them), and
  // there (back over the chord before) no car ahead of c, none behind closer than it needs to stop
  private ringGap(c: Car, to: Lane): boolean {
    const l = c.lane, k = this.ringIdx(to), stop = (o: Car): number => o.speed * o.speed / (2 * BRAKE);
    const room = (o: Car | undefined, d: number, x = 0): boolean => !o || d - (o.len + c.len) / 2 >= GAP + x + Math.max(0, stop(c) - stop(o));
    const own = l.cars[l.cars.indexOf(c) + 1], next = this.ringEdge(l.to, false).lanes[this.ringIdx(l)].cars[0];
    if (!room(to.cars[0], to.cars[0]?.s) || !(own ? room(own, own.s - c.s, CAR_LEN) : room(next, l.edge.length - c.s + next?.s, CAR_LEN))) return false;
    for (const o of l.to.occupants) if (o.exit === to) return false;
    for (const [v, x] of [[l.from, l.edge], [to.to, this.ringEdge(to.to, false)]] as const) for (const o of v.occupants) if (o.granted === v && o.exit === x.lanes[k]) return false;
    const back = this.ringEdge(l.from, true);
    return ([[l.edge.lanes[k], 0], [back.lanes[k], back.length]] as const).every(([x, d0]) => !x || x.cars.every(o =>
      c.s + d0 - o.s >= (o.len + c.len) / 2 + GAP + stop(o) + CAR_LEN));
  }

  // A ring car in lane l leaves the ring at l.to for q from an inner lane (no gap let it move out): it crosses the outer lanes there,
  // so it waits for a grant (update: ringNear past its lane)
  innerExit(l: Lane, q: Node | undefined): boolean {
    return !!l.edge.ring && !!q && this.ringIdx(l) < l.edge.lanes.length - 1 && !this.edgeBetween(l.to, q)?.ring;
  }

  // Room for c in the road it leaves the ring by, after the ring cars heading there: a blocked exit holds cars at the entry, not on
  // the ring. ponytail: cars granted at other entries don't count; a jam there only stalls the ring until REROUTE_S
  private exitRoom(n: Node, c: Car): boolean {
    const p = c.path, r = this.ringOf(n);
    if (!p || !r) return true;
    let j = 0;
    while (j + 1 < p.length && this.edgeBetween(p[j], p[j + 1])?.ring) j++;
    const x = p[j], q = p[j + 1], e = q && this.edgeBetween(x, q);
    if (!j || !e) return true;
    let need = c.len + GAP;
    for (const v of r.nodes) for (const l of this.ringEdge(v, true).lanes) for (const o of l.cars) {
      const i = o.path?.indexOf(x) ?? -1;
      if (i >= 0 && o.path![i + 1] === q) need += o.len + GAP;
    }
    return this.lanesFrom(e, x).some(l => (l.cars[0] ? l.cars[0].s - l.cars[0].len / 2 : Infinity) >= need);
  }

  update(dt: number): void {
    const k = Math.min(1, dt / TUNING.HEAT_TAU);
    for (const e of this.edges) {
      let n = 0, slow = 0;
      for (const l of e.lanes) for (const c of l.cars) { n++; slow += 1 - Math.min(1, c.speed / c.top(e, this)); }
      const x = n ? Math.max(n * (CAR_LEN + GAP) / (e.length * e.lanes.length), slow / n) : 0;
      e.heat += (Math.min(1, x) - e.heat) * k;
    }
    for (const n of this.nodes) {
      n.queue = n.queue.filter(c => c.lane.to === n);
      n.delay += ((n.queue.length ? n.queue.reduce((s, c) => s + c.wait, 0) / n.queue.length : 0) - n.delay) * k;
      const plan = n.control === 'light' || n.control === 'yield' || n.plan ? planOf(n) : null;
      // Ambulance (game-v3 3): its whole lane goes first (a stable sort keeps the cars ahead of it in order); a light turns green for it
      // when it is AMB_R out, a yield treats it as the main road, a stop lets it roll
      const amb = n.queue.filter(c => c.kind === 'ambulance' && c.exit), ambL = new Set(amb.map(c => c.lane));
      if (ambL.size) n.queue.sort((p, q) => +ambL.has(q.lane) - +ambL.has(p.lane));
      if (n.control === 'light') {
        const ph = plan!.phases;
        n.phaseTimer += dt;
        if (n.phase >= ph.length) n.phase = 0;
        if (n.phaseTimer >= ph[n.phase].seconds) { n.phaseTimer = 0; n.phase = (n.phase + 1) % ph.length; }
        const a = amb.find(c => c.lane.edge.length - c.s < AMB_R), x = a && [approachOf(plan!, n, a.lane.edge), moveOf(n, a.lane.edge, a.exit!.edge)] as const;
        const green = x ? ph.findIndex(p => p.sig[x[0]][x[1]] === 2) : -1, go = green >= 0 ? green : x ? ph.findIndex(p => p.sig[x[0]][x[1]] > 0) : -1;
        if (go >= 0 && !(ph[n.phase].sig[x![0]][x![1]] > 0)) { n.phase = go; n.phaseTimer = 0; }
      }
      if (!n.queue.length) continue;
      // Arrival order; lights and the main road of a yield junction admit every car their signal lets go, a plain junction every car
      // whose path crosses none in the box, a ring node cars entering side by side (beside), the rest 1. A car that can't go holds back the cars queued behind
      // it in its lane.
      const dj = this.drivewayJunction(n), rv = onRing(n), plain = n.control === 'none' && !dj && !rv;
      const cap = n.control === 'light' || n.control === 'yield' || plain || rv ? Infinity : 1;
      // Approach and movement of every car queued at or granted into n (plan nodes only)
      const mv = new Map<Car, [number, Move]>();
      if (plan) for (const c of [...n.queue, ...n.occupants]) if (c.exit && c.lane.to === n) mv.set(c, [approachOf(plan, n, c.lane.edge), moveOf(n, c.lane.edge, c.exit.edge)]);
      const busy = (cars: Iterable<Car>, a: number, ok: (m: Move) => boolean): boolean => {
        for (const c of cars) { const x = mv.get(c); if (x && x[0] === a && ok(x[1])) return true; }
        return false;
      };
      // A left that only yields waits while the opposite approach has a straight or right car queued or in the box
      const opposed = (a: number): boolean => {
        const o = oppositeOf(plan!, a);
        return o >= 0 && (busy(n.queue, o, m => m !== LEFT) || busy(n.occupants, o, m => m !== LEFT));
      };
      // Starved: at the front of its lane for s (MERGE_S) with room to go. A starved permissive left (a light showing it yield) stops the
      // oncoming traffic, so it never waits until it gives up.
      const starving = (c: Car, s = MERGE_S): boolean => c.wait > s && c.lane.cars[c.lane.cars.length - 1] === c && this.fits(n, c);
      // Sign junction rank, lower goes first: a priority road (or an ambulance) straight or right 0, its lefts 1, yield and stop 2
      const signs = n.control === 'yield' ? new Map(n.edges.map(e => [e, signOf(n, e)])) : null;
      const rank = (c: Car, m: [Edge, Edge] | null): number => !m ? 2 : signs!.get(m[0]) !== PRIORITY && c.kind !== 'ambulance' && !ambL.has(c.lane) ? 2 : moveOf(n, m[0], m[1]) === LEFT ? 1 : 0;
      const lefty = (a: number): boolean => a >= 0 && n.queue.some(c => {
        const y = mv.get(c);
        return !!y && y[0] === a && y[1] === LEFT && (n.control !== 'light' || plan!.phases[n.phase].sig[a][LEFT] === 1) && starving(c);
      });
      const left = (c: Car, a: number): boolean => !opposed(a) || (starving(c) && !busy(n.occupants, oppositeOf(plan!, a), m => m !== LEFT));
      const may = (c: Car): boolean => {
        const x = mv.get(c);
        if (plan && (!x || plan.ban[x[0]][x[1]])) return false;
        if (n.control === 'light') {
          const s = plan!.phases[n.phase].sig[x![0]][x![1]];
          return x![1] === LEFT ? s === 2 || (s === 1 && left(c, x![0])) : s > 0 && !lefty(oppositeOf(plan!, x![0]));
        }
        if (n.control === 'yield') {
          // Only an actual conflict holds a car: a crossing or merging car in the box, a better-ranked one coming that would reach the box
          // before it clears, an earlier same-ranked one waiting, or a starved worse-ranked one (courtesy). A stop sign first halts at the line.
          const mc = this.moveAt(n, c), r = rank(c, mc);
          if (signs!.get(c.lane.edge) === STOP && !ambL.has(c.lane) && !(c.speed < 1 && c.lane.edge.length - c.s - stopDist(n) < GAP + 3)) return false;
          for (const o of n.occupants) if (this.crosses(n, c, o)) return false;
          if (r && this.giveWay(n, c, (o, m) => rank(o, m) < r, (o, m) => starving(c, STARVE_S) ? 0 : o.speed * CLEAR_S * (m?.[1] === mc?.[1] ? CLEAR_M : 1) + CAR_LEN)) return false;
          return !ready.some(o => rank(o, this.moveAt(n, o)) === r && this.crosses(n, c, o))
            && !n.queue.some(o => o !== c && rank(o, this.moveAt(n, o)) > r && starving(o, STARVE_S) && this.crosses(n, c, o));
        }
        if (rv) return [...n.occupants].every(o => this.beside(n, c, o))
          && (c.lane.edge.ring ? !this.ringNear(n, c, this.ringIdx(c.lane) + 1, starving(c, STARVE_S)) : !this.ringNear(n, c, this.ringIdx(c.exit!)) && this.exitRoom(n, c));
        // stop: only from a standstill at the line
        if (n.control === 'stop') return ambL.has(c.lane) || (c.speed < 1 && c.lane.edge.length - c.s - stopDist(n) < GAP + 3);
        // driveway: into a gap in the road's traffic; after MERGE_S the road keeps clear (held) and only cars that can't stop count
        if (dj) return !this.roadNear(n, c, o => c.wait < MERGE_S ? o.speed * MERGE_GAP + CAR_LEN : 0);
        // plain: never past an earlier car it crosses that only waits for the box (first come, first served)
        if (plain) return ![...n.occupants, ...ready].some(o => this.crosses(n, c, o));
        return true;
      };
      const held = new Set<Lane>(), ready: Car[] = [];
      n.queue = n.queue.filter(c => {
        const free = !held.has(c.lane) && this.fits(n, c);
        if (!free || n.occupants.size >= cap || !may(c)) {
          if (free) ready.push(c);
          held.add(c.lane);
          return true;
        }
        this.grant(n, c);
        return false;
      });
    }
  }

  ringOf(n: Node): Ring | null {
    return n.edges.find(e => e.ring)?.ring ?? this.rings.find(r => r.hub === n) ?? null;
  }
  // The ring drawn under p (pad px of slack round its outer edge)
  ringAt(p: Vec, pad = 0): Ring | null {
    return this.rings.find(r => dist(p, r.hub) <= ringOut(r.hub.ring) + pad) ?? null;
  }
  // The ring whose clear radius p is inside
  nearRing(p: Vec): Ring | null {
    return this.rings.find(r => dist(p, r.hub) < clearR(r.hub.ring)) ?? null;
  }

  // Replaces junction n with a ring of this size (Game.ringRoom checks the fit): each arm, followed through its bends, is cut where it
  // crosses the ring, its inner piece removed, and the cut points joined round by ring edges of about one chord (RINGS n), so the
  // arms sit exactly on ring nodes, with this many ring lanes. Null (and nothing changed) when an arm meets a junction, door or dead end
  // inside the ring.
  buildRing(n: Node, size: RingSize, day: number, lanes: RingLanes = 1): { ring: Ring; cars: Car[] } | null {
    const R = RINGS[size].r, other = (e: Edge, v: Node) => e.a === v ? e.b : e.a;
    const plain = (v: Node) => !v.building && v.control === 'none' && v.edges.length === 2;
    const arms: { inner: Edge[]; from: Node[]; e: Edge; at: Node; o: Node }[] = [];
    for (const e0 of n.edges) {
      let at = n, e = e0;
      const inner: Edge[] = [], from: Node[] = [];
      while (dist(other(e, at), n) < R && plain(other(e, at))) {
        inner.push(e);
        from.push(at);
        at = other(e, at);
        e = at.edges[0] === e ? at.edges[1] : at.edges[0];
      }
      if (dist(other(e, at), n) < R) return null;
      arms.push({ inner, from, e, at, o: other(e, at) });
    }
    const cars: Car[] = [], cuts: Node[] = [], spoke = new Map<Node, Spoke>();
    const rate = (x: Edge) => x.drive || x.exit ? 0 : laneFactor(x.type) * TIERS[x.type.tier].cost;
    for (const { inner, from, e, at, o } of arms) {
      // where at->o crosses the circle: |at + t (o - at) - n| = R
      const dx = o.x - at.x, dy = o.y - at.y, fx = at.x - n.x, fy = at.y - n.y, A = dx * dx + dy * dy, B = fx * dx + fy * dy;
      const t = (-B + Math.sqrt(Math.max(0, B * B - A * (fx * fx + fy * fy - R * R)))) / A, p = { x: at.x + dx * t, y: at.y + dy * t };
      const v = dist(p, o) < 1 ? o : this.splitEdge(e, p);
      inner.push(v === o ? e : this.edgeBetween(at, v)!);
      from.push(at);
      const i = inner.reduce((k, x, j) => rate(x) < rate(inner[k]) ? j : k, 0), x = inner[i];
      spoke.set(v, { type: x.type, day: Math.min(...inner.map(y => y.day)), drive: x.drive, exit: x.exit, out: x.type.oneWay && x.a === from[i] });
      for (const x of inner) cars.push(...this.removeEdge(x));
      cuts.push(v);
    }
    // counter-clockwise on screen = falling angle; each arc between two arms split into whole chords
    const ang = (v: Vec) => Math.atan2(v.y - n.y, v.x - n.x), step = 2 * Math.PI / RINGS[size].n, nodes: Node[] = [];
    cuts.sort((p, q) => ang(q) - ang(p));
    cuts.forEach((v, i) => {
      nodes.push(v);
      let arc = ang(v) - ang(cuts[(i + 1) % cuts.length]);
      if (arc <= 1e-9) arc += 2 * Math.PI;
      const k = Math.max(1, Math.round(arc / step));
      for (let j = 1; j < k; j++) { const a = ang(v) - arc * j / k; nodes.push(this.addNode(n.x + Math.cos(a) * R, n.y + Math.sin(a) * R)); }
    });
    const hub = this.node(n.x, n.y), ring: Ring = { hub, nodes, spokes: spoke, lanes };
    Object.assign(hub, { control: 'roundabout', ring: size, controlDay: day });
    nodes.forEach((v, i) => this.addEdge(v, nodes[(i + 1) % nodes.length], { bridge: false, tunnel: false, level: 0, type: ringType(lanes), ring }, day));
    this.rings.push(ring);
    return { ring, cars };
  }

  // The spokes removeRing lays, one per road off the ring: the piece the build took out there (Ring spokes), else (a road joined to the
  // ring later, or a ring saved before spokes) a fresh one of that road's type and its direction, dated day: Game charges for those.
  spokesOf(r: Ring, day: number): { v: Node; a: Edge; s: Spoke; fresh: boolean }[] {
    return r.nodes.flatMap(v => v.edges.filter(e => !e.ring).map((a, i) => {
      const s = i ? undefined : r.spokes.get(v);
      return { v, a, s: s ?? { type: a.type, day, drive: false, exit: false, out: a.type.oneWay && a.a === v }, fresh: !s };
    }));
  }

  // Takes the ring out: a plain node at its centre joined to each road off it by a spoke (spokesOf). Returns that node and the cars
  // taken off the ring.
  removeRing(r: Ring, day: number): { node: Node; cars: Car[] } {
    const c = this.addNode(r.hub.x, r.hub.y), cars: Car[] = [];
    for (const { v, a, s } of this.spokesOf(r, day))
      this.addEdge(s.out ? c : v, s.out ? v : c, { bridge: a.bridge, tunnel: a.tunnel, level: a.level, type: s.type, drive: s.drive, exit: s.exit }, s.day);
    for (const v of r.nodes) for (const e of [...v.edges]) if (e.ring) cars.push(...this.removeEdge(e));
    this.rings = this.rings.filter(x => x !== r);
    this.dropIfOrphan(c);
    return { node: c, cars };
  }

  detachCar(c: Car): void {
    const i = c.lane.cars.indexOf(c);
    if (i >= 0) c.lane.cars.splice(i, 1);
    c.granted?.occupants.delete(c);
    c.clearing?.occupants.delete(c);
    const q = c.lane.to.queue, j = q.indexOf(c);
    if (j >= 0) q.splice(j, 1);
  }
}
