// Sim-only benchmark on the bench city: npm run simbench [-- --secs 60]. Restores scripts/fixtures/bench-city.json, pre-rolls 45 game
// seconds like `npm run bench`, then times `secs` more at the 1/60 s step. Prints ms per step, ms per 4x frame (4 steps) and a state
// fingerprint: it must not change for a pure optimization.
import { deserialize } from '../src/core/Save.ts';
import { hashSeed, setSeed } from '../src/util/rng.ts';

declare const process: { argv: string[]; getBuiltinModule(m: 'node:fs'): { readFileSync(u: URL, enc: 'utf8'): string } };
const fs = process.getBuiltinModule('node:fs');
const SECS = Number(process.argv[process.argv.indexOf('--secs') + 1]) || 60;
const g = deserialize(fs.readFileSync(new URL('./fixtures/bench-city.json', import.meta.url), 'utf8'));
setSeed(hashSeed('bench'));
for (let i = 0; i < 60 * 45; i++) g.update(1 / 60);
const n = 60 * SECS, t0 = performance.now();
for (let i = 0; i < n; i++) g.update(1 / 60);
const ms = (performance.now() - t0) / n;
const fp = g.cars.reduce((h, c) => h + c.s * 1.37 + c.speed + c.lane.edge.id * 0.01, 0);
console.log(`simbench: ${SECS}s at 1/60, ${g.cars.length} cars, ${ms.toFixed(3)} ms/step, ${(4 * ms).toFixed(2)} ms per 4x frame`);
console.log(`fingerprint: score=${g.score} cars=${g.cars.length} money=${g.money} sum=${fp}`);
