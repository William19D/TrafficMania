import type { Game, Tool, Reward, Inventory } from '../core/Game.ts';
import { DAY_SECONDS } from '../core/Game.ts';
import { icon } from './icons.ts';

type ResKey = 'asphalt' | 'bridges' | 'tunnels';
const RES: { k: ResKey; icon: string; tip: string }[] = [
  { k: 'asphalt', icon: 'asphalt', tip: 'Asphalt: 1 per road tile. Demolish refunds it.' },
  { k: 'bridges', icon: 'bridge', tip: 'Bridges: 1 per water crossing or viaduct.' },
  { k: 'tunnels', icon: 'tunnel', tip: 'Tunnels: 1 per ground road through a mountain.' },
];

const TOOLS: { tool: Tool; label: string; key: string; tip: string }[] = [
  { tool: 'road', label: 'Road', key: '1', tip: 'Click start, click end. Drag the end to bend. Esc cancels.' },
  { tool: 'light', label: 'Light', key: '2', tip: 'Click an intersection (3+ roads). Uses 1 light.' },
  { tool: 'roundabout', label: 'Roundabout', key: '3', tip: 'Click an intersection. Lets 3 cars through at once. Uses 1.' },
  { tool: 'demolish', label: 'Demolish', key: '4', tip: 'Click a road or a light/roundabout to remove it and get a refund.' },
];

const SPEEDS: { s: 0 | 1 | 2 | 4; icon: string; lbl: string; tip: string; key?: string }[] = [
  { s: 0, icon: 'pause', lbl: 'II', tip: 'Pause', key: 'Space' },
  { s: 1, icon: 'play', lbl: '1x', tip: 'Normal speed' },
  { s: 2, icon: 'fast', lbl: '2x', tip: 'Fast' },
  { s: 4, icon: 'faster', lbl: '4x', tip: 'Fastest' },
];

// [singular, plural, icon]
const NOUN: Record<keyof Inventory, [string, string, string]> = {
  asphalt: ['asphalt', 'asphalt', 'asphalt'],
  bridges: ['bridge', 'bridges', 'bridge'],
  tunnels: ['tunnel', 'tunnels', 'tunnel'],
  lights: ['traffic light', 'traffic lights', 'light'],
  roundabouts: ['roundabout', 'roundabouts', 'roundabout'],
};

// Game messages rewritten to say what to do
const FRIENDLY: Record<string, string> = {
  'Not enough asphalt': 'Not enough asphalt: demolish a road or wait for the weekly reward',
  'Not enough bridges': 'Not enough bridges: lower the road to Ground (L0) or demolish a bridge',
  'Not enough tunnels': 'Not enough tunnels: raise the road to L6+ to pass over the mountain',
  'Too low for the mountain': 'Too low: raise to L6+ or use Ground (L0) to dig a tunnel',
  'Already exists': 'That road already exists: start or end somewhere new',
  'Invalid terrain': 'Roads cannot start or end in water or on a mountain',
  'Place on an intersection': 'Click a junction where 3 or more roads meet',
  'No traffic lights left': 'No traffic lights left: earn more in the weekly reward',
  'No roundabouts left': 'No roundabouts left: earn more in the weekly reward',
};
const ERROR_RE = /^(Not enough|Too low|Invalid|Already|Place on|No .* left)/;

const CONTROLS: [string, string][] = [
  ['Road / Light / Roundabout / Demolish', '<kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> <kbd>4</kbd>'],
  ['Place road', 'click start, click end'],
  ['Bend road', 'hold on the end point and drag'],
  ['Cancel road', '<kbd>Esc</kbd> or right-click'],
  ['Raise / lower road', '<kbd>PageUp</kbd> / <kbd>PageDown</kbd> or <kbd>+</kbd> / <kbd>-</kbd>'],
  ['Pause / resume', '<kbd>Space</kbd>'],
  ['Zoom / pan', 'wheel / right- or middle-drag'],
  ['Reward choice', '<kbd>1</kbd> / <kbd>2</kbd>, then <kbd>Enter</kbd>'],
  ['Help', '<kbd>?</kbd>'],
];

