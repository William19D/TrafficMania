import type { Game } from '../core/Game.ts';
import type { Vec } from '../util/geom.ts';
import { DEFAULT_TYPE } from '../network/RoadGraph.ts';
import { LIGHT_PERIOD } from '../network/Junction.ts';
import { TUNING as T } from '../core/config.ts';
import { findPath } from '../network/Pathfinder.ts';
import type { Building } from '../entities/Building.ts';
import { FAILED } from '../entities/Trip.ts';
import { icon } from './icons.ts';

// The tutorial must never strand the player without money for its own tasks.
const topUp = (g: Game, money = 20000): void => { g.money = Math.max(money, g.money); };

export interface Step {
  title: string;
  task: string;
  text?: string;
  // a pure read of the game (simcheck checks it changes nothing)
  done?: (g: Game) => boolean;
  enter?: (g: Game) => void;
  targets?: (g: Game) => Vec[];
  hint?: string; // CSS selector of the HUD controls to pulse
}

const at = (p: Vec): Vec => ({ x: p.x, y: p.y });
// Middle of the longest road (not a driveway), where a new road makes a clear junction
const mid = (g: Game): Vec[] => {
  const e = g.graph.edges.filter(x => !x.drive).sort((a, b) => b.length - a.length)[0];
  return e ? [{ x: (e.a.x + e.b.x) / 2, y: (e.a.y + e.b.y) / 2 }] : [];
};
// Junctions of real roads (driveways make T-junctions of their own)
const junctions = (g: Game) => g.graph.nodes.filter(n => !n.building && n.edges.filter(e => !e.drive).length >= 3);
const lights = (g: Game) => g.graph.nodes.filter(n => n.control === 'light');
const reaches = (g: Game, from: Building[], to?: Building): boolean => !!to && from.some(h => !!findPath(g.graph, h.node, to.node));

// Built per start(): targets come from the live town (any zone the map could not place falls back to the first building)
export function tutorialSteps(g: Game): Step[] {
  const homes = g.buildings.filter(b => b.kind === 'home');
  const office = g.buildings.find(b => b.kind === 'office') ?? g.buildings[0];
  const shop = g.buildings.find(b => b.kind === 'shop') ?? g.buildings[0];
  const door = (b?: Building): Vec[] => b ? [at(b.node)] : [];
  let placed = homes.length; // homes on the map when the placing step starts
  const centre = homes.length ? [{ x: homes.reduce((n, b) => n + b.node.x, 0) / homes.length, y: homes.reduce((n, b) => n + b.node.y, 0) / homes.length }] : [];
  return [
    {
      title: 'Welcome to TrafficMania', task: 'Press Next to start.',
      text: 'Homes (white) send commuters to offices (purple), shops (blue) and factories (ochre), and shoppers to the shops. Factories with workers send trucks of goods. You build the roads and fix the jams; taxes pay for it. Time is paused while you read and build.',
    },
    {
      title: 'Connect the homes', task: 'Draw a road past the homes, then on to the office door.',
      text: 'Click = start point, click again = end point; hold the end point and drag to bend. A building next to a road gets a free driveway. The label shows the price. Esc cancels.',
      enter: g => { g.setTool('road'); topUp(g); }, targets: () => [...centre, ...door(office)],
      done: g => homes.length ? reaches(g, homes, office) : g.graph.edges.length >= 1,
      hint: '[data-tool="road"]',
    },
    {
      title: 'Watch the commute', task: 'Wait for the first commuter to reach work.',
      text: `Commuters leave home between 6:00 and 10:00 and drive back after a ${T.WORK_HOURS}-hour shift. Car colours show the trip. Press 4x to speed up.`,
      // the clock starts again here (start() paused it), so the morning rush is still ahead
      enter: g => { if (!g.speed) g.speed = 1; },
      done: g => g.reports.some(r => r.purpose === 'commute' && !FAILED.includes(r.outcome)),
      hint: '[data-speed="4"]',
    },
    {
      title: 'Place new buildings', task: 'Press B (or Buildings), then click beside a road to place a home.',
      text: 'Every level brings a batch of buildings to place; they wait in the tray. Near a road a building turns to face it and gets a free driveway. Keep homes away from factories and busy roads. R turns a building that stands free.',
      // the tray always holds a home for this step
      enter: g => { placed = g.buildings.filter(b => b.kind === 'home').length; g.tray.home = Math.max(1, g.tray.home); },
      done: g => g.buildings.filter(b => b.kind === 'home').length > placed, hint: '[data-tool="place"], .tray',
    },
    {
      title: 'Open the shop', task: 'Build a road from the shop door to the middle of one of your roads.',
      text: 'Shoppers drive out from mid-morning to the evening. Press T for the trip reports: each resident says how the trip went (smooth, a long wait, a detour). Click a line to look.',
      enter: g => { g.setTool('road'); topUp(g); },
      targets: g => [...door(shop), ...mid(g)],
      done: g => reaches(g, homes, shop), hint: '[data-view="feed"]',
    },
    {
      title: 'Add a traffic light', task: 'Press 3 (Light), then click an intersection.',
      text: 'Three or more roads meeting make an intersection; if you have none, draw a road into the middle of one. Without a control cars take turns one at a time.',
      enter: g => topUp(g),
      targets: g => junctions(g).length ? junctions(g).map(at) : mid(g),
      done: g => lights(g).length > 0, hint: '[data-tool="light"]',
    },
    {
      title: 'Time the light', task: 'Press 6 (Edit), click the light, then press + on a phase.',
      text: 'The junction panel sets the control (yield, stop, light or roundabout), the light phases, protected lefts and turn bans. Give the busier road the longer green. In a career game the phase editor unlocks at level 4.',
      targets: g => lights(g).map(at),
      done: g => lights(g).some(n => !!n.plan?.phases.some(p => p.seconds > LIGHT_PERIOD)), hint: '[data-tool="edit"]',
    },
    {
      title: 'Find the jams', task: 'Press C (or the flame button) for the heat map.',
      text: 'Green roads flow, red ones are jammed, and discs show cars waiting at junctions. Fix the red: more lanes, a faster tier, a better light plan, a roundabout or an overpass. M opens the charts of the whole run.',
      done: g => g.overlay === 'heat', hint: '[data-view="heat"]',
    },
    {
      title: 'Money and levels', task: 'Press Finish and keep the traffic flowing!',
      text: 'The money chip shows your balance and the net per day: taxes from residents (more when they are happy) and business income, minus road upkeep. Demolish refunds a road built today in full, an older one by half. The people chip shows the next level: it brings new buildings and unlocks road tiers and tools. Go bankrupt or let happiness collapse and the game ends.',
      hint: '.chip.money, .chip.people',
    },
  ];
}

