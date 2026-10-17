// Synthesized sound (Web Audio, no files): UI clicks and hover ticks, build / demolish / place cues from the sim (Game.sfx),
// an income blip, the level-up, star and achievement fanfares, a chime when a jam clears, the fail-countdown alarm, the error buzz (from the HUD), a city hum that follows the
// traffic on screen and the zoom, a horn now and then from a car that has waited long, and a calm generative music loop whose shaker and arpeggio layers come in as traffic on screen flows.
// The AudioContext starts on the first gesture (autoplay policy) and is suspended while muted or the tab is hidden.
import type { Game, Sfx } from '../core/Game.ts';
import type { CanvasRenderer } from '../rendering/CanvasRenderer.ts';

export interface Mix { master: number; music: number; sfx: number; muted: boolean; musicOn: boolean }
type Cue = Sfx | 'click' | 'tick' | 'income' | 'level' | 'stars' | 'trophy' | 'alarm' | 'error' | 'horn';

const KEY = 'tm_audio';
const DEFAULT_MIX: Mix = { master: 0.7, music: 0.5, sfx: 0.8, muted: false, musicOn: true };
// Horns: game seconds a car must have stood still, and the real seconds between two
const HORN_WAIT = 8, HORN_GAP = 5;
// Music: seconds per beat, and the chords (MIDI notes) that change every two bars: Fmaj7, Em7, Dm7, Cmaj9
const BEAT = 0.6;
const CHORDS = [[53, 57, 60, 64], [52, 55, 59, 62], [50, 53, 57, 60], [48, 52, 55, 62]];
const SCALE = [72, 74, 76, 79, 81, 84]; // C major pentatonic, over the pad
// the jam-clear chime at most every CLEAR_GAP real seconds
const CLEAR_GAP = 2;
const hz = (m: number): number => 440 * 2 ** ((m - 69) / 12);

function loadMix(): Mix {
  try { return { ...DEFAULT_MIX, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Mix> }; } catch { return { ...DEFAULT_MIX }; }
}

class Sound {
  mix = loadMix();
  private ctx: AudioContext | null = null;
  private out!: GainNode;
  private fx!: GainNode;
  private music!: GainNode;
  // music layers: shaker (traffic moving) and arpeggio (busy and flowing), faded by update
  private layerA!: GainNode;
  private layerB!: GainNode;
  private lastClear = 0;
  private echo!: DelayNode;
  private hum!: GainNode;
  private humLp!: BiquadFilterNode;
  private noise!: AudioBuffer;
  // music scheduler: the next beat's time and its index
  private beatT = 0;
  private beat = 0;
  // what the last poll saw of the game
  private game: Game | null = null;
  private seen = { income: 0, level: 0, alarm: '', at: 0 };
  private lastIncome = 0;
  private lastHorn = 0;
  private honked = new WeakSet<object>();
  private hovered: Element | null = null;

  constructor() {
    const start = (): void => this.start();
    window.addEventListener('pointerdown', start, true);
    window.addEventListener('keydown', start, true);
    document.addEventListener('visibilitychange', () => this.apply());
    // UI: a click on any button, a faint tick when the mouse comes onto one
    document.addEventListener('pointerdown', e => {
      if ((e.target as Element).closest?.('button, .slot, input[type=range]')) this.play('click');
    }, true);
    document.addEventListener('pointerover', e => {
      const b = e.pointerType === 'mouse' ? (e.target as Element).closest?.('button:not(:disabled)') ?? null : null;
      if (b && b !== this.hovered) this.play('tick');
      this.hovered = b;
    }, true);
  }

  set(m: Partial<Mix>): void {
    Object.assign(this.mix, m);
    try { localStorage.setItem(KEY, JSON.stringify(this.mix)); } catch { /* storage blocked: the mix lasts this session */ }
    this.apply();
  }

  toggleMute(): void { this.set({ muted: !this.mix.muted }); }

