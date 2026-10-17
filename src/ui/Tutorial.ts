// Map 1's scripted tutorial (docs/design/game-v3.md 6): eight steps, each a goal with progress (region O lists them, the card in region F
// explains the current one), rings and off-screen arrows on its targets, auto-advance when done. Runs on a fresh Meadowbrook only.
import type { Game } from '../core/Game.ts';
import type { Vec } from '../util/geom.ts';
import { DEFAULT_TYPE } from '../network/RoadGraph.ts';
import { findPath } from '../network/Pathfinder.ts';
import type { Building } from '../entities/Building.ts';
import { FAILED } from '../entities/Trip.ts';
import { objLabel } from '../core/Campaign.ts';
import type { Zone } from '../core/config.ts';
import { profile, saveProfile } from '../core/Profile.ts';
import { icon } from './icons.ts';

// The script must never strand the player without money for its own tasks
const topUp = (g: Game): void => { if (g.tutorialActive) g.money = Math.max(20000, g.money); };

export interface Step {
  goal: string; // the checklist line and the card's title
  text: string;
  // [done, of]: a pure read (simcheck checks it changes nothing); none = press Next
  progress?: (g: Game) => [number, number];
  enter?: (g: Game) => void;
  targets?: (g: Game) => Vec[];
  hint?: string; // CSS selector of the HUD controls to pulse
}
export const stepDone = (s: Step, g: Game): boolean => { const p = s.progress?.(g); return !p || p[0] >= p[1]; };

const mid = (e: { a: Vec; b: Vec }): Vec => ({ x: (e.a.x + e.b.x) / 2, y: (e.a.y + e.b.y) / 2 });
// Middle of the longest road (not a driveway): where lots fit
const longest = (g: Game): Vec[] => { const e = g.graph.edges.filter(x => !x.drive && !x.exit).sort((a, b) => b.length - a.length)[0]; return e ? [mid(e)] : []; };
const roads = (g: Game) => g.graph.edges.filter(e => !e.drive && !e.exit);
export const worstHeat = (g: Game): number => roads(g).reduce((m, e) => Math.max(m, e.heat), 0);
const lotsOf = (g: Game, z: Zone): number => g.lots.filter(l => l.zone === z).length;
const grown = (g: Game, ...z: Zone[]): number => g.buildings.filter(b => b.lots.length && z.includes(b.kind as Zone)).length;
const reaches = (g: Game, h: Building, to?: Building): boolean => !!to && !!findPath(g.graph, h.node, to.node);
const min = Math.min;

