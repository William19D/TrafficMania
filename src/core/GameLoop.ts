// Main loop based on requestAnimationFrame; dt in seconds, capped at 0.1
export class GameLoop {
  private raf = 0;
  private last = 0;

  constructor(private update: (dt: number) => void, private render: () => void) {}

  start(): void {
    this.last = performance.now();
    const frame = (now: number): void => {
      const dt = Math.min(0.1, Math.max(0, (now - this.last) / 1000));
      this.last = now;
      this.update(dt);
      this.render();
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
  }
}