  private start(): void {
    if (this.ctx) { this.apply(); return; }
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const c = this.ctx = new AC();
    this.out = c.createGain();
    this.out.connect(c.destination);
    this.fx = c.createGain();
    this.fx.connect(this.out);
    this.music = c.createGain();
    this.music.connect(this.out);
    this.layerA = c.createGain();
    this.layerB = c.createGain();
    this.layerA.gain.value = this.layerB.gain.value = 0;
    this.layerA.connect(this.music);
    this.layerB.connect(this.music);
    // the melody's echo: a feedback delay into the music bus
    this.echo = c.createDelay(1);
    this.echo.delayTime.value = BEAT * 0.75;
    const fb = c.createGain();
    fb.gain.value = 0.35;
    this.echo.connect(fb).connect(this.echo);
    this.echo.connect(this.music);
    // 2 s of brown noise, looped: the city rumble, and the grit of a demolish
    const n = this.noise = c.createBuffer(1, c.sampleRate * 2, c.sampleRate), d = n.getChannelData(0);
    for (let i = 0, v = 0; i < d.length; i++) { v = (v + 0.02 * (Math.random() * 2 - 1)) / 1.02; d[i] = v * 3.5; }
    const src = c.createBufferSource();
    src.buffer = n;
    src.loop = true;
    this.humLp = c.createBiquadFilter();
    this.humLp.frequency.value = 300;
    this.hum = c.createGain();
    this.hum.gain.value = 0;
    src.connect(this.humLp).connect(this.hum).connect(this.fx);
    src.start();
    this.beatT = c.currentTime + 0.5;
    // ponytail: a 250 ms timer schedules the music 1 s ahead; a hidden tab suspends the context, so its throttling never shows
    setInterval(() => this.schedule(), 250);
    this.apply();
  }

  // Volumes and run state from the mix (a muted or hidden game suspends the context: no CPU spent)
  private apply(): void {
    const c = this.ctx;
    if (!c) return;
    const on = !this.mix.muted && document.visibilityState === 'visible';
    if (on && c.state === 'suspended') void c.resume();
    if (!on && c.state === 'running') void c.suspend();
    const t = c.currentTime;
    this.out.gain.setTargetAtTime(this.mix.master, t, 0.03);
    this.fx.gain.setTargetAtTime(this.mix.sfx, t, 0.03);
    this.music.gain.setTargetAtTime(this.mix.musicOn ? this.mix.music * 0.8 : 0, t, 0.3);
  }

  private get live(): AudioContext | null {
    return this.ctx?.state === 'running' ? this.ctx : null;
  }

  // One enveloped oscillator: f to f2 over dur, from t; it holds vol until the last `release` seconds (default: decays all along)
  private tone(f: number, t: number, dur: number, vol: number, type: OscillatorType = 'sine', f2 = f, bus: AudioNode = this.fx, attack = 0.005, release = dur): void {
    const c = this.ctx!, o = c.createOscillator(), g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f, t);
    if (f2 !== f) o.frequency.exponentialRampToValueAtTime(f2, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + attack);
    if (release < dur - attack) g.gain.setValueAtTime(vol, t + dur - release);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(bus);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  private burst(t: number, dur: number, vol: number, freq: number): void {
    const c = this.ctx!, s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
    s.buffer = this.noise;
    f.frequency.setValueAtTime(freq, t);
    f.frequency.exponentialRampToValueAtTime(freq / 4, t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f).connect(g).connect(this.fx);
    s.start(t, Math.random());
    s.stop(t + dur);
  }

