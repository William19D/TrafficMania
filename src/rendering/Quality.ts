// Graphics quality. High: everything. Medium: fewer pedestrians, no birds. Low: the canvas backing store at 0.75 (CSS-scaled up),
// fewer pedestrians, no birds or cloud shadows, flat cars at every zoom. Auto steps between them on the measured frame rate.
export type Level = 'high' | 'medium' | 'low';
export type Quality = 'auto' | Level;
export const QUALITIES: Quality[] = ['auto', 'high', 'medium', 'low'];
const LEVELS: Level[] = ['high', 'medium', 'low'];
const KEY = 'tm_quality';

// Backing-store px per CSS px: the device ratio capped at 1.5 (a 4K laptop does not need 3x the fill), 0.75 of that on Low
export const pxRatio = (dpr: number, l: Level): number => Math.min(dpr || 1, 1.5) * (l === 'low' ? 0.75 : 1);

// ?quality= (bench and tests) over the saved choice over Auto
export function loadQuality(): Quality {
  const ok = (v: string | null): v is Quality => QUALITIES.includes(v as Quality);
  const u = new URLSearchParams(location.search).get('quality');
  if (ok(u)) return u;
  try { const s = localStorage.getItem(KEY); if (ok(s)) return s; } catch { /* storage blocked */ }
  return 'auto';
}
export function saveQuality(q: Quality): void { try { localStorage.setItem(KEY, q); } catch { /* storage blocked: this session only */ } }

// Auto: the frame rate over WIN ms windows. Under DOWN fps steps down a level; UP fps or more for `wait` windows in a row steps back
// up, and every step down doubles that wait (so a level that could not hold is not retried every few seconds). The window after a
// change is thrown away (resize and cache repaints), and so is any window with a stall (a zoom's repaint, a hidden tab).
// ponytail: a display or browser capped under 60 Hz reads as slow and ends on Low; read the refresh rate if that turns up
export class AutoQuality {
  static WIN = 2000; static DOWN = 52; static UP = 58;
  level: Level = 'high';
  fps = 0;
  private t0 = -1; private n = 0; private good = 0; private wait = 2; private settle = true; private last = -1;

  // a frame at time now (ms); true when the level changed
  frame(now: number, auto: boolean): boolean {
    const gap = this.last < 0 ? 0 : now - this.last;
    this.last = now;
    if (this.t0 < 0 || gap > 250) { this.t0 = now; this.n = 0; return false; }
    this.n++;
    if (now - this.t0 < AutoQuality.WIN) return false;
    this.fps = this.n * 1000 / (now - this.t0);
    this.t0 = now; this.n = 0;
    if (!auto || this.settle) { this.settle = false; return false; }
    const i = LEVELS.indexOf(this.level);
    if (this.fps < AutoQuality.DOWN && i < LEVELS.length - 1) { this.good = 0; this.wait = Math.min(64, this.wait * 2); return this.set(LEVELS[i + 1]); }
    this.good = this.fps >= AutoQuality.UP ? this.good + 1 : 0;
    if (this.good >= this.wait && i > 0) { this.good = 0; return this.set(LEVELS[i - 1]); }
    return false;
  }

  set(l: Level): boolean {
    const changed = l !== this.level;
    this.level = l;
    this.settle = true;
    return changed;
  }
}
