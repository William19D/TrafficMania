import type { Game } from '../core/Game.ts';
import type { Vec } from '../util/geom.ts';
import { DEFAULT_TYPE } from '../network/RoadGraph.ts';
import { findPath } from '../network/Pathfinder.ts';
import type { Building } from '../entities/Building.ts';
import { FAILED } from '../entities/Trip.ts';
import { icon } from './icons.ts';

// The tutorial must never strand the player without money for its own tasks.
const topUp = (g: Game, money = 20000): void => { g.money = Math.max(money, g.money); };

interface Step {
  title: string;
  task: string;
  text?: string;
  done?: (g: Game) => boolean;
  enter?: (g: Game) => void;
  targets?: (g: Game) => Vec[];
  hint?: string; // CSS selector of the HUD control to pulse
}

const at = (p: Vec): Vec => ({ x: p.x, y: p.y });
// Junctions of real roads (driveways make T-junctions of their own)
const junctions = (g: Game) => g.graph.nodes.filter(n => !n.building && n.edges.filter(e => !e.drive).length >= 3);

// Built per start(): targets come from the live town (any zone the map could not place falls back to the first building)
function steps(g: Game): Step[] {
  const homes = g.buildings.filter(b => b.kind === 'home');
  const office = g.buildings.find(b => b.kind === 'office') ?? g.buildings[0];
  const shop = g.buildings.find(b => b.kind === 'shop') ?? g.buildings[0];
  const door = (b?: Building): Vec[] => b ? [at(b.node)] : [];
  let placed = 0; // homes on the map when the placing step starts
  const mid = homes.length ? [{ x: homes.reduce((n, b) => n + b.node.x, 0) / homes.length, y: homes.reduce((n, b) => n + b.node.y, 0) / homes.length }] : [];
  return [
    {
      title: 'Welcome!', task: 'Press Next to start.',
      text: 'Homes (white) send commuters to work in the morning and shoppers to the shops (blue) during the day. Factories (ochre) with workers send trucks with goods. Car colours show the trip. Build the roads that get them there. Time is paused while you read and build.',
    },
    {
      title: 'Build your first road', task: 'Draw a road between the homes, then on to the office door.',
      text: 'Click = start point, click again = end point. A building next to a road gets a free driveway. The label shows the price. Esc cancels.',
      enter: g => { g.tool = 'road'; topUp(g); }, targets: () => [...mid, ...door(office)],
      done: g => office && homes.length ? homes.some(h => !!findPath(g.graph, h.node, office.node)) : g.graph.edges.length >= 1,
      hint: '[data-tool="road"]',
    },
    {
      title: 'Watch the commute', task: 'Wait for the first commuter to reach work.',
      text: 'Commuters leave home between 6:00 and 10:00 and drive back after a 9-hour shift. Residents pay taxes, more when they are happy, and every worker, shopper and truck of goods that arrives pays business income. Press 4x to speed up.',
      // the clock starts again here (start() paused it), so the morning rush is still ahead
      enter: g => { if (!g.speed) g.speed = 1; },
      done: g => g.reports.some(r => r.purpose === 'commute' && !FAILED.includes(r.outcome)),
      hint: '[data-speed="4"]',
    },
    {
      title: 'Make an intersection', task: 'Build a road from the shop door to the middle of one of your roads.',
      text: 'Three or more roads meeting = intersection. Cars take turns there.',
      enter: g => { g.tool = 'road'; topUp(g); },
      targets: g => {
        const e = g.graph.edges.find(x => !x.drive);
        return e ? [...door(shop), { x: (e.a.x + e.b.x) / 2, y: (e.a.y + e.b.y) / 2 }] : door(shop);
      },
      done: g => junctions(g).length > 0,
    },
    {
      title: 'Add a traffic light', task: 'Press 2, then click the intersection.',
      text: 'Lights alternate green between the two axes. Roundabouts (3, from level 2) let 3 cars through at once.',
      enter: g => topUp(g),
      targets: g => junctions(g).map(at),
      done: g => g.graph.nodes.some(n => n.control !== 'none'), hint: '[data-tool="light"]',
    },
    {
      title: 'Bend a road', task: 'Click a start point, then press and HOLD on the end point and drag to bend it. Release to build.',
      text: 'Roads also curve on their own when they join an existing road.',
      // ponytail: clearing lastBuild on enter means only a build made in this step counts
      enter: g => { g.tool = 'road'; g.lastBuild = null; topUp(g); },
      done: g => g.lastBuild !== null && g.lastBuild.segs >= 3, hint: '[data-tool="road"]',
    },
    {
      title: 'Grow the city', task: 'Press B (or Buildings), then click beside a road to place a home.',
      text: 'New buildings wait in the tray. Near a road the building turns to face it and gets a free driveway. Keep homes away from factories and busy roads. R turns a building that stands free.',
      // the tray always holds a home for this step
      enter: g => { placed = g.buildings.filter(b => b.kind === 'home').length; g.tray.home = Math.max(1, g.tray.home); },
      done: g => g.buildings.filter(b => b.kind === 'home').length > placed, hint: '[data-tool="place"]',
    },
    {
      title: 'You are ready', task: 'Press Finish and keep the traffic flowing!',
      text: 'Homes fill up while they are happy: jobs and shops in reach, smooth trips, no factory or loud road next door. Stay out of debt and keep the residents happy, or the game ends. Each new level brings buildings to place and unlocks road tiers, roundabouts, viaducts and tunnels. Edit (4) changes lanes or bends a road; Demolish (5) refunds all of a road built today, half of an older one. Roads cost upkeep every day.',
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
    this.steps = steps(this.game);
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
    if (s.hint) this.root.querySelector(s.hint)?.classList.add('hint');
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