  play(cue: Cue, pan = 0): void {
    const c = this.live;
    if (!c) return;
    const t = c.currentTime + 0.01;
    switch (cue) {
      case 'tick': this.tone(2600, t, 0.025, 0.012); break;
      case 'click': this.tone(1100, t, 0.05, 0.05, 'triangle', 650); break;
      case 'build': this.tone(190, t, 0.14, 0.3, 'triangle', 80); this.tone(880, t + 0.04, 0.12, 0.05); this.tone(1320, t + 0.07, 0.14, 0.03); break;
      case 'place': this.tone(523, t, 0.3, 0.14, 'triangle'); this.tone(784, t + 0.06, 0.35, 0.11, 'triangle'); this.tone(1047, t + 0.12, 0.4, 0.06); break;
      case 'demolish': this.burst(t, 0.35, 0.8, 1400); this.tone(130, t, 0.25, 0.2, 'triangle', 45); break;
      case 'income': this.tone(1568, t, 0.1, 0.05); this.tone(2093, t + 0.06, 0.16, 0.045); break;
      case 'error': this.tone(155, t, 0.11, 0.12, 'sawtooth', 140); this.tone(155, t + 0.13, 0.14, 0.12, 'sawtooth', 120); break;
      case 'clear': {
        const now = performance.now() / 1000;
        if (now - this.lastClear < CLEAR_GAP) break;
        this.lastClear = now;
        this.tone(1319, t, 0.5, 0.06); this.tone(1976, t + 0.08, 0.7, 0.05); this.tone(2637, t + 0.16, 0.6, 0.025);
        break;
      }
      case 'stars':
        [392, 523, 659, 784].forEach((f, i) => { this.tone(f, t + i * 0.13, 0.3, 0.16, 'sawtooth', f, this.fx, 0.02); this.tone(f * 2, t + i * 0.13, 0.3, 0.05); });
        [523, 659, 784, 1047].forEach(f => this.tone(f, t + 0.6, 1.6, 0.1, 'triangle', f, this.fx, 0.03, 1));
        [1568, 2093, 2637].forEach((f, i) => this.tone(f, t + 0.75 + i * 0.22, 0.5, 0.05));
        break;
      case 'trophy':
        [784, 988, 1175, 1568].forEach((f, i) => this.tone(f, t + i * 0.07, 0.9, 0.08, 'sine'));
        this.tone(392, t, 0.9, 0.12, 'triangle');
        break;
      case 'level':
        [523, 659, 784, 1047].forEach((f, i) => this.tone(f, t + i * 0.11, 0.35, 0.2, 'triangle'));
        [659, 784, 1047].forEach(f => this.tone(f, t + 0.48, 1.1, 0.12, 'triangle'));
        break;
      case 'alarm': for (let i = 0; i < 3; i++) { this.tone(880, t + i * 0.36, 0.16, 0.1, 'square'); this.tone(660, t + i * 0.36 + 0.18, 0.16, 0.1, 'square'); } break;
      case 'horn': {
        const p = c.createStereoPanner(), f = c.createBiquadFilter();
        p.pan.value = pan;
        f.frequency.value = 1600;
        f.connect(p).connect(this.fx);
        const len = Math.random() < 0.5 ? 0.18 : 0.4, base = 360 + Math.random() * 120;
        this.tone(base, t, len, 0.06, 'square', base, f, 0.01);
        this.tone(base * 1.26, t, len, 0.045, 'square', base * 1.26, f, 0.01);
        break;
      }
    }
  }

  // The next second of music: a soft pad per chord (two bars), a bass on each bar, a sparse pentatonic melody into the echo
  private schedule(): void {
    const c = this.live;
    if (!c || !this.mix.musicOn) return;
    if (this.beatT < c.currentTime) this.beatT = c.currentTime + 0.05;
    for (; this.beatT < c.currentTime + 1; this.beatT += BEAT, this.beat++) {
      const t = this.beatT, chord = CHORDS[Math.floor(this.beat / 8) % CHORDS.length];
      if (this.beat % 8 === 0) for (const m of chord) this.tone(hz(m), t, BEAT * 9.5, 0.05, 'triangle', hz(m), this.music, 1.2, 2);
      if (this.beat % 4 === 0) this.tone(hz(chord[0] - 12), t, BEAT * 3.5, 0.14, 'sine', hz(chord[0] - 12), this.music, 0.05);
      if (Math.random() < 0.4) {
        const m = SCALE[Math.floor(Math.random() * SCALE.length)];
        this.tone(hz(m), t + (Math.random() < 0.3 ? BEAT / 2 : 0), BEAT * 1.6, 0.05, 'sine', hz(m), this.echo, 0.02);
        this.tone(hz(m), t, BEAT * 1.6, 0.04, 'sine', hz(m), this.music, 0.02);
      }
      // layers (silent until update fades them in): a shaker on the off-beat, chord tones in eighths
      const sh = c.createBufferSource(), hp = c.createBiquadFilter(), g = c.createGain();
      sh.buffer = this.noise;
      hp.type = 'highpass';
      hp.frequency.value = 6000;
      g.gain.setValueAtTime(0.25, t + BEAT / 2);
      g.gain.exponentialRampToValueAtTime(0.0001, t + BEAT / 2 + 0.08);
      sh.connect(hp).connect(g).connect(this.layerA);
      sh.start(t + BEAT / 2, Math.random());
      sh.stop(t + BEAT / 2 + 0.1);
      for (let i = 0; i < 2; i++) {
        const m = chord[(this.beat * 2 + i) % 4] + 12;
        this.tone(hz(m), t + i * BEAT / 2, BEAT * 0.45, 0.035, 'triangle', hz(m), this.layerB, 0.01);
      }
    }
  }

