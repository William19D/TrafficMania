import type { Purpose } from '../core/config.ts';
import type { Building, Commuter } from './Building.ts';

export type Outcome = 'smooth' | 'wait' | 'detour' | 'gaveup' | 'noroute';
export const OUTCOMES: Outcome[] = ['smooth', 'wait', 'detour', 'gaveup', 'noroute'];
export const FAILED: Outcome[] = ['gaveup', 'noroute'];

// One car journey; back = the return leg (it queues no further trip). Times are game seconds:
// queued / departed (left the door), leave = when the return leg goes once parked at 'to' (0 = at once);
// ideal / idealLen = free-flow time and length at departure; driven / stopped are added up by the car.
export interface Trip {
  purpose: Purpose; from: Building; to: Building; back: boolean; who: Commuter | null;
  queued: number; departed: number; leave: number; ideal: number; idealLen: number; driven: number; stopped: number; retries: number;
}
export const makeTrip = (purpose: Purpose, from: Building, to: Building, back = false, who: Commuter | null = null, queued = 0): Trip =>
  ({ purpose, from, to, back, who, queued, departed: 0, leave: 0, ideal: 0, idealLen: 0, driven: 0, stopped: 0, retries: 0 });

export interface TripReport { purpose: Purpose; back: boolean; from: Building; to: Building; outcome: Outcome; seconds: number; day: number; hour: number }