// Built per start(): baselines come from the live town. The starter homes and office are found by position on each call, as an undo
// replaces every Building (and a demolished one drops out)
export function tutorialSteps(g: Game): Step[] {
  const at = (bs: Building[]) => new Set(bs.map(b => `${b.x},${b.y}`)), H = at(g.buildings.filter(b => b.kind === 'home'));
  const O = at(g.buildings.filter(b => b.kind === 'office').slice(0, 1));
  const homes = (g: Game) => g.buildings.filter(b => b.kind === 'home' && H.has(`${b.x},${b.y}`));
  const office = (g: Game) => g.buildings.find(b => b.kind === 'office' && O.has(`${b.x},${b.y}`));
  const centre = (g: Game): Vec[] => {
    const h = homes(g);
    return h.length ? [{ x: h.reduce((n, b) => n + b.node.x, 0) / h.length, y: h.reduce((n, b) => n + b.node.y, 0) / h.length }] : [];
  };
  const goal = g.map?.objectives[0];
  let homeLots = 0, houses = 0, shops = 0, offices = 0, jobs = 0;
  return [
    {
      goal: `Welcome to ${g.map?.name ?? 'your town'}`,
      text: 'People here need to get to work. You build the roads. Homes (white) send commuters to the office (purple) and shoppers to the shop (blue); the town grows where traffic flows. Time is paused while you read.',
      targets: centre,
    },
    {
      goal: 'Connect the homes to the office',
      text: 'Road tool (1): click a start point, click again for the end; hold the end and drag to bend. A road past a door gets a free driveway. The label shows the price, Esc cancels.',
      enter: g => { g.setTool('road'); topUp(g); }, targets: g => { const o = office(g); return [...centre(g), ...(o ? [o.node] : [])]; },
      progress: g => { const h = homes(g), o = office(g); return [h.filter(b => reaches(g, b, o)).length, h.length]; },
      hint: '.buildbtn, [data-tool="road"]',
    },
    {
      goal: 'Watch the first commutes (try 4x)',
      text: 'Commuters leave home between 6:00 and 10:00 and drive back after work. The fast-forward buttons at the top speed time up.',
      enter: g => { if (!g.speed) g.speed = 1; },
      progress: g => [min(3, g.reports.filter(r => r.purpose === 'commute' && !FAILED.includes(r.outcome)).length), 3],
      hint: '[data-speed="4"]',
    },
    {
      goal: 'Paint 8 Residential lots along a road',
      text: 'The town grows where you zone. With the brush (Z, or Build then Residential) drag along a road: lots appear on both sides (Shift: one side). A drag that starts on a lot of the same zone erases.',
      enter: g => { homeLots = lotsOf(g, 'home'); houses = grown(g, 'home'); g.setZone('home'); topUp(g); }, targets: longest,
      progress: g => [min(8, lotsOf(g, 'home') - homeLots), 8], hint: '.buildbtn, .bmenu [data-zone="home"]',
    },
    {
      goal: 'Watch the houses grow',
      text: 'A house grows on an empty lot while the R bar (top left) is up: people move in when there are jobs and shops they can reach. Growth runs 4x faster during the tutorial.',
      progress: g => [min(3, grown(g, 'home') - houses), 3], hint: '.res .dm[data-z="home"]',
    },
    {
      goal: 'Paint 2 Commercial and 2 Office lots',
      text: 'New residents need jobs and shops. Paint Commercial (blue) and Office (purple) lots along a road; one grows when its C or O bar is up.',
      enter: g => { shops = lotsOf(g, 'shop'); offices = lotsOf(g, 'office'); jobs = grown(g, 'shop', 'office'); g.setZone('shop'); topUp(g); },
      targets: longest,
      progress: g => [min(2, lotsOf(g, 'shop') - shops) + min(2, lotsOf(g, 'office') - offices) + min(1, grown(g, 'shop', 'office') - jobs), 5],
      hint: '.bmenu [data-zone="shop"], .bmenu [data-zone="office"], .res .dm[data-z="shop"], .res .dm[data-z="office"]',
    },
    {
      goal: 'Check the traffic',
      text: 'Press C (or the flame button) for the heat map: green roads flow, red ones are jammed. If one turns orange or red, give its traffic another way round, or more lanes.',
      targets: g => { const e = roads(g).sort((a, b) => b.heat - a.heat)[0]; return e && e.heat >= 0.4 ? [mid(e)] : []; },
      progress: g => [+(g.overlay === 'heat') + +(worstHeat(g) < 0.4), 2], hint: '[data-view="heat"]',
    },
    {
      goal: goal ? objLabel(goal) : 'Grow the town',
      text: 'That is the map\'s goal (top left), with ★★ for smooth trips and ★★★ for a small budget. Keep zoning homes, shops and offices where the bars are up, and keep traffic flowing. Tips show up here when something new happens; the bell lists what happened.',
      hint: '.res .obj',
    },
  ];
}

export class Tutorial {
  private card: HTMLElement;
  private next: HTMLButtonElement;
  steps: Step[] = [];
  index = 0;
  private shown = false;
  private lastLabel = '';
  private advanceAt = 0;

