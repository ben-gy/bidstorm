/**
 * countdown.test.ts — 3 · 2 · 1 · GO.
 *
 * Small, but it owns two things that fail badly: it starts the match (so if it
 * never fires, the game never begins), and it holds a timer (so if it fires
 * after teardown, it starts a match on a screen that no longer exists — exactly
 * the kind of ghost this factory keeps shipping).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { createCountdown, STEPS } from '../src/countdown';

/** A hand-cranked clock: no waiting, and every branch is reachable. */
function clock() {
  let fn: (() => void) | null = null;
  return {
    setInterval: (f: () => void) => {
      fn = f;
      return 1;
    },
    clearInterval: () => {
      fn = null;
    },
    tick(n = 1) {
      for (let i = 0; i < n; i++) fn?.();
    },
    live: () => fn !== null,
  };
}

let host: HTMLElement;
beforeEach(() => {
  document.body.innerHTML = '<div id="felt"></div>';
  host = document.querySelector<HTMLElement>('#felt')!;
});

describe('counting down', () => {
  it('shows 3 immediately, then 2, 1, GO — and starts the match once', () => {
    const c = clock();
    const steps: string[] = [];
    let done = 0;

    createCountdown({
      container: host,
      onStep: (s) => steps.push(s),
      onDone: () => done++,
      setInterval: c.setInterval,
      clearInterval: c.clearInterval,
    });

    // The first beat is synchronous: waiting 620ms to show "3" would read as a
    // hang on the very first frame of the game.
    expect(steps).toEqual(['3']);
    expect(done).toBe(0);

    c.tick(3);
    expect(steps).toEqual([...STEPS]);
    expect(done).toBe(0); // GO is on screen, but has not had its beat yet

    c.tick();
    expect(done).toBe(1);
  });

  it('stops its timer and removes itself once GO has landed', () => {
    const c = clock();
    const cd = createCountdown({
      container: host,
      onStep: () => {},
      onDone: () => {},
      setInterval: c.setInterval,
      clearInterval: c.clearInterval,
    });

    c.tick(4);
    expect(cd.running()).toBe(false);
    expect(c.live()).toBe(false);
    // A leftover overlay would sit on top of the felt and eat every tap.
    expect(host.querySelector('.countdown')).toBeNull();
  });

  it('never fires onDone twice, however long it is ticked', () => {
    const c = clock();
    let done = 0;
    createCountdown({
      container: host,
      onStep: () => {},
      onDone: () => done++,
      setInterval: c.setInterval,
      clearInterval: c.clearInterval,
    });

    c.tick(20);
    expect(done).toBe(1);
  });
});

describe('cancelling', () => {
  it('tears down WITHOUT starting a match', () => {
    const c = clock();
    let done = 0;
    const cd = createCountdown({
      container: host,
      onStep: () => {},
      onDone: () => done++,
      setInterval: c.setInterval,
      clearInterval: c.clearInterval,
    });

    // The player walked back to the menu mid-count.
    cd.cancel();
    c.tick(10);

    // Starting a match on a screen that has been replaced is the ghost this
    // guards against.
    expect(done).toBe(0);
    expect(cd.running()).toBe(false);
    expect(host.querySelector('.countdown')).toBeNull();
  });

  it('is safe to call twice, and after it has already finished', () => {
    const c = clock();
    let done = 0;
    const cd = createCountdown({
      container: host,
      onStep: () => {},
      onDone: () => done++,
      setInterval: c.setInterval,
      clearInterval: c.clearInterval,
    });

    cd.cancel();
    cd.cancel();
    expect(done).toBe(0);

    const cd2 = createCountdown({
      container: host,
      onStep: () => {},
      onDone: () => done++,
      setInterval: c.setInterval,
      clearInterval: c.clearInterval,
    });
    c.tick(4);
    expect(done).toBe(1);
    cd2.cancel(); // already done — must not undo anything
    expect(done).toBe(1);
  });
});

describe('the overlay', () => {
  it('announces itself to a screen reader', () => {
    const c = clock();
    createCountdown({
      container: host,
      onStep: () => {},
      onDone: () => {},
      setInterval: c.setInterval,
      clearInterval: c.clearInterval,
    });
    const el = host.querySelector('.countdown')!;
    expect(el.getAttribute('role')).toBe('status');
    expect(el.getAttribute('aria-live')).toBe('assertive');
    expect(el.textContent).toBe('3');
  });
});
