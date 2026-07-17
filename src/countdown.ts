/**
 * countdown.ts — 3 · 2 · 1 · GO, between the start arriving and the game starting.
 *
 * Why this exists: without it, a round begins the instant the board appears, and
 * whoever happened to be looking at their screen gets a free head start on
 * everyone still registering that the deal happened. It also reads as a jump-cut.
 *
 * Two things make it work:
 *
 *  - THE AUDIO CARRIES IT. Players watch the prize card, not the overlay, so the
 *    numbers are a beat you hear. The overlay is deliberately thin — big, fast,
 *    and gone — because the point is to let the table READ the first prize before
 *    the clock starts, not to hide it behind a splash screen.
 *
 *  - EACH PEER COUNTS LOCALLY, from the start message it just received. There is
 *    no clock sync here and there does not need to be: peers are in step to
 *    within one network hop, and the round clock is host-authoritative anyway, so
 *    a guest that finishes counting a moment late simply gets the host's first
 *    snapshot immediately.
 *
 * setInterval, never rAF: a backgrounded tab pauses rAF, and a countdown that
 * stops when you glance at another window is a countdown that never fires.
 * Always cancel() on teardown — a stray timer that starts a match on a screen
 * that no longer exists is exactly the kind of ghost this factory keeps shipping.
 */

export interface CountdownConfig {
  /** Where the overlay mounts. Sized by CSS to cover the felt, not the page. */
  container: HTMLElement;
  /** Fires per step with '3' | '2' | '1' | 'GO' — hang the audio off this. */
  onStep: (label: string) => void;
  /** Fires once, after GO has been seen. This is where the match starts. */
  onDone: () => void;
  /** Milliseconds per step. */
  stepMs?: number;
  /** Injectable for tests. */
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (h: unknown) => void;
}

export interface Countdown {
  /** Tear down without firing onDone. Safe to call twice. */
  cancel(): void;
  /** Still counting? False once GO has landed or it was cancelled. */
  running(): boolean;
}

export const STEPS: readonly string[] = Object.freeze(['3', '2', '1', 'GO']);
export const STEP_MS = 620;

export function createCountdown(cfg: CountdownConfig): Countdown {
  const stepMs = cfg.stepMs ?? STEP_MS;
  const si = cfg.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const ci = cfg.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));

  const el = document.createElement('div');
  el.className = 'countdown';
  // Announced, not just drawn: a screen reader gets the same three beats.
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'assertive');
  el.innerHTML = '<span class="cd-num" data-el="num"></span>';
  const num = el.querySelector<HTMLElement>('[data-el="num"]')!;
  cfg.container.appendChild(el);

  let i = -1;
  let handle: unknown = null;
  let done = false;

  const stop = (): void => {
    if (handle !== null) ci(handle);
    handle = null;
    el.remove();
  };

  const step = (): void => {
    i++;
    if (i >= STEPS.length) {
      // GO has been on screen for its full beat. Now the match may start.
      done = true;
      stop();
      cfg.onDone();
      return;
    }
    const label = STEPS[i];
    num.textContent = label;
    num.classList.toggle('is-go', label === 'GO');
    // Restarting the animation needs the class to actually leave the element
    // for a frame; toggling it off and forcing a reflow is the cheap way.
    num.classList.remove('pop');
    void num.offsetWidth;
    num.classList.add('pop');
    cfg.onStep(label);
  };

  step();
  handle = si(step, stepMs);

  return {
    cancel(): void {
      if (done) return;
      done = true;
      stop();
    },
    running: () => !done,
  };
}