  // jump: eases the camera to a point
  constructor(private root: HTMLElement, private game: Game, private jump: (p: Vec) => void = () => {}) {
    this.card = document.createElement('div');
    this.card.className = 'panel tutorial';
    this.card.hidden = true;
    this.card.tabIndex = -1;
    this.card.setAttribute('role', 'dialog');
    this.card.setAttribute('aria-label', 'Tutorial');
    this.card.innerHTML = `
      <div class="tut-head"><span class="step num"></span><span class="bar"><i></i></span></div>
      <h3></h3>
      <p></p>
      <div class="actions">
        <button class="btn ghost skip">Skip tutorial</button>
        <button class="btn primary next"></button>
      </div>`;
    root.appendChild(this.card);
    this.next = this.card.querySelector('.next') as HTMLButtonElement;
    this.next.onclick = () => (this.index === this.steps.length - 1 ? this.finish() : this.show(this.index + 1));
    (this.card.querySelector('.skip') as HTMLButtonElement).onclick = () => this.finish();
    // Enter = Next while the card (not one of its buttons) has focus; Esc is left for cancelling a road
    this.card.addEventListener('keydown', e => {
      if (e.key === 'Enter' && e.target === this.card && !this.next.disabled) { e.preventDefault(); this.next.click(); }
    });
  }

  get active(): boolean { return this.shown; }

  // A fresh map 1: top-ups, growth x4, no events, milestones or grading until it ends; paused until the commute step
  start(): void {
    const g = this.game;
    this.steps = tutorialSteps(g);
    this.shown = true;
    g.tutorialActive = true;
    g.speed = 0;
    g.setRoadType(DEFAULT_TYPE);
    this.card.hidden = false;
    this.show(0);
  }

  update(): void {
    if (!this.shown) return;
    const s = this.steps[this.index], p = s.progress?.(this.game), done = stepDone(s, this.game);
    const last = this.index === this.steps.length - 1;
    // a step with a goal moves on by itself a moment after it is met
    if (p && done && !this.advanceAt) this.advanceAt = performance.now() + 1200;
    if (p && !done) this.advanceAt = 0;
    if (this.advanceAt && performance.now() >= this.advanceAt) { this.show(this.index + 1); return; }
    const label = !p ? (last ? 'Finish' : 'Next') : done ? 'Done!' : `${p[0]} / ${p[1]}`;
    if (label === this.lastLabel) return;
    this.lastLabel = label;
    this.next.disabled = !!p;
    this.next.classList.toggle('done', !!p && done);
    this.next.innerHTML = (p && done ? icon('check', 'ok') : '') + label;
  }

  private show(i: number): void {
    this.index = i;
    this.lastLabel = '';
    this.advanceAt = 0;
    const s = this.steps[i], n = this.steps.length;
    (this.card.querySelector('.step') as HTMLElement).textContent = `Step ${i + 1} of ${n}`;
    (this.card.querySelector('.bar i') as HTMLElement).style.width = `${(i / (n - 1)) * 100}%`;
    (this.card.querySelector('h3') as HTMLElement).textContent = s.goal;
    (this.card.querySelector('p') as HTMLElement).textContent = s.text;
    s.enter?.(this.game);
    const t = this.game.tutorialTargets = s.targets?.(this.game) ?? [];
    if (i === 0 && t[0]) this.jump(t[0]);
    this.clearHints();
    if (s.hint) this.root.querySelectorAll(s.hint).forEach(b => b.classList.add('hint'));
    this.update();
  }

  private clearHints(): void {
    this.root.querySelectorAll('.hint').forEach(b => b.classList.remove('hint'));
  }

  // Skip or Finish: the map plays on with its objectives; the script counts as seen
  private finish(): void {
    if (!this.game.speed) this.game.speed = 1;
    this.shown = false;
    this.game.tutorialActive = false;
    this.game.tutorialTargets = [];
    this.card.hidden = true;
    this.clearHints();
    const p = profile();
    if (!p.tips.includes('tutorial')) { p.tips.push('tutorial'); saveProfile(); }
  }
}