export class Tutorial {
  private card: HTMLElement;
  private next: HTMLButtonElement;
  private task: HTMLElement;
  private steps: Step[] = [];
  private index = 0;
  private shown = false;
  private lastLabel = '';

  constructor(private root: HTMLElement, private game: Game) {
    this.card = document.createElement('div');
    this.card.className = 'panel tutorial';
    this.card.hidden = true;
    this.card.tabIndex = -1;
    this.card.setAttribute('role', 'dialog');
    this.card.setAttribute('aria-label', 'Tutorial');
    this.card.innerHTML = `
      <div class="tut-head"><span class="step num"></span><span class="bar"><i></i></span></div>
      <h3></h3>
      <div class="task" aria-live="polite"></div>
      <p></p>
      <div class="actions">
        <button class="btn ghost skip">Skip</button>
        <button class="btn primary next"></button>
      </div>`;
    root.appendChild(this.card);
    this.task = this.card.querySelector('.task') as HTMLElement;
    this.next = this.card.querySelector('.next') as HTMLButtonElement;
    this.next.onclick = () => (this.index === this.steps.length - 1 ? this.finish() : this.show(this.index + 1));
    (this.card.querySelector('.skip') as HTMLButtonElement).onclick = () => this.finish();
    // Enter = Next while the card (not one of its buttons) has focus; Esc is left for cancelling a road
    this.card.addEventListener('keydown', e => {
      if (e.key === 'Enter' && e.target === this.card && !this.next.disabled) { e.preventDefault(); this.next.click(); }
    });
  }

  get active(): boolean { return this.shown; }

  start(): void {
    this.steps = tutorialSteps(this.game);
    this.shown = true;
    this.game.tutorialActive = true;
    // paused until the 'Watch the commute' step, so the first morning is not over before the first road
    this.game.speed = 0;
    this.game.setRoadType(DEFAULT_TYPE); // the tutorial's own tasks assume a default two-way street
    this.card.hidden = false;
    this.show(0);
  }

  update(): void {
    if (!this.shown) return;
    const s = this.steps[this.index];
    const ready = !s.done || s.done(this.game);
    const last = this.index === this.steps.length - 1;
    const label = !ready ? 'wait' : last ? 'Finish' : 'Next';
    if (label === this.lastLabel) return;
    this.lastLabel = label;
    this.next.disabled = !ready;
    this.next.textContent = ready ? label : 'Do it to continue';
    const done = !!s.done && ready;
    this.task.classList.toggle('done', done);
    this.task.innerHTML = (done ? icon('check') : '') + `<span>${esc(s.task)}</span>`;
  }

  private show(i: number): void {
    this.index = i;
    this.lastLabel = '';
    const s = this.steps[i];
    const n = this.steps.length;
    (this.card.querySelector('.step') as HTMLElement).textContent = `${i + 1} / ${n}`;
    (this.card.querySelector('.bar i') as HTMLElement).style.width = `${((i + 1) / n) * 100}%`;
    (this.card.querySelector('h3') as HTMLElement).textContent = s.title;
    const p = this.card.querySelector('p') as HTMLElement;
    p.textContent = s.text ?? '';
    p.hidden = !s.text;
    s.enter?.(this.game);
    this.game.tutorialTargets = s.targets?.(this.game) ?? [];
    this.clearHints();
    if (s.hint) this.root.querySelectorAll(s.hint).forEach(b => b.classList.add('hint'));
    this.update();
  }

  private clearHints(): void {
    this.root.querySelectorAll('.hint').forEach(b => b.classList.remove('hint'));
  }

  private finish(): void {
    // start() paused the clock; a skip before the commute step would leave it paused
    if (!this.game.speed) this.game.speed = 1;
    this.shown = false;
    this.game.tutorialActive = false;
    this.game.tutorialTargets = [];
    this.card.hidden = true;
    this.clearHints();
    try { localStorage.setItem('tm_tutorial_done', '1'); } catch { /* storage blocked: tutorial will show again next load */ }
  }
}

const esc = (s: string) => s.replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`);
