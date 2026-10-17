import type { Purpose } from '../core/config.ts';
import type { Building, Commuter } from './Building.ts';
import type { Control, Node } from '../network/RoadGraph.ts';
import type { Vec } from '../util/geom.ts';

export type Outcome = 'smooth' | 'wait' | 'detour' | 'gaveup' | 'noroute';
export const OUTCOMES: Outcome[] = ['smooth', 'wait', 'detour', 'gaveup', 'noroute'];
export const FAILED: Outcome[] = ['gaveup', 'noroute'];
// Trip quality per outcome (happiness, taxes)
export const SCORE: Record<Outcome, number> = { smooth: 1, detour: 0.6, wait: 0.4, gaveup: 0, noroute: 0 };

// One car journey; back = the return leg (it queues no further trip). Times are game seconds:
// queued / departed (left the door), leave = when the return leg goes once parked at 'to' (0 = at once);
// ideal / idealLen = free-flow time and length at departure; driven / stopped are added up by the car; jam / jamS = the node ahead
// during its longest stop and how long that stop was.
export interface Trip {
  purpose: Purpose; from: Building; to: Building; back: boolean; who: Commuter | null;
  queued: number; departed: number; leave: number; ideal: number; idealLen: number; driven: number; stopped: number; retries: number;
  jam: Node | null; jamS: number;
}
export const makeTrip = (purpose: Purpose, from: Building, to: Building, back = false, who: Commuter | null = null, queued = 0): Trip =>
  ({ purpose, from, to, back, who, queued, departed: 0, leave: 0, ideal: 0, idealLen: 0, driven: 0, stopped: 0, retries: 0, jam: null, jamS: 0 });

// A finished trip. ratio = seconds / free-flow time, stretch = driven / free-flow length, door = seconds waited before leaving;
// jam = where the longest stop was (a copy: the node may be gone), what stood there ('road' = a queue between junctions), jamS its length
export interface TripReport {
  purpose: Purpose; back: boolean; from: Building; to: Building; outcome: Outcome; seconds: number; day: number; hour: number;
  ratio: number; stretch: number; door: number; jam: Vec | null; jamAt: Control | 'road'; jamS: number;
  stopped?: number; // absent in older saves
}
