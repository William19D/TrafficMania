import type { Node } from '../network/RoadGraph.ts';
import type { Vec } from '../util/geom.ts';
import { TIER_DEFS, TUNING as T, ZONES } from '../core/config.ts';
import type { Site, Zone } from '../core/config.ts';
import type { Trip } from './Trip.ts';
import type { Lot } from '../core/Zones.ts';

// Door: DOOR_D px out from the middle of the front face; roads snap to it within DOOR_R
export const DOOR_D = 10, DOOR_R = 14;

// What a home's happiness is made of, each 0..1 (Game.rateHome)
export interface Parts { job: number; shop: number; trips: number; pollution: number; noise: number }

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
  importAcc = 0;         // trucks from outside (factory raw materials, a short shop's goods) and visitors, accrued hourly
  visitAcc = 0;
  retryTimer = 0;
  happy = 60;            // 0..100, homes only, hourly
  parts: Parts = { job: 0, shop: 0, trips: 0.6, pollution: 0, noise: 0 };
  // SCORE of each trip from or to it in the last 24h; shop = an outbound shopping trip (homes)
  recent: { at: number; score: number; shop: boolean }[] = [];
  // Zones (game-v3 2). tier 0 = legacy: ZONES footprint and capacity, never changes tier; 1+ = TIER_DEFS row, grown on its lots.
  // access: A 0..1 (Zones.access), hourly; downH / upH: hours in a row bad (toward abandon or clear) / good while abandoned;
  // cause: why the countdown runs, and where to fix it
  tier = 0;
  lots: Lot[] = [];
  abandoned = false;
  access = 0.7;
  downH = 0;
  upH = 0;
  cause: { text: string; at: Vec | null } | null = null;

  constructor(public kind: Site, public x: number, public y: number, public angle: number) {}

  get def(): { w: number; h: number; residents: number; jobs: number } { return this.tier ? TIER_DEFS[this.kind as Zone][this.tier - 1] : ZONES[this.kind]; }
  get label(): string { return this.tier ? TIER_DEFS[this.kind as Zone][this.tier - 1].name : ZONES[this.kind].label; }
  get w(): number { return this.def.w; }
  get h(): number { return this.def.h; }
  get cap(): number { return this.abandoned ? 0 : this.def.residents; }
  get jobs(): number { return this.abandoned ? 0 : this.def.jobs; }
  get connected(): boolean { return this.node.edges.length > 0; }

  door(): Vec {
    const d = this.h / 2 + DOOR_D;
    return { x: this.x + Math.cos(this.angle) * d, y: this.y + Math.sin(this.angle) * d };
  }

  // Corners and side midpoints of the footprint, then the door
  outline(): Vec[] {
    const c = Math.cos(this.angle), s = Math.sin(this.angle), h = this.h / 2, w = this.w / 2, pts: Vec[] = [];
    for (const [x, y] of [[h, w], [h, 0], [h, -w], [0, -w], [-h, -w], [-h, 0], [-h, w], [0, w]]) pts.push({ x: this.x + x * c - y * s, y: this.y + x * s + y * c });
    pts.push(this.door());
    return pts;
  }

  // p inside the footprint grown by pad
  contains(p: Vec, pad = 0): boolean {
    const dx = p.x - this.x, dy = p.y - this.y, c = Math.cos(this.angle), s = Math.sin(this.angle);
    return Math.abs(dx * c + dy * s) <= this.h / 2 + pad && Math.abs(dy * c - dx * s) <= this.w / 2 + pad;
  }
}

// Footprint facing angle with its door at p (tier 1+: that tier's footprint)
export const buildingAt = (kind: Site, p: Vec, angle: number, tier = 0): Building => {
  const b = new Building(kind, 0, 0, angle);
  b.tier = tier;
  const d = b.h / 2 + DOOR_D;
  b.x = p.x - Math.cos(angle) * d;
  b.y = p.y - Math.sin(angle) * d;
  return b;
};
