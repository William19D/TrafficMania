import type { Game } from '../core/Game.ts';
import type { Vec } from '../util/geom.ts';
import { icon } from './icons.ts';

// The tutorial must never strand the player without material for its own tasks.
const topUp = (g: Game, asphalt: number): void => { g.inventory.asphalt = Math.max(asphalt, g.inventory.asphalt); };

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
const junctions = (g: Game) => g.graph.nodes.filter(n => !n.city && n.edges.length >= 3);

// Built per start(): city names come from the live map
function steps(g: Game): Step[] {
  const [A, B, C] = g.cities;
  return [
    { title: 'Welcome!', task: 'Press Next to start.', text: 'Colored squares are cities. Cars drive to the city of their color. Keep them moving.' },
    {
      title: 'Build your first road', task: `Click ${A.name}, then click ${B.name}.`,
      text: 'Click = start point, click again = end point. Esc cancels.',
      enter: g => { g.tool = 'road'; topUp(g, 40); }, targets: () => [at(A), at(B)],
      done: g => g.graph.edges.length >= 1, hint: '[data-tool="road"]',
    },
    {
      title: 'Watch the cars', task: 'Wait for the first trip to complete.',
      text: 'Each car that reaches its destination is 1 trip. Press 4x to speed up.',
      done: g => g.score >= 1, hint: '[data-speed="4"]',
    },
    {
      title: 'Make an intersection', task: `Build a road from ${C.name} to the middle of your first road.`,
      text: 'Three or more roads meeting = intersection. Cars take turns there.',
      enter: g => { g.tool = 'road'; topUp(g, 30); },
      targets: g => {
        const e = g.graph.edges[0];
        return e ? [at(C), { x: (e.a.x + e.b.x) / 2, y: (e.a.y + e.b.y) / 2 }] : [at(C)];
      },
      done: g => junctions(g).length > 0,
    },
    {
      title: 'Add a traffic light', task: 'Press 2, then click the intersection.',
      text: 'Lights alternate green between the two axes. Roundabouts (3) let 3 cars through at once.',
      enter: g => { g.inventory.lights = Math.max(1, g.inventory.lights); },
      targets: g => junctions(g).map(at),
      done: g => g.graph.nodes.some(n => n.control !== 'none'), hint: '[data-tool="light"]',
    },
    {
      title: 'Bend a road', task: 'Click a start point, then press and HOLD on the end point and drag to bend it. Release to build.',
      text: 'Roads also curve on their own when they join an existing road.',
      // ponytail: clearing lastBuild on enter means only a build made in this step counts
      enter: g => { g.tool = 'road'; g.lastBuild = null; topUp(g, 20); },
      done: g => g.lastBuild !== null && g.lastBuild.segs >= 3, hint: '[data-tool="road"]',
    },
    {
      title: 'Go up: viaducts', task: 'Press + (or PageUp) to set L1, then build a road over water or over another road.',
      text: 'Viaducts cost 1 bridge and never create intersections with lower roads. L6+ clears mountains. Ground roads through mountains dig tunnels.',
      enter: g => { g.inventory.bridges = Math.max(1, g.inventory.bridges); g.lastBuild = null; topUp(g, 20); },
      done: g => g.lastBuild !== null && g.lastBuild.level >= 1, hint: '[data-action="level-up"]',
    },
    {
      title: 'You are ready', task: 'Press Finish and keep the traffic flowing!',
      text: 'Demolish (4) refunds materials. A red ring around a city means overcrowding: if it fills, game over. Every week you pick a reward.',
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
    this.shown = false;
    this.game.tutorialActive = false;
    this.game.tutorialTargets = [];
    this.card.hidden = true;
    this.clearHints();
    try { localStorage.setItem('tm_tutorial_done', '1'); } catch { /* storage blocked: tutorial will show again next load */ }
  }
}

const esc = (s: string) => s.replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`);
