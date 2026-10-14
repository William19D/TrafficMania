import { CAR_LEN, GAP, LC_M, LC_S, NODE_R, stopDist } from '../network/RoadGraph.ts';
import type { RoadGraph, Lane, Node, Edge } from '../network/RoadGraph.ts';
import { PURPOSES, TIERS } from '../core/config.ts';
import { findPath } from '../network/Pathfinder.ts';
import type { Building } from './Building.ts';
import type { Trip } from './Trip.ts';
import { random } from '../util/rng.ts';

export const MAX_SPEED = 110, ACCEL = 80, BRAKE = 180, TURN_SPEED = 45;
// Deadlock breaker: seconds stopped before rerouting around the next edge, and before giving up the trip
export const REROUTE_S = 8, GIVE_UP_S = 20;

// Vehicle kinds: length, top speed and acceleration factors, spawn weight (trucks only carry freight, so 0).
// Ambulances jump node queues (RoadGraph.update).
export type Kind = 'car' | 'truck' | 'bus' | 'moto' | 'ambulance';
export const KINDS: Record<Kind, { len: number; v: number; a: number; w: number }> = {
  car: { len: CAR_LEN, v: 1, a: 1, w: 0.72 },
  truck: { len: 24, v: 0.75, a: 0.55, w: 0 },
  bus: { len: 26, v: 0.7, a: 0.5, w: 0.06 },
  moto: { len: 10, v: 1.1, a: 1.4, w: 0.09 },
  ambulance: { len: CAR_LEN, v: 1.15, a: 1.1, w: 0.03 },
};
const W = Object.values(KINDS).reduce((n, k) => n + k.w, 0);
export const randomKind = (): Kind => {
  let r = random() * W;
  for (const k in KINDS) if ((r -= KINDS[k as Kind].w) < 0) return k as Kind;
  return 'car';
};
// Centre-to-centre distance of two touching vehicles (s is the centre)
export const sep = (a: Car, b: Car): number => (a.len + b.len) / 2;

export class Car {
  s = 0;
  speed = 0;
  path: Node[] | null = null;
  granted: Node | null = null;
  clearing: Node | null = null;
  queued = false;
  // Node before lane.from (the approach we came from), for the roundabout ring animation
  prev: Node | null = null;
  // Lateral offset of the previous lane, to blend the lane change at the node
  prevOffset = 0;
  // Index hint into lane.cars; verified before use since other cars shift it
  idx = 0;
  // Lane we will take past lane.to; RoadGraph only grants the turn when it has room
  exit: Lane | null = null;
  // Seconds spent stopped
  wait = 0;
  // Mid-edge lane change: seconds left of the slide, and the old lane's offset minus the new one's
  lc = 0;
  lcOff = 0;
  // Lights for the renderer: decelerating or stopped; indicator 1 right / -1 left / 0 off (lane change, or turn within 60px)
  brake = false;
  blink = 0;
  // Driver on top of the kind: top speed ±10%, acceleration ±15%, reaction time in seconds (extra headway at speed);
  // braking stays shared so gaps hold
  len: number;
  vmax: number;
  acc: number;
  react: number;

  constructor(public lane: Lane, public trip: Trip, public kind: Kind = 'car') {
    const k = KINDS[kind];
    this.len = k.len;
    this.vmax = MAX_SPEED * k.v * (0.9 + 0.2 * random());
    this.acc = ACCEL * k.a * (0.85 + 0.3 * random());
    this.react = 0.2 * random();
  }

  // Top speed on an edge: the driver's own, scaled by the road tier's speed limit
  top(e: Edge): number {
    return this.vmax * TIERS[e.type.tier].limit / MAX_SPEED;
  }

  get dest(): Building { return this.trip.to; }
  get origin(): Building { return this.trip.from; }
  get color(): string { return PURPOSES[this.trip.purpose].color; }

