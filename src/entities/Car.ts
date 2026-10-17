import { BRAKE, CAR_LEN, GAP, LC_M, LC_S, NODE_R, RINGS, stopDist } from '../network/RoadGraph.ts';
import type { RoadGraph, Lane, Node, Edge } from '../network/RoadGraph.ts';
import { TIERS } from '../core/config.ts';
import { findPath } from '../network/Pathfinder.ts';
import { ANY } from '../network/Junction.ts';
import type { Building } from './Building.ts';
import type { Trip } from './Trip.ts';
import { random } from '../util/rng.ts';

export const MAX_SPEED = 110, ACCEL = 80, TURN_SPEED = 45;
// Deadlock breaker: seconds stopped before rerouting around the next edge, and before giving up the trip
export const REROUTE_S = 8, GIVE_UP_S = 20;

// Vehicle kinds: length, top speed and acceleration factors, spawn weight for passenger trips (trucks only carry freight, so 0).
// Trips are private, so no buses. An ambulance only drives a hospital's emergency calls (weight 0), with priority at junctions
// (RoadGraph.update).
export type Kind = 'car' | 'truck' | 'moto' | 'ambulance';
export const KINDS: Record<Kind, { len: number; v: number; a: number; w: number }> = {
  car: { len: CAR_LEN, v: 1, a: 1, w: 0.88 },
  truck: { len: 24, v: 0.75, a: 0.55, w: 0 },
  moto: { len: 10, v: 1.1, a: 1.4, w: 0.12 },
  ambulance: { len: CAR_LEN, v: 1.15, a: 1.1, w: 0 },
};
const W = Object.values(KINDS).reduce((n, k) => n + k.w, 0);
export const randomKind = (): Kind => {
  let r = random() * W;
  for (const k in KINDS) if ((r -= KINDS[k as Kind].w) < 0) return k as Kind;
  return 'car';
};
// Paint roll in [0, 1) per spawned vehicle (VehicleArt maps it to a weighted palette); a hash of a counter, so it never
// shifts the sim's seeded rng
let serial = 0;
const roll = (): number => (Math.imul(++serial, 0x9E3779B1) >>> 0) / 2 ** 32;
// Centre-to-centre distance of two touching vehicles (s is the centre)
export const sep = (a: Car, b: Car): number => (a.len + b.len) / 2;

export class Car {
  s = 0;
  speed = 0;
  path: Node[] | null = null;
  granted: Node | null = null;
  clearing: Node | null = null;
  queued = false;
  // Node before lane.from (the approach we came from), for the turn arc
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
  paint = roll();

  constructor(public lane: Lane, public trip: Trip, public kind: Kind = 'car') {
    const k = KINDS[kind];
    this.len = k.len;
    this.vmax = MAX_SPEED * k.v * (0.9 + 0.2 * random());
    this.acc = ACCEL * k.a * (0.85 + 0.3 * random());
    this.react = 0.2 * random();
  }

  // Top speed on an edge: the driver's own, scaled by the road tier's speed limit (a ring's own) and the events' factor (rain, a wreck)
  // ponytail: rain only lowers top speed; braking and headway stay dry
  top(e: Edge, g: RoadGraph): number {
    return this.vmax * (e.ring ? RINGS[e.ring.hub.ring].v : TIERS[e.type.tier].limit) / MAX_SPEED * g.speedX(e);
  }

  get dest(): Building { return this.trip.to; }
  get origin(): Building { return this.trip.from; }

