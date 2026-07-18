import { describe, it, expect } from 'vitest';
import { classifyRelease, type GestureThresholds } from '../src/engine/drag';

// The verified defaults from patterns/MOBILE_CONTROLS.md.
const T: GestureThresholds = { tapSlop: 3, swipeDist: 50, swipeVel: 0.5, swipeMaxMs: 250 };

describe('drag gesture classifier', () => {
  it('a release that never dragged is always a tap', () => {
    expect(classifyRelease(0, 0, 40, false, T).kind).toBe('tap');
    // Even a fast, far pointer path is a TAP if it never crossed the drag slop —
    // tap must stay a first-class action so drag never eats the click.
    expect(classifyRelease(200, 0, 10, false, T).kind).toBe('tap');
  });

  it('a dragged release that ends near the start is a tap (grab and return)', () => {
    expect(classifyRelease(2, 1, 400, true, T).kind).toBe('tap');
  });

  it('a slow, far drag is a drag (not a swipe)', () => {
    // 120px over 600ms → 0.2 px/ms, under the 0.5 swipe velocity and over 250ms.
    const g = classifyRelease(120, 0, 600, true, T);
    expect(g.kind).toBe('drag');
  });

  it('a fast flick is a swipe with the dominant-axis direction', () => {
    expect(classifyRelease(80, 5, 100, true, T)).toEqual({ kind: 'swipe', dir: 'right' });
    expect(classifyRelease(-80, 5, 100, true, T)).toEqual({ kind: 'swipe', dir: 'left' });
    expect(classifyRelease(5, 80, 100, true, T)).toEqual({ kind: 'swipe', dir: 'down' });
    expect(classifyRelease(5, -80, 100, true, T)).toEqual({ kind: 'swipe', dir: 'up' });
  });

  it('a short but very fast flick still counts as a swipe (velocity path)', () => {
    // 30px over 20ms → 1.5 px/ms: under swipeDist but over swipeVel and quick.
    expect(classifyRelease(30, 0, 20, true, T).kind).toBe('swipe');
  });

  it('a far but slow drag past swipeMaxMs is a drag, never a swipe', () => {
    // 60px (over swipeDist) but 400ms (over swipeMaxMs) → drag.
    expect(classifyRelease(60, 0, 400, true, T).kind).toBe('drag');
  });

  it('locks the swipe to the dominant axis on a diagonal', () => {
    // dx dominates → horizontal even with meaningful dy.
    expect(classifyRelease(80, 40, 100, true, T)).toEqual({ kind: 'swipe', dir: 'right' });
    // dy dominates → vertical.
    expect(classifyRelease(40, 80, 100, true, T)).toEqual({ kind: 'swipe', dir: 'down' });
  });
});
