import type { Node } from '../network/RoadGraph.ts';
import type { Vec } from '../util/geom.ts';
import { TUNING as T, ZONES } from '../core/config.ts';
import type { Zone } from '../core/config.ts';
import type { Trip } from './Trip.ts';

// Door: DOOR_D px out from the middle of the front face; roads snap to it within DOOR_R
export const DOOR_D = 10, DOOR_R = 14;

// PEOPLE_PER_CAR workers driving one car; next = game time of its next departure, at = where the car is
export interface Commuter { home: Building; work: Building | null; depart: number; next: number; at: 'home' | 'driving' | 'away' }

// A footprint (rounded rect) facing 'angle' (radians, toward its door). node = the door, its access point to the network.
// pending: trips waiting at the door; parked: trips that arrived here and wait for their return leg.
export class Building {
  node!: Node;
  pending: Trip[] = [];
  parked: Trip[] = [];
  residents = 0;
  stock: number = T.STOCK_START; // shop goods
  staffed = 0;           // 0..1 share of jobs with a commuter parked here
  shopAcc = 0;           // fractional shopping / freight trips accrued hourly
  truckAcc = 0;
  retryTimer = 0;

  constructor(public kind: Zone, public x: number, public y: number, public angle: number) {}

  get w(): number { return ZONES[this.kind].w; }
  get h(): number { return ZONES[this.kind].h; }
  get jobs(): number { return ZONES[this.kind].jobs; }
  get connected(): boolean { return this.node.edges.length > 0; }

  door(): Vec {
    const d = this.h / 2 + DOOR_D;
    return { x: this.x + Math.cos(this.angle) * d, y: this.y + Math.sin(this.angle) * d };
  }

  // p inside the footprint grown by pad
  contains(p: Vec, pad = 0): boolean {
    const dx = p.x - this.x, dy = p.y - this.y, c = Math.cos(this.angle), s = Math.sin(this.angle);
    return Math.abs(dx * c + dy * s) <= this.h / 2 + pad && Math.abs(dy * c - dx * s) <= this.w / 2 + pad;
  }
}

// Footprint facing angle with its door at p
export const buildingAt = (kind: Zone, p: Vec, angle: number): Building => {
  const d = ZONES[kind].h / 2 + DOOR_D;
  return new Building(kind, p.x - Math.cos(angle) * d, p.y - Math.sin(angle) * d, angle);
};