  update(dt: number, graph: RoadGraph): 'ok' | 'arrived' | 'lost' | 'stuck' {
    let lane = this.lane;
    const node = lane.to;
    const remaining = lane.edge.length - this.s;
    const isDest = node === this.dest.node;

    const w = this.wait;
    this.wait = this.speed < 1 ? w + dt : 0;
    if (this.wait > this.trip.jamS) { this.trip.jamS = this.wait; this.trip.jam = node; }
    if (this.wait > GIVE_UP_S) return 'stuck';

    // Recompute route from the node we are heading to; U-turn back down our own edge only when nothing else leads there
    // an event shut the next edge: a new route unless the turn is already granted
    const shut = !isDest && graph.shut.size > 0 && this.path?.[0] === node && this.granted !== node && graph.shut.has(graph.edgeBetween(node, this.path[1]!)!);
    if (!isDest && (!this.path || this.path[0] !== node || shut)) {
      this.path = findPath(graph, node, this.dest.node, lane.edge, false, lane.edge) ?? findPath(graph, node, this.dest.node, null, false, lane.edge);
      if (!this.path) return 'lost';
    } else if (!isDest && w <= REROUTE_S && this.wait > REROUTE_S) {
      // ponytail: blames the next edge; a jam on our own lane can only be escaped by giving up.
      // Never a U-turn: two cars turning back into each other's lane on a short link wait for each other forever
      const p = findPath(graph, node, this.dest.node, graph.edgeBetween(node, this.path![1]!), false, lane.edge);
      if (p && p[1] !== lane.from) this.path = p;
    }

    // Past the last lane change in a lane whose arrows don't allow the next move: a route its arrows do allow
    // ponytail: none (a dead end behind the arrows) keeps the route and takes the turn from the wrong lane
    if (!isDest && this.path && remaining < LC_M && !graph.arrowLanes(lane.edge, lane.from, this.path[1])?.includes(lane) && graph.arrows(lane) !== ANY)
      this.path = findPath(graph, node, this.dest.node, null, false, lane.edge, graph.arrows(lane)) ?? this.path;

    let nextLane: Lane | null = null;
    if (!isDest && this.path) {
      const next = this.path[1];
      const e = next ? graph.edgeBetween(node, next) : null;
      // Keep the exit once granted or inside the turn arc, so fits()'s lane is the one entered and the drawn arc doesn't jump
      const x = this.exit, keep = x && x.edge === e && x.from === node && e.lanes.includes(x) && (this.granted === node || remaining < 2 * NODE_R);
      // through a bend (or past a driveway join) a car keeps its lane where the count does too, so two lanes never feed one unchecked
      const ls = e ? graph.lanesFrom(e, node) : [], mine = graph.lanesFrom(lane.edge, lane.from), same = ls[mine.indexOf(lane)];
      const ok = e && graph.arrowLanes(e, node, this.path[2]);
      nextLane = keep ? x : !e ? null : same && ls.length === mine.length && !graph.needsControl(node, lane.edge) && (!ok || ok.includes(same)) ? same
        : graph.pickLane(e, node, graph.turn(this.path, 1), this.path[2]);
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
    // else the first car on the lanes ahead along the route within braking reach (short links: a ring's chords are shorter than a
    // truck), each the same lane index on (as through a bend)
    // ponytail: 150px like the stop line horizon below; a lane picked past a junction may differ, its stop line covers that
    else for (let j = 1, d = remaining, l = nextLane; l; j++) {
      const f = l.cars[0];
      if (f) { gap = d + f.s - sep(this, f); break; }
      if ((d += l.edge.length) > 150) break;
      const q = this.path?.[j + 1], e = q && graph.edgeBetween(l.to, q), ls = e ? graph.lanesFrom(e, l.to) : [];
      l = ls[Math.min(graph.lanesFrom(l.edge, l.from).indexOf(l), ls.length - 1)] ?? null;
    }

    // Intersection control: request a turn and wait before the node. Road traffic only stops at a driveway junction to keep it
    // clear for a merging car (RoadGraph.held), and only when it still can.
    const needs = !isDest && graph.needsControl(node, lane.edge);
    const keep = (n: Node, d: number, via: Edge | null): boolean => !!via && !via.drive && graph.drivewayJunction(n) && graph.held(n, via)
      && d - stopDist(n) >= this.speed * this.speed / (2 * BRAKE);
    if (needs && this.granted !== node) {
      // farther out (RoadGraph.queueAt) only in lane order: never ahead of the car in front
      const at = remaining < 70 || (remaining < 120 && (!ahead || ahead.queued) && remaining < graph.queueAt(node, lane.edge, this));
      if (at && !this.queued) { node.queue.push(this); this.queued = true; }
      gap = Math.min(gap, remaining - stopDist(node));
    } else if (!isDest && !nextLane) {
      gap = Math.min(gap, remaining - NODE_R - 3);
    } else if (!isDest && keep(node, remaining, lane.edge)) {
      gap = Math.min(gap, remaining - stopDist(node));
    } else if (!isDest && this.path) {
      // Stop line of the next controlled node past this one, so a short edge after it (a bent road's) still leaves room to stop.
      // ponytail: 150px horizon covers the fastest driver's braking + reaction headway on a highway (~145px); widen it if KINDS or TIERS get faster
      for (let j = 0, d = remaining; j + 1 < this.path.length && d < 150; j++) {
        const n = this.path[j + 1]!, x = graph.edgeBetween(this.path[j]!, n);
        d += x?.length ?? Infinity;
        if (n === this.dest.node) break;
        // a car only queues at the node its lane leads to: a stop line short of this lane's end (a junction just past a plain joint,
        // where a road crosses a curve) is reached from the link after the joint, so it rolls onto that link and stops there
        const line = d - stopDist(n), roll = remaining + GAP + 1;
        if (graph.needsControl(n, x)) { gap = Math.min(gap, Math.max(line, roll)); break; }
        if (keep(n, d, x)) { gap = Math.min(gap, line); break; }
      }
    }

    let target = this.top(lane.edge, graph);
    // approach a junction slowly until granted; once granted only the corner speed below applies
    if (needs && remaining < 60 && this.granted !== node) target = Math.min(target, TURN_SPEED);
    if (nextLane) {
      // Corner speed: top speed (the slower tier of the two) * cos(turn angle) at the node, floored at TURN_SPEED,
      // braked down to by the node box; so a car also slows down before a slower tier
      // ponytail: one node ahead only; a sharper corner < ~35px (braking distance) past it is taken late, walk this.path if that shows
      const cos = ((node.x - lane.from.x) * (nextLane.to.x - node.x) + (node.y - lane.from.y) * (nextLane.to.y - node.y)) / (lane.edge.length * nextLane.edge.length);
      const v = Math.max(TURN_SPEED, Math.min(this.top(lane.edge, graph), this.top(nextLane.edge, graph)) * cos);
      target = Math.min(target, Math.sqrt(v * v + 2 * BRAKE * Math.max(0, remaining - NODE_R)));
    }
    target = Math.min(target, Math.sqrt(2 * BRAKE * Math.max(0, gap - GAP - this.speed * this.react)));
    this.brake = target < this.speed || this.speed < 1;
    const s0 = this.s;
    this.speed = target > this.speed ? Math.min(target, this.speed + this.acc * dt) : Math.max(target, this.speed - BRAKE * dt);
    this.s += this.speed * dt;
    this.trip.driven += this.speed * dt;
    if (this.speed < 1) this.trip.stopped += dt;

    // Release the intersection we just crossed once our rear is out of it (fits() leaves room for that), or once we stop past it
    // (at the next line, or in a queue through a driveway junction): on a link shorter than ~NODE_R + stopDist + the car, holding
    // the box there gridlocks the two junctions.
    // ponytail: the rear then overhangs the box by a few px; DRIVE_SNAP keeps driveways from cutting such links
    if (this.clearing && (this.s - this.len / 2 > NODE_R || this.speed < 1)) { this.clearing.occupants.delete(this); this.clearing = null; }

    if (this.s < lane.edge.length) return 'ok';
    if (isDest) return 'arrived';
    // No exit, no grant (a control placed too close to stop), or another car just entered the next lane: wait where it was this tick.
    // Never at the node itself on top of that car.
    const first = nextLane?.cars[0];
    if (!nextLane || (needs && this.granted !== node) || (first && first.s < sep(this, first) + GAP)) { this.s = Math.min(s0, lane.edge.length); this.speed = 0; return 'ok'; }

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
    // target lane w (-1: none): the nearest lane the junction's arrows allow for the next move, else the turn's outer lane
    const k = ls.indexOf(lane), t = this.path ? graph.turn(this.path, 0, lane.from) : 0;
    const ok = this.path ? graph.arrowLanes(lane.edge, lane.from, this.path[1])?.map(l => ls.indexOf(l)) : null;
    const w = ok ? (ok.includes(k) || !ok.length ? -1 : ok.reduce((b, i) => Math.abs(i - k) < Math.abs(b - k) ? i : b)) : t ? (t > 0 ? ls.length - 1 : 0) : -1;
    const ahead = lane.cars[idx + 1], gap = ahead ? ahead.s - this.s - sep(this, ahead) : Infinity;
    const slow = !!ahead && ahead.speed < this.top(lane.edge, graph) * 0.6 && gap < 4 * CAR_LEN && (!!ok || !t);
    const brake = (v: number) => v * v / (2 * BRAKE);
    for (const to of w >= 0 ? (w === k ? [] : [ls[k + Math.sign(w - k)]]) : slow ? [k - 1, k + 1].filter(i => !ok || ok.includes(i)).map(i => ls[i]) : []) {
      if (!to) continue;
      let at = to.cars.findIndex(o => o.s > this.s);
      if (at < 0) at = to.cars.length;
      const a = to.cars[at], b = to.cars[at - 1];
      const room = a ? a.s - this.s - sep(this, a) : Infinity;
      if (a && room < GAP + Math.max(0, brake(this.speed) - brake(a.speed))) continue;
      if (b && this.s - b.s - sep(this, b) < GAP + brake(b.speed)) continue;
      if (w < 0 && room < gap + 2 * CAR_LEN) continue;
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
