import type { Purpose } from '../core/config.ts';
import type { Building } from './Building.ts';

// One car journey; back = the return leg (it queues no further trip). S5 adds timing and the outcome.
export interface Trip { purpose: Purpose; from: Building; to: Building; back: boolean }