const ROAD_TIP = 'Road elevation: Ground or viaduct L1-L10';

const esc = (s: string) => s.replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`);

// Restart a CSS animation class
function flash(el: Element, cls: string, others: string[] = []): void {
  el.classList.remove(cls, ...others);
  void (el as HTMLElement).offsetWidth;
  el.classList.add(cls);
}

function rewardRows(r: Reward): string {
  return (Object.keys(r) as (keyof Inventory)[])
    .filter(k => (r[k] ?? 0) > 0)
    .map(k => {
      const n = r[k]!;
      return `<span class="row">${icon(NOUN[k][2], 'big')}<b class="num">+${n}</b><span>${NOUN[k][n === 1 ? 0 : 1]}</span></span>`;
    })
    .join('');
}

function toolBtn(t: (typeof TOOLS)[number]): string {
  const stock = t.tool === 'light' || t.tool === 'roundabout' ? '<span class="stock num"></span>' : '';
  return `<button class="tool${t.tool === 'demolish' ? ' destroy' : ''}" data-tool="${t.tool}" aria-pressed="false" data-tip="${t.tip}" data-key="${t.key}">`
    + `<span class="kb" aria-hidden="true">${t.key}</span>${icon(t.tool)}<span class="lbl">${t.label}</span>${stock}</button>`;
}

interface Toast { text: string; el: HTMLElement; n: number; timer: ReturnType<typeof setTimeout> }

export class HUD {
  private chips = {} as Record<ResKey, HTMLElement>;
  private toolBtns: HTMLButtonElement[];
  private speedBtns: HTMLButtonElement[];
  private dots: HTMLElement[];
  private tip: HTMLElement;
  private tipFor: HTMLElement | null = null;
  private tipTimer: ReturnType<typeof setTimeout> | undefined;
  private toasts: Toast[] = [];
  private sel = 0;
  private helpOpen = false;
  private last: {
    inv: Partial<Inventory>; score?: number; speed?: number; tool?: Tool; level?: number;
    week?: number; day?: number; dayFrac?: number; msg: string; danger?: number;
    reward: Reward[] | null; over: boolean;
  } = { inv: {}, msg: '', reward: null, over: false };
  onTutorial: (() => void) | null = null;

  constructor(private root: HTMLElement, private game: Game) {
    root.innerHTML = `
      <div class="panel res" role="group" aria-label="Resources">
        ${RES.map(r => `<div class="chip" data-res="${r.k}" data-tip="${r.tip}" tabindex="0">${icon(r.icon)}<b class="num"></b><span class="delta" aria-hidden="true"></span></div>`).join('')}
        <div class="chip danger" hidden tabindex="0" data-tip="A city has too many waiting cars. Connect it or add capacity before its ring fills.">${icon('warning')}<b><span class="long">Overcrowding </span><span class="pct num"></span></b></div>
      </div>
      <div class="panel status">
        <div class="seg" role="group" aria-label="Game speed">
          ${SPEEDS.map(s => `<button class="speed" data-speed="${s.s}" aria-pressed="false" aria-label="${s.tip}" data-tip="${s.tip}"${s.key ? ` data-key="${s.key}"` : ''}>${icon(s.icon)}<small>${s.lbl}</small></button>`).join('')}
        </div>
        <span class="sep"></span>
        <div class="trips" tabindex="0" data-tip="Trips completed: cars that reached their destination.">${icon('car')}<b class="score num">0</b></div>
        <span class="sep"></span>
        <div class="week" tabindex="0" data-tip="">
          <span class="wk"></span>
          <span class="dots">${'<i></i>'.repeat(7)}</span>
          ${icon('gift')}
        </div>
      </div>
      <button class="panel helpbtn" data-action="help" aria-label="Controls" aria-expanded="false" data-tip="Controls" data-key="?">${icon('help')}</button>
      <div class="panel pop" hidden role="dialog" aria-label="Controls">
        <div class="pop-head"><h2>Controls</h2><button class="iconbtn" data-action="close-help" aria-label="Close [Esc]">${icon('close')}</button></div>
        <table>${CONTROLS.map(([a, b]) => `<tr><th scope="row">${a}</th><td>${b}</td></tr>`).join('')}</table>
        <button class="btn" data-action="tutorial">Replay tutorial</button>
      </div>
      <div class="panel dock" role="toolbar" aria-label="Tools">
        ${TOOLS.slice(0, 3).map(toolBtn).join('')}
        <span class="sep"></span>
        <div class="stepper" data-hint="elev" data-tip="${ROAD_TIP}">
          <button class="iconbtn" data-action="level-down" aria-label="Lower road [PageDown]" data-tip="Lower road" data-key="PageDown"><b>−</b></button>
          <svg class="pic" viewBox="0 0 40 24" aria-hidden="true">
            <path class="gnd" d="M1 22.5h38"/>
            <line class="deck" x1="4" x2="36" y1="22" y2="22"/>
            <line class="pillar" x1="12" x2="12" y1="22" y2="22"/>
            <line class="pillar" x1="28" x2="28" y1="22" y2="22"/>
          </svg>
          <span class="elev"><b class="lv num"></b><small class="eh"></small></span>
          <button class="iconbtn" data-action="level-up" aria-label="Raise road [PageUp]" data-tip="Raise road" data-key="PageUp"><b>+</b></button>
        </div>
        <span class="sep"></span>
        ${toolBtn(TOOLS[3])}
      </div>
      <div class="toasts" role="status" aria-live="polite"></div>
      <div class="modal" hidden></div>
      <div class="tip" role="tooltip" hidden></div>`;
    for (const r of RES) this.chips[r.k] = this.q(`[data-res="${r.k}"]`);
    this.toolBtns = Array.from(root.querySelectorAll<HTMLButtonElement>('.dock [data-tool]'));
    this.speedBtns = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-speed]'));
    this.dots = Array.from(root.querySelectorAll<HTMLElement>('.dots i'));
    this.tip = this.q('.tip');

    for (const b of this.speedBtns) b.onclick = () => { game.speed = Number(b.dataset.speed) as 0 | 1 | 2 | 4; };
    for (const b of this.toolBtns) b.onclick = () => { game.tool = b.dataset.tool as Tool; };
    this.q('[data-action="level-down"]').onclick = () => game.setLevel(game.level - 1);
    this.q('[data-action="level-up"]').onclick = () => game.setLevel(game.level + 1);
    this.q('[data-action="help"]').onclick = () => this.setHelp(!this.helpOpen);
    this.q('[data-action="close-help"]').onclick = () => this.setHelp(false);
    this.q('[data-action="tutorial"]').onclick = () => { this.setHelp(false); this.onTutorial?.(); };
    document.addEventListener('pointerdown', e => {
      if (this.helpOpen && !(e.target as Element).closest('.pop, .helpbtn')) this.setHelp(false, false);
    });
    // capture phase on window: runs before Input's listener, so modal keys never reach the tools
    window.addEventListener('keydown', e => this.onKey(e), true);
    this.bindTips();
  }

  private q<T extends HTMLElement = HTMLElement>(s: string): T {
    return this.root.querySelector(s) as T;
  }

  // ---------- keyboard ----------
  private onKey(e: KeyboardEvent): void {
    const g = this.game;
    if (g.gameOver || g.pendingReward) {
      e.stopPropagation(); // no key reaches Input while a modal is open (tools, level, Esc)
      if (/^[1-4]$/.test(e.key)) {
        if (!g.gameOver && (e.key === '1' || e.key === '2')) this.selectCard(Number(e.key) - 1, true);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (g.gameOver) location.reload();
        else g.applyReward(this.sel);
      }
      return;
    }
    if (e.key === 'Escape') {
      this.hideTip();
      this.setHelp(false);
    } else if ((e.key === '?' || e.key === 'h' || e.key === 'H') && !e.ctrlKey && !e.metaKey && !e.altKey) {
      this.setHelp(!this.helpOpen);
    }
  }

  private setHelp(open: boolean, refocus = true): void {
    if (open === this.helpOpen) return;
    this.helpOpen = open;
    const pop = this.q('.pop'), btn = this.q('.helpbtn');
    pop.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    this.hideTip();
    if (open) this.q('[data-action="close-help"]').focus();
    else if (refocus) btn.focus();
  }

  // ---------- tooltips: one shared .tip ----------
  private bindTips(): void {
    const target = (e: Event) => (e.target as Element).closest<HTMLElement>('[data-tip]');
    this.root.addEventListener('pointerover', e => {
      if (e.pointerType === 'touch') return;
      const el = target(e);
      if (el === this.tipFor) return;
      this.hideTip();
      if (!el?.dataset.tip) return;
      this.tipFor = el;
      this.tipTimer = setTimeout(() => this.showTip(el), 300);
    });
    this.root.addEventListener('pointerout', e => {
      const to = e.relatedTarget as Node | null;
      if (this.tipFor && to && this.tipFor.contains(to)) return;
      this.hideTip();
    });
    this.root.addEventListener('focusin', e => {
      const el = target(e);
      if (el?.dataset.tip && (e.target as Element).matches(':focus-visible')) this.showTip(el);
    });
    this.root.addEventListener('focusout', () => this.hideTip());
    // touch: long-press a dock button shows its tooltip for 2.5 s
    let press: ReturnType<typeof setTimeout> | undefined;
    this.root.addEventListener('pointerdown', e => {
      if (e.pointerType !== 'touch') return;
      const el = target(e);
      if (!el?.closest('.dock')) return;
      press = setTimeout(() => { this.showTip(el, true); setTimeout(() => this.hideTip(), 2500); }, 500);
    });
    const stop = () => clearTimeout(press);
    this.root.addEventListener('pointerup', stop);
    this.root.addEventListener('pointercancel', stop);
  }

  private showTip(el: HTMLElement, touch = false): void {
    clearTimeout(this.tipTimer);
    this.tipFor = el;
    const key = el.dataset.key;
    this.tip.innerHTML = `${esc(el.dataset.tip ?? '')}${key ? ` <kbd>${esc(key)}</kbd>` : ''}`;
    this.tip.classList.toggle('touch', touch);
    this.tip.hidden = false;
    const r = el.getBoundingClientRect(), t = this.tip.getBoundingClientRect();
    const above = !!el.closest('.dock, .tutorial');
    const x = Math.max(8, Math.min(innerWidth - t.width - 8, r.left + r.width / 2 - t.width / 2));
    const y = above ? r.top - t.height - 8 : r.bottom + 8;
    this.tip.style.left = `${x}px`;
    this.tip.style.top = `${Math.max(8, Math.min(innerHeight - t.height - 8, y))}px`;
  }

  private hideTip(): void {
    clearTimeout(this.tipTimer);
    this.tipFor = null;
    this.tip.hidden = true;
  }

  // ---------- toasts: max 2, duplicates merge ----------
  private toast(raw: string): void {
    const text = FRIENDLY[raw] ?? raw;
    const dup = this.toasts.find(t => t.text === text);
    if (dup) {
      dup.n++;
      (dup.el.querySelector('.n') as HTMLElement).textContent = ` x${dup.n}`;
      clearTimeout(dup.timer);
      dup.timer = setTimeout(() => this.dropToast(dup), 2500);
      return;
    }
    if (this.toasts.length >= 2) this.dropToast(this.toasts[0]);
    const err = ERROR_RE.test(raw);
    const el = document.createElement('div');
    el.className = err ? 'toast err' : 'toast';
    el.innerHTML = `${icon(err ? 'warning' : 'check')}<span class="txt"></span><b class="n num"></b>`;
    (el.querySelector('.txt') as HTMLElement).textContent = text;
    this.q('.toasts').appendChild(el);
    const t: Toast = { text, el, n: 1, timer: setTimeout(() => this.dropToast(t), 2500) };
    this.toasts.push(t);
  }

  private dropToast(t: Toast): void {
    clearTimeout(t.timer);
    t.el.remove();
    this.toasts = this.toasts.filter(x => x !== t);
  }

  // ---------- modals ----------
  private selectCard(k: number, focus = false): void {
    this.sel = k;
    this.root.querySelectorAll<HTMLButtonElement>('.rcard').forEach((b, i) => {
      b.setAttribute('aria-pressed', String(i === k));
      if (i === k && focus) b.focus();
    });
  }

  private renderModal(): void {
    const g = this.game, modal = this.q('.modal');
    const open = g.gameOver || !!g.pendingReward;
    this.hideTip();
    this.setHelp(false, false);
    // keep Tab inside the modal
    for (const el of Array.from(this.root.children)) if (el !== modal) el.toggleAttribute('inert', open);
    modal.hidden = !open;
    if (g.gameOver) {
      const city = g.cities.find(c => c.overcrowd >= 1);
      modal.innerHTML = `
        <div class="box" role="dialog" aria-modal="true" aria-labelledby="m-title">
          <h2 id="m-title" class="bad">${icon('warning')} Overcrowded!</h2>
          ${city ? `<p class="sub">${esc(city.name)} has too many waiting cars.</p>` : ''}
          <div class="stats">
            <div>${icon('car', 'big')}<span>Trips</span><b class="num">${g.score}</b></div>
            <div>${icon('week', 'big')}<span>Weeks</span><b class="num">${g.week}</b></div>
          </div>
          <div class="actions"><button class="btn primary" data-action="restart">Play again <kbd>Enter</kbd></button></div>
        </div>`;
      const b = this.q<HTMLButtonElement>('[data-action="restart"]');
      b.onclick = () => location.reload();
      b.focus();
    } else if (g.pendingReward) {
      modal.innerHTML = `
        <div class="box" role="dialog" aria-modal="true" aria-labelledby="m-title">
          <h2 id="m-title">${icon('gift')} Week ${g.week - 1} complete</h2>
          <p class="sub">Choose one upgrade</p>
          <div class="cards">${g.pendingReward.map((r, k) => `
            <button class="rcard" data-i="${k}" aria-pressed="false"><span class="kb" aria-hidden="true">${k + 1}</span>${icon('check', 'selmark')}${rewardRows(r)}</button>`).join('')}
          </div>
          <div class="actions"><button class="btn primary" data-action="confirm">Confirm <kbd>Enter</kbd></button></div>
        </div>`;
      modal.querySelectorAll<HTMLButtonElement>('.rcard').forEach(b => {
        const k = Number(b.dataset.i);
        b.onfocus = () => this.selectCard(k);
        b.onclick = () => this.selectCard(k);
        b.ondblclick = () => g.applyReward(k);
      });
      this.q('[data-action="confirm"]').onclick = () => g.applyReward(this.sel);
      this.selectCard(0, true);
    } else {
      modal.innerHTML = '';
    }
  }

  // ---------- per-frame update: writes the DOM only when a value changed ----------
  update(): void {
    const g = this.game, inv = g.inventory, L = this.last;

    for (const { k } of RES) {
      const v = inv[k], prev = L.inv[k];
      if (v === prev) continue;
      L.inv[k] = v;
      const c = this.chips[k];
      (c.querySelector('.num') as HTMLElement).textContent = String(v);
      c.classList.toggle('zero', v <= 0);
      c.classList.toggle('low', v > 0 && (k === 'asphalt' ? v < 10 : v === 1));
      if (prev !== undefined) {
        const d = v - prev;
        (c.querySelector('.delta') as HTMLElement).textContent = d > 0 ? `+${d}` : `−${-d}`;
        flash(c, d > 0 ? 'gain' : 'spend', ['gain', 'spend']);
      }
    }

    for (const k of ['lights', 'roundabouts'] as const) {
      const v = inv[k];
      if (v === L.inv[k]) continue;
      L.inv[k] = v;
      const b = this.toolBtns.find(x => x.dataset.tool === (k === 'lights' ? 'light' : 'roundabout'))!;
      (b.querySelector('.stock') as HTMLElement).textContent = String(v);
      b.classList.toggle('zero', v <= 0);
      b.setAttribute('aria-label', `${k === 'lights' ? 'Traffic light' : 'Roundabout'}, ${v} left`);
    }

    if (g.speed !== L.speed) {
      L.speed = g.speed;
      for (const b of this.speedBtns) b.setAttribute('aria-pressed', String(Number(b.dataset.speed) === g.speed));
      this.q('.status').classList.toggle('paused', g.speed === 0);
      L.week = undefined; // relabel Week / Paused below
    }

    const toolChanged = g.tool !== L.tool;
    if (toolChanged) {
      L.tool = g.tool;
      for (const b of this.toolBtns) b.setAttribute('aria-pressed', String(b.dataset.tool === g.tool));
      document.body.dataset.tool = g.tool;
      // same feedback for click and keys 2/3
      if (g.tool === 'light' && inv.lights <= 0) this.toast('No traffic lights left');
      if (g.tool === 'roundabout' && inv.roundabouts <= 0) this.toast('No roundabouts left');
    }

    if (toolChanged || g.level !== L.level) {
      const pulse = L.level !== undefined && g.level !== L.level;
      const lv = g.level;
      L.level = lv;
      // demolishAt prefers the current level, so Demolish keeps the stepper live
      const off = g.tool !== 'road' && g.tool !== 'demolish';
      const st = this.q('.stepper');
      st.classList.toggle('off', off);
      st.dataset.tip = off ? 'Elevation applies to the Road tool' : ROAD_TIP;
      this.q<HTMLButtonElement>('[data-action="level-down"]').disabled = off || lv <= 0;
      this.q<HTMLButtonElement>('[data-action="level-up"]').disabled = off || lv >= 10;
      this.q('.lv').textContent = lv === 0 ? 'Ground' : `L${lv}`;
      this.q('.eh').textContent = lv === 0 ? 'Ground · tunnels through mountains' : lv < 6 ? 'Viaduct · 1 bridge' : 'Viaduct · clears mountains';
      const y = String(lv === 0 ? 22 : 20 - lv * 1.6);
      const deck = st.querySelector('.deck')!;
      deck.setAttribute('y1', y);
      deck.setAttribute('y2', y);
      st.querySelectorAll('.pillar').forEach(p => {
        p.setAttribute('y1', y);
        p.setAttribute('visibility', lv === 0 ? 'hidden' : 'visible');
      });
      if (pulse) flash(this.q('.elev'), 'pulse');
    }

    if (g.score !== L.score) {
      const up = L.score !== undefined && g.score > L.score;
      L.score = g.score;
      const s = this.q('.score');
      s.textContent = String(g.score);
      if (up) flash(s, 'bump');
    }

    if (g.week !== L.week || g.day !== L.day) {
      L.week = g.week;
      L.day = g.day;
      L.dayFrac = undefined;
      this.q('.wk').innerHTML = g.speed === 0 ? 'Paused' : `<span class="long">Week </span><span class="short">W</span>${g.week}`;
      this.dots.forEach((d, i) => { d.className = i + 1 < g.day ? 'past' : i + 1 === g.day ? 'now' : ''; });
      this.q('.week').dataset.tip = `Week ${g.week}, day ${g.day} of 7. At the end of the week you choose a reward.`;
    }
    const frac = Math.round(((g.time % DAY_SECONDS) / DAY_SECONDS) * 20) / 20;
    if (frac !== L.dayFrac) {
      L.dayFrac = frac;
      this.dots[g.day - 1]?.style.setProperty('--p', String(frac));
    }

    let danger = 0;
    for (const c of g.cities) danger = Math.max(danger, c.overcrowd);
    const pct = Math.ceil(danger * 20) * 5; // ceil: any overcrowd > 0 shows the chip
    if (pct !== L.danger) {
      L.danger = pct;
      const chip = this.q('.danger');
      chip.hidden = pct === 0;
      (chip.querySelector('.pct') as HTMLElement).textContent = `${pct}%`;
    }

    // ponytail: change detection on the text, so an identical message repeated before it clears is not re-toasted
    if (g.message !== L.msg) {
      L.msg = g.message;
      if (g.message) this.toast(g.message);
    }

    if (g.pendingReward !== L.reward || g.gameOver !== L.over) {
      L.reward = g.pendingReward;
      L.over = g.gameOver;
      this.renderModal();
    }
  }
}
