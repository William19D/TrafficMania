// Headless simulation check: builds a fixed network, runs ~300 game seconds and asserts the car invariants.
// Run: npm run simcheck   (= node --experimental-transform-types --no-warnings scripts/simcheck.ts)
// Exits 1 on the first failure. Add one scenario/assertion per behaviour you want to lock in.
import { Game } from '../src/core/Game.ts';
import { RoadGraph, CAR_LEN } from '../src/network/RoadGraph.ts';
import type { Node, RoadType } from '../src/network/RoadGraph.ts';
import { City } from '../src/entities/City.ts';
import { Car } from '../src/entities/Car.ts';

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
const blank = (): Game => {
  const w = new Game();
  w.terrain = { rivers: [], mountains: [], lakes: [], patches: [], trees: [] };
  w.graph = new RoadGraph();
  w.cities = [];
  w.tutorialActive = true;
  w.inventory = { asphalt: 9999, bridges: 0, tunnels: 0, lights: 5, roundabouts: 5 };
  return w;
};
const town = (w: Game, name: string, x: number, y: number): Node => {
  const c = new City(name, '#888', x, y, 3);
  w.cities.push(c);
  return w.graph.addNode(x, y, c);
};
const game = blank();
const g = game.graph;
const city = (name: string, x: number, y: number): Node => town(game, name, x, y);

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
let maxCars = 0;
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
      fail(`overlap on lane ${e.id}: gap ${(n.s - c.s - CAR_LEN).toFixed(2)} at t=${game.time.toFixed(2)}`);
    }
  }
  for (const n of g.nodes) for (const c of n.occupants) {
    if (!live.has(c) || !c.lane.cars.includes(c)) fail(`node ${n.id} holds a car off the graph at t=${game.time.toFixed(2)}`);
  }
}
if (game.score <= 0) fail('no car arrived');

// Deadlock: a parked car (not in game.cars, never moves) blocks the start of lane J->Y.
// 'a' waits at J, reroutes via K after REROUTE_S and arrives; 'c' is stuck behind it, gives up and goes home to Z.
{
  const w = blank(), wg = w.graph, flat: RoadType = { lanes: 1, oneWay: false };
  const X = town(w, 'X', 100, 500), Y = town(w, 'Y', 900, 500), Z = town(w, 'Z', 100, 900);
  const J = wg.addNode(500, 500), K = wg.addNode(700, 200);
  for (const [a, b] of [[X, J], [J, Y], [J, K], [K, Y]]) w.commitPath(w.planPath([a!, b!], 0, flat));
  for (const c of w.cities) c.demandTimer = Infinity;
  const lane = wg.lanesFrom(wg.edgeBetween(J, Y)!, J)[0]!;
  const parked = new Car(lane, Y.city!, Z.city!), c = new Car(lane, Y.city!, Z.city!);
  parked.s = 40;
  lane.cars.push(c, parked);
  w.cars.push(c);
  X.city!.pending.push(Y.city!);
  for (let t = 0; t < 40 * 60; t++) w.update(DT);
  if (w.score !== 1) fail(`deadlock: rerouted car did not arrive (score ${w.score})`);
  if (w.cars.includes(c) || lane.cars.includes(c) || !Z.city!.pending.includes(Y.city!)) fail('deadlock: stuck car not sent home');
}
// Lost: a car whose destination has no road at all goes back to its origin's queue instead of vanishing
{
  const w = blank(), flat: RoadType = { lanes: 1, oneWay: false };
  const X = town(w, 'X', 100, 500), Y = town(w, 'Y', 900, 500), J = w.graph.addNode(500, 500);
  w.commitPath(w.planPath([X, J], 0, flat));
  for (const c of w.cities) c.demandTimer = Infinity;
  const c = new Car(w.graph.lanesFrom(w.graph.edgeBetween(X, J)!, X)[0]!, Y.city!, X.city!);
  c.lane.cars.push(c);
  w.cars.push(c);
  w.update(DT);
  if (w.cars.includes(c) || c.lane.cars.includes(c) || !X.city!.pending.includes(Y.city!) || w.score) fail('lost car not sent home');
}
console.log(`SIMCHECK OK: t=${game.time.toFixed(0)}s score=${game.score} cars=${game.cars.length} maxCars=${maxCars} pending=${game.cities.reduce((n, c) => n + c.pending.length, 0)}`);
process.exit(0);
