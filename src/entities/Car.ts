import { CAR_LEN, GAP, NODE_R } from '../network/RoadGraph.ts';
import type { RoadGraph, Lane, Node } from '../network/RoadGraph.ts';
import { findPath } from '../network/Pathfinder.ts';
import type { City } from './City.ts';

export const MAX_SPEED = 110, ACCEL = 80, BRAKE = 180, TURN_SPEED = 45;

export class Car {
  s = 0;
  speed = 0;
  path: Node[] | null = null;
  granted: Node | null = null;
  clearing: Node | null = null;
  queued = false;

  constructor(public lane: Lane, public dest: City) {}

  get color(): string {
    return this.dest.color;
  }

  update(dt: number, graph: RoadGraph): 'ok' | 'arrived' | 'lost' {
    const lane = this.lane;
    const node = lane.to;
    const remaining = lane.edge.length - this.s;
    const isDest = node === this.dest.node;

    // Recompute route from the node we are heading to
    if (!isDest && (!this.path || this.path[0] !== node)) {
      this.path = findPath(graph, node, this.dest.node);
      if (!this.path) return 'lost';
    }

    let nextLane: Lane | null = null;
    if (!isDest && this.path) {
      const next = this.path[1];
      const e = next ? graph.edgeBetween(node, next) : null;
      if (e) nextLane = graph.laneFrom(e, node);
      else this.path = null;
    }

    // Free distance to the car ahead
    let gap = Infinity;
    const idx = lane.cars.indexOf(this);
    const ahead = lane.cars[idx + 1];
    if (ahead) gap = ahead.s - this.s - CAR_LEN;
    else if (nextLane && nextLane.cars.length) gap = remaining + nextLane.cars[0]!.s - CAR_LEN;

    // Intersection control: request a turn and wait before the node
    const needs = !isDest && graph.needsControl(node);
    if (needs && this.granted !== node) {
      if (remaining < 70 && !this.queued) { node.queue.push(this); this.queued = true; }
      gap = Math.min(gap, remaining - NODE_R - 3);
    } else if (!isDest && !nextLane) {
      gap = Math.min(gap, remaining - NODE_R - 3);
    }

    let target = needs && remaining < 60 ? TURN_SPEED : MAX_SPEED;
    target = Math.min(target, Math.sqrt(2 * BRAKE * Math.max(0, gap - GAP)));
    this.speed = target > this.speed ? Math.min(target, this.speed + ACCEL * dt) : Math.max(target, this.speed - BRAKE * dt);
    this.s += this.speed * dt;

    // Release the intersection we just crossed
    if (this.clearing && this.s > NODE_R + CAR_LEN) { this.clearing.occupants.delete(this); this.clearing = null; }

    if (this.s < lane.edge.length) return 'ok';
    if (isDest) return 'arrived';
    if (!nextLane) { this.s = lane.edge.length; this.speed = 0; return 'ok'; }

    // Move to the next lane
    let ns = this.s - lane.edge.length;
    const first = nextLane.cars[0];
    if (first) ns = Math.min(ns, Math.max(0, first.s - CAR_LEN - GAP));
    lane.cars.splice(idx, 1);
    nextLane.cars.unshift(this);
    this.lane = nextLane;
    this.s = ns;
    this.queued = false;
    this.path = null;
    if (this.granted === node) { this.clearing?.occupants.delete(this); this.clearing = node; this.granted = null; }
    return 'ok';
  }
}
