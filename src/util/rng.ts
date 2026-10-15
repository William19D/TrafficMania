// Seeded randomness: every gameplay roll goes through random(), so a seed replays a run
export function mulberry32(n: number): () => number {
  let s = n | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// FNV-1a
export function hashSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

let stream = mulberry32(1);
export const setSeed = (n: number): void => { stream = mulberry32(n); };
export const random = (): number => stream();