  // Per frame: the sim's cues, money, level, alarm; four times a second the hum and the horns
  update(g: Game, view: CanvasRenderer, paused: boolean): void {
    const now = performance.now() / 1000, income = g.ledger.today.business + g.ledger.today.trade, alarm = g.gameOver || (g.alarm ? `${g.alarm.kind}${g.alarm.days}` : '');
    if (g !== this.game) {
      this.game = g;
      this.seen = { income, level: g.cityLevel, alarm, at: 0 };
      g.sfx.clear();
    }
    const s = this.seen;
    for (const x of g.sfx) this.play(x);
    g.sfx.clear();
    if (income > s.income && now - this.lastIncome > 1.5) { this.lastIncome = now; this.play('income'); }
    if (g.cityLevel > s.level) this.play('level');
    if (alarm && alarm !== s.alarm) this.play('alarm');
    Object.assign(s, { income, level: g.cityLevel, alarm });
    const c = this.live;
    if (!c || now - s.at < 0.25) return;
    s.at = now;
    // cars on screen (capped count), any of them waiting long enough to honk
    const a = view.screenToWorld(0, 0), b = view.screenToWorld(innerWidth, innerHeight);
    let n = 0, moving = 0, honk: { car: object; x: number } | null = null;
    for (const car of g.cars) {
      const p = g.graph.carPos(car);
      if (p.x < a.x || p.y < a.y || p.x > b.x || p.y > b.y) continue;
      if (car.wait > HORN_WAIT && !this.honked.has(car)) honk = { car, x: p.x };
      moving += +(car.speed > 2);
      if (++n >= 80) break;
    }
    const busy = Math.min(1, n / 50), near = Math.min(1, Math.max(0, (view.cam.zoom - 0.3) / 1.7));
    const vol = (0.03 + 0.22 * busy) * (0.45 + 0.55 * near) * (paused ? 0.25 : 1);
    this.hum.gain.setTargetAtTime(vol, c.currentTime, 0.4);
    this.humLp.frequency.setTargetAtTime(220 + 520 * busy * near, c.currentTime, 0.4);
    // the layers follow the flow: moving share of the cars on screen, slow fades so a jam lets the music thin out
    const flow = n ? moving / n : 0, on = !paused && n >= 4;
    this.layerA.gain.setTargetAtTime(on && flow > 0.4 ? 0.5 + 0.5 * busy : 0, c.currentTime, 3);
    this.layerB.gain.setTargetAtTime(on && busy > 0.35 && flow > 0.65 ? 1 : 0, c.currentTime, 4);
    if (honk && !paused && now - this.lastHorn > HORN_GAP && Math.random() < 0.5) {
      this.lastHorn = now;
      this.honked.add(honk.car);
      this.play('horn', Math.max(-0.8, Math.min(0.8, ((honk.x - a.x) / (b.x - a.x)) * 2 - 1)));
    }
  }
}

export const sound = new Sound();