  update(dt: number, graph: RoadGraph): 'ok' | 'arrived' | 'lost' | 'stuck' {
    let lane = this.lane;
    const node = lane.to;
    const remaining = lane.edge.length - this.s;
    const isDest = node === this.dest.node;

    const w = this.wait;
    this.wait = this.speed < 1 ? w + dt : 0;
    if (this.wait > GIVE_UP_S) return 'stuck';

    // Recompute route from the node we are heading to; U-turn back down our own edge only when nothing else leads there
    if (!isDest && (!this.path || this.path[0] !== node)) {
      this.path = findPath(graph, node, this.dest.node, lane.edge) ?? findPath(graph, node, this.dest.node);
      if (!this.path) return 'lost';
    } else if (!isDest && w <= REROUTE_S && this.wait > REROUTE_S) {
      // ponytail: blames the next edge; a jam on our own lane can only be escaped by giving up
      const p = findPath(graph, node, this.dest.node, graph.edgeBetween(node, this.path![1]!));
      if (p) this.path = p;
    }

    let nextLane: Lane | null = null;
    if (!isDest && this.path) {
      const next = this.path[1];
      const e = next ? graph.edgeBetween(node, next) : null;
      // Keep the exit once granted or inside the turn arc, so fits()'s lane is the one entered and the drawn arc doesn't jump
      const x = this.exit, keep = x && x.edge === e && x.from === node && e.lanes.includes(x) && (this.granted === node || remaining < 2 * NODE_R);
      nextLane = keep ? x : e ? graph.pickLane(e, node, graph.turn(this.path, 1)) : null;
      // missing edge or now one-way against: recompute the route next tick
      if (!nextLane) this.path = null;
    }
    this.exit = nextLane;

    // Free distance to the car ahead
    let gap = Infinity;
    // ponytail: unshift/splice move us by at most 1 per event, so check the neighbours before the O(n) scan
    let idx = this.idx;
    if (lane.cars[idx] !== this) idx = lane.cars[idx + 1] === this ? idx + 1 : lane.cars[idx - 1] === this ? idx - 1 : lane.cars.indexOf(this);
    if (this.lc > 0) this.lc = Math.max(0, this.lc - dt);
    else { idx = this.changeLane(graph, idx); lane = this.lane; }
    this.idx = idx;
    this.blink = this.lc ? -Math.sign(this.lcOff) : !isDest && this.path && remaining < 60 ? graph.turn(this.path, 0, lane.from) : 0;
    const ahead = lane.cars[idx + 1];
    if (ahead) gap = ahead.s - this.s - sep(this, ahead);
    else if (nextLane && nextLane.cars.length) gap = remaining + nextLane.cars[0]!.s - sep(this, nextLane.cars[0]!);

    // Intersection control: request a turn and wait before the node
    const needs = !isDest && graph.needsControl(node);
    if (needs && this.granted !== node) {
      if (remaining < 70 && !this.queued) { node.queue.push(this); this.queued = true; }
      gap = Math.min(gap, remaining - stopDist(node));
    } else if (!isDest && !nextLane) {
      gap = Math.min(gap, remaining - NODE_R - 3);
    } else if (!isDest && this.path) {
      // Stop line of the next controlled node past this one, so a short edge after it (a bent road's) still leaves room to stop.
      // ponytail: 150px horizon covers the fastest driver's braking + reaction headway on a highway (~145px); widen it if KINDS or TIERS get faster
      for (let j = 0, d = remaining; j + 1 < this.path.length && d < 150; j++) {
        const n = this.path[j + 1]!;
        d += graph.edgeBetween(this.path[j]!, n)?.length ?? Infinity;
        if (n === this.dest.node) break;
        if (graph.needsControl(n)) { gap = Math.min(gap, d - stopDist(n)); break; }
      }
    }

    let target = this.top(lane.edge);
    if (needs && remaining < 60) target = Math.min(target, TURN_SPEED);
    if (nextLane) {
      // Corner speed: top speed (the slower tier of the two) * cos(turn angle) at the node, floored at TURN_SPEED,
      // braked down to by the node box; so a car also slows down before a slower tier
      // ponytail: one node ahead only; a sharper corner < ~35px (braking distance) past it is taken late, walk this.path if that shows
      const cos = ((node.x - lane.from.x) * (nextLane.to.x - node.x) + (node.y - lane.from.y) * (nextLane.to.y - node.y)) / (lane.edge.length * nextLane.edge.length);
      const v = Math.max(TURN_SPEED, Math.min(this.top(lane.edge), this.top(nextLane.edge)) * cos);
      target = Math.min(target, Math.sqrt(v * v + 2 * BRAKE * Math.max(0, remaining - NODE_R)));
    }
    target = Math.min(target, Math.sqrt(2 * BRAKE * Math.max(0, gap - GAP - this.speed * this.react)));
    this.brake = target < this.speed || this.speed < 1;
    this.speed = target > this.speed ? Math.min(target, this.speed + this.acc * dt) : Math.max(target, this.speed - BRAKE * dt);
    this.s += this.speed * dt;

    // Release the intersection we just crossed once our rear is out of it (fits() leaves room for that)
    if (this.clearing && this.s - this.len / 2 > NODE_R) { this.clearing.occupants.delete(this); this.clearing = null; }

    if (this.s < lane.edge.length) return 'ok';
    if (isDest) return 'arrived';
    // No exit, no grant (a control placed too close to stop), or another car just entered it (same light group / roundabout): wait in the box
    const first = nextLane?.cars[0];
    if (!nextLane || (needs && this.granted !== node) || (first && first.s < sep(this, first) + GAP)) { this.s = lane.edge.length; this.speed = 0; return 'ok'; }

    // Move to the next lane
    let ns = this.s - lane.edge.length;
    if (first) ns = Math.min(ns, first.s - sep(this, first) - GAP);
    lane.cars.splice(idx, 1);
    nextLane.cars.unshift(this);
    this.idx = 0;
    this.prev = lane.from;
    this.prevOffset = lane.offset;
    this.lane = nextLane;
    this.s = ns;
    this.queued = false;
    this.path = null;
    if (this.granted === node) { this.clearing?.occupants.delete(this); this.clearing = node; this.granted = null; }
    return 'ok';
  }

