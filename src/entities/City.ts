import type { Node } from '../network/RoadGraph.ts';
import { random } from '../util/rng.ts';

export const CITY_R = 22, MAX_PENDING = 8, OVERCROWD_SECONDS = 25;

export class City {
  node!: Node;
  pending: City[] = [];
  overTimer = 0;
  demandTimer: number;
  retryTimer = 0;

  constructor(public name: string, public color: string, public x: number, public y: number, interval: number) {
    this.demandTimer = interval * (0.6 + random() * 0.8);
  }

  // 0..1 fraction of the "Overcrowded!" ring
  get overcrowd(): number {
    return Math.min(1, this.overTimer / OVERCROWD_SECONDS);
  }

  // Generates demand and updates the overcrowding timer. Returns true if Game Over was reached.
  tick(dt: number, cities: City[], interval: number): boolean {
    if (cities.length > 1) {
      this.demandTimer -= dt;
      if (this.demandTimer <= 0) {
        this.demandTimer = interval * (0.7 + random() * 0.6);
        if (this.pending.length < MAX_PENDING + 4) {
          const others = cities.filter(c => c !== this);
          this.pending.push(others[Math.floor(random() * others.length)]!);
        }
      }
    }
    if (this.pending.length >= MAX_PENDING) this.overTimer += dt;
    else this.overTimer = Math.max(0, this.overTimer - dt * 0.6);
    return this.overTimer >= OVERCROWD_SECONDS;
  }
}
