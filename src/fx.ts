/**
 * fx.ts — particles and screen shake on a canvas pinned behind the cards.
 *
 * The game is DOM, because cards are text and shape and DOM gives crisp type,
 * real hit targets and free accessibility. But DOM is a bad place to run three
 * hundred particles, so the juice lives on one canvas underneath and the two
 * never fight: the canvas draws light, the DOM draws meaning.
 *
 * Everything here degrades rather than gates. Under `prefers-reduced-motion`
 * there is no shake and no particles, and the game plays exactly the same.
 */

export interface Fx {
  /** Throw sparks from a point in viewport coordinates. */
  burst(x: number, y: number, color: string, count?: number): void;
  /** Sparks from the centre of an element — the common case. */
  burstAt(el: Element, color: string, count?: number): void;
  /** Kick the table. `strength` is roughly pixels of displacement. */
  shake(strength: number): void;
  destroy(): void;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  color: string;
}

export interface FxConfig {
  canvas: HTMLCanvasElement;
  /** The element that gets displaced when the table is kicked. */
  shakeTarget: HTMLElement;
}

export function createFx(cfg: FxConfig): Fx {
  const { canvas, shakeTarget } = cfg;
  const ctx = canvas.getContext('2d');
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  const particles: Particle[] = [];
  let shakeAmt = 0;
  let raf = 0;
  let running = false;

  const calm = (): boolean => !!reduced?.matches;

  function resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    // A transient 0-size measurement yields a 0-scale context and NaN coords.
    // Ignore it and let the next resize/frame catch the real size.
    if (w <= 0 || h <= 0) return;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function frame(): void {
    raf = 0;
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);

    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life -= 1;
      if (p.life <= 0) {
        particles.splice(i, 1);
        continue;
      }
      p.vy += 0.28; // gravity — sparks fall, they don't drift
      p.vx *= 0.99;
      p.x += p.vx;
      p.y += p.vy;
      const a = p.life / p.max;
      ctx.globalAlpha = a;
      ctx.fillStyle = p.color;
      const s = p.size * a;
      ctx.fillRect(p.x - s / 2, p.y - s / 2, s, s);
    }
    ctx.globalAlpha = 1;

    if (shakeAmt > 0.4) {
      const dx = (Math.random() * 2 - 1) * shakeAmt;
      const dy = (Math.random() * 2 - 1) * shakeAmt;
      shakeTarget.style.transform = `translate(${dx.toFixed(2)}px, ${dy.toFixed(2)}px)`;
      shakeAmt *= 0.86;
    } else if (shakeAmt !== 0) {
      shakeAmt = 0;
      shakeTarget.style.transform = '';
    }

    running = particles.length > 0 || shakeAmt > 0;
    if (running) raf = requestAnimationFrame(frame);
  }

  function kick(): void {
    if (!running) {
      running = true;
      raf = requestAnimationFrame(frame);
    }
  }

  const onResize = (): void => resize();
  window.addEventListener('resize', onResize);
  resize();

  return {
    burst(x, y, color, count = 18) {
      if (calm() || !ctx) return;
      const rect = canvas.getBoundingClientRect();
      for (let i = 0; i < count; i++) {
        const a = Math.random() * Math.PI * 2;
        const sp = 1.5 + Math.random() * 5;
        const max = 26 + Math.random() * 26;
        particles.push({
          x: x - rect.left,
          y: y - rect.top,
          vx: Math.cos(a) * sp,
          vy: Math.sin(a) * sp - 2,
          life: max,
          max,
          size: 2 + Math.random() * 4,
          color,
        });
      }
      kick();
    },

    burstAt(el, color, count) {
      const r = el.getBoundingClientRect();
      this.burst(r.left + r.width / 2, r.top + r.height / 2, color, count);
    },

    shake(strength) {
      if (calm()) return;
      shakeAmt = Math.max(shakeAmt, strength);
      kick();
    },

    destroy() {
      window.removeEventListener('resize', onResize);
      if (raf) cancelAnimationFrame(raf);
      particles.length = 0;
      shakeTarget.style.transform = '';
    },
  };
}
