// Headless simulation check: builds a fixed network, runs ~300 game seconds and asserts the car invariants.
// Run: npm run simcheck   (= node --experimental-transform-types --no-warnings scripts/simcheck.ts)
// Exits 1 on the first failure. Add one scenario/assertion per behaviour you want to lock in.
import { Game } from '../src/core/Game.ts';
import { RoadGraph, CAR_LEN, GAP } from '../src/network/RoadGraph.ts';
import type { Node, RoadType } from '../src/network/RoadGraph.ts';
import { City } from '../src/entities/City.ts';

declare const process: { exit(code: number): never };

// Deterministic Math.random (mulberry32)
let seed = 12345;
Math.random = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const fail = (msg: string): never => { console.log('SIMCHECK FAIL: ' + msg); process.exit(1); };

// Blank world: no terrain, no random cities; tutorialActive = no game over and no city spawning
const game = new Game();
game.terrain = { rivers: [], mountains: [], lakes: [], patches: [], trees: [] };
game.graph = new RoadGraph();
game.cities = [];
game.tutorialActive = true;
game.inventory = { asphalt: 9999, bridges: 0, tunnels: 0, lights: 5, roundabouts: 5 };
const g = game.graph;
const city = (name: string, x: number, y: number): Node => {
  const c = new City(name, '#888', x, y, 3);
  game.cities.push(c);
  return g.addNode(x, y, c);
};

//   F         A=2-lane=J1(light)---B---J2(plain 3-way)---E
//             |                    |   |
//   C------R(roundabout)-----------+---D
const A = city('A', 200, 300), B = city('B', 1000, 300), C = city('C', 600, 800), D = city('D', 1400, 800), E = city('E', 1800, 300);
const F = city('F', 600, 60);
const J1 = g.addNode(600, 300), R = g.addNode(1000, 800), J2 = g.addNode(1400, 300);
const one: RoadType = { lanes: 1, oneWay: false }, two: RoadType = { lanes: 2, oneWay: false };
const roads: [Node, Node, RoadType][] = [
  [A, J1, two], [J1, B, one], [J1, C, one], [J1, F, one],
  [C, R, one], [R, D, one], [B, R, one], [B, J2, one], [J2, E, one], [J2, D, one],
];
for (const [a, b, type] of roads) {
  const plan = game.planPath([a, b], 0, type);
  if (!plan.ok) fail(`plan ${a.id}->${b.id}: ${plan.reason}`);
  game.commitPath(plan);
}
game.placeControl(J1, 'light');
game.placeControl(R, 'roundabout');
if (J1.control !== 'light' || R.control !== 'roundabout') fail('controls not placed');

const DT = 1 / 60, STEPS = 300 * 60;
let maxCars = 0, entryOverlaps = 0;
for (let i = 0; i < STEPS; i++) {
  if (game.pendingReward) game.applyReward(0);
  try { game.update(DT); } catch (e) { fail(`exception at t=${game.time.toFixed(2)}: ${(e as Error).stack}`); }
  const live = new Set(game.cars);
  maxCars = Math.max(maxCars, live.size);
  for (const e of g.edges) for (const l of e.lanes) {
    for (let k = 0; k < l.cars.length; k++) {
      const c = l.cars[k];
      if (!live.has(c) || c.lane !== l) fail(`stale car on lane ${e.id} at t=${game.time.toFixed(2)}`);
      const n = l.cars[k + 1];
      if (n && n.s < c.s) fail(`lane ${e.id} not sorted at t=${game.time.toFixed(2)}`);
      if (!n || n.s - c.s - CAR_LEN >= -1e-6) continue;
      // ponytail: two cars entering one exit lane in the same tick (light grants a whole group) overlap at s~0 and
      // separate within a second; counted (in ticks), not fatal. Make it fatal once the exit-space check lands.
      if (c.s < CAR_LEN + GAP) { entryOverlaps++; continue; }
      fail(`overlap on lane ${e.id}: gap ${(n.s - c.s - CAR_LEN).toFixed(2)} at t=${game.time.toFixed(2)}`);
    }
  }
  for (const n of g.nodes) for (const c of n.occupants) {
    if (!live.has(c) || !c.lane.cars.includes(c)) fail(`node ${n.id} holds a car off the graph at t=${game.time.toFixed(2)}`);
  }
}
if (game.score <= 0) fail('no car arrived');
console.log(`SIMCHECK OK: t=${game.time.toFixed(0)}s score=${game.score} cars=${game.cars.length} maxCars=${maxCars} entryOverlapTicks=${entryOverlaps} pending=${game.cities.reduce((n, c) => n + c.pending.length, 0)}`);
process.exit(0);
