// Live metrics over the whole run, sampled on the hour. waiting: cars stopped + trips waiting at a door; trip: mean in-game
// minutes of the hour's arrivals (the last value carries over an hour without any); through / failed: trips per hour.
export interface Sample { day: number; hour: number; waiting: number; trip: number; through: number; failed: number; money: number; pop: number; happy: number }
export type Snapshot = Pick<Sample, 'day' | 'hour' | 'waiting' | 'money' | 'pop' | 'happy'>;

// ponytail: past MAX samples every other one goes and the stride doubles, so a long run keeps its whole shape in bounded memory
const MAX = 240;

export class Metrics {
  samples: Sample[] = [];
  // in-game hours per sample
  every = 1;
  private n = 0;
  // the current hour so far
  private trips = 0;
  private mins = 0;
  private failed = 0;

  arrive(mins: number): void { this.trips++; this.mins += mins; }
  fail(): void { this.failed++; }

  add(s: Snapshot): void {
    if (this.n++ % this.every === 0) {
      const trip = this.trips ? this.mins / this.trips : this.samples[this.samples.length - 1]?.trip ?? 0;
      this.samples.push({ ...s, trip, through: this.trips, failed: this.failed });
      if (this.samples.length > MAX) { this.samples = this.samples.filter((_, i) => i % 2 === 0); this.every *= 2; }
    }
    this.trips = this.mins = this.failed = 0;
  }
}