  // Mid-edge lane change, LC_M clear of both nodes: into the lane the next turn needs, or past a slow car into a roomier lane.
  // Needs room ahead to brake behind the new leader and room for the follower to stop. Returns the index in this.lane.
  // ponytail: a car still in the wrong lane at the node just takes the turn from there
  private changeLane(graph: RoadGraph, idx: number): number {
    const lane = this.lane, ls = graph.lanesFrom(lane.edge, lane.from);
    if (ls.length < 2 || this.s < LC_M || lane.edge.length - this.s < LC_M) return idx;
    const k = ls.indexOf(lane), t = this.path ? graph.turn(this.path, 0, lane.from) : 0, w = t > 0 ? ls.length - 1 : 0;
    const ahead = lane.cars[idx + 1], gap = ahead ? ahead.s - this.s - sep(this, ahead) : Infinity;
    const slow = !!ahead && ahead.speed < this.top(lane.edge) * 0.6 && gap < 4 * CAR_LEN;
    const brake = (v: number) => v * v / (2 * BRAKE);
    for (const to of t ? (w === k ? [] : [ls[k + Math.sign(w - k)]]) : slow ? [ls[k - 1], ls[k + 1]] : []) {
      if (!to) continue;
      let at = to.cars.findIndex(o => o.s > this.s);
      if (at < 0) at = to.cars.length;
      const a = to.cars[at], b = to.cars[at - 1];
      const room = a ? a.s - this.s - sep(this, a) : Infinity;
      if (a && room < GAP + Math.max(0, brake(this.speed) - brake(a.speed))) continue;
      if (b && this.s - b.s - sep(this, b) < GAP + brake(b.speed)) continue;
      if (!t && room < gap + 2 * CAR_LEN) continue;
      lane.cars.splice(idx, 1);
      to.cars.splice(at, 0, this);
      this.lcOff = lane.offset - to.offset;
      this.lc = LC_S;
      this.lane = to;
      return at;
    }
    return idx;
  }
}
