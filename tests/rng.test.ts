/**
 * rng.test.ts — the P2P-sync determinism invariant.
 *
 * The prize order NEVER travels over the wire. The host broadcasts a seed and
 * every peer derives the same thirteen prizes in the same order from it. If that
 * ever stops being true, two players are looking at different games while
 * agreeing on the score — the worst possible failure, because nothing looks
 * broken until someone wins a prize the other player never saw.
 *
 * So this proves determinism at both levels: the shared RNG itself, and the deal
 * that game.ts builds out of it.
 */

import { describe, expect, it } from 'vitest';
import { hashSeed, makeRng, pick, randInt, shuffle } from '../src/engine/rng';
import { createGame, FULL_HAND } from '../src/game';

describe('makeRng — two peers, one seed', () => {
  it('produces an identical stream from the same seed', () => {
    const a = makeRng(12345);
    const b = makeRng(12345);
    const runA = Array.from({ length: 200 }, () => a());
    const runB = Array.from({ length: 200 }, () => b());
    expect(runA).toEqual(runB);
  });

  it('produces a different stream from a different seed', () => {
    const a = Array.from({ length: 20 }, makeRng(1));
    const b = Array.from({ length: 20 }, makeRng(2));
    expect(a).not.toEqual(b);
  });

  it('stays in [0, 1)', () => {
    const r = makeRng(7);
    for (let i = 0; i < 1000; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('hashes a string seed to the same number every time', () => {
    expect(hashSeed('ROOM-K7QP')).toBe(hashSeed('ROOM-K7QP'));
    expect(hashSeed('a')).not.toBe(hashSeed('b'));
  });

  it('shuffles identically for two peers, and leaves the input alone', () => {
    const src = [...FULL_HAND];
    const a = shuffle(makeRng(42), src);
    const b = shuffle(makeRng(42), src);
    expect(a).toEqual(b);
    expect(src).toEqual([...FULL_HAND]);
    expect([...a].sort((x, y) => x - y)).toEqual([...FULL_HAND]);
  });

  it('agrees on randInt and pick', () => {
    const a = makeRng(9);
    const b = makeRng(9);
    for (let i = 0; i < 50; i++) expect(randInt(a, 1, 13)).toBe(randInt(b, 1, 13));
    const c = makeRng(3);
    const d = makeRng(3);
    expect(pick(c, FULL_HAND)).toBe(pick(d, FULL_HAND));
  });

  it('keeps randInt inside its bounds', () => {
    const r = makeRng(11);
    for (let i = 0; i < 500; i++) {
      const v = randInt(r, 1, 13);
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(13);
    }
  });
});

describe('the deal is derived, never transmitted', () => {
  it('gives two peers on the same seed the identical prize order', () => {
    for (const seed of [0, 1, 42, 65535, 0xffffffff]) {
      const host = createGame(seed, 2);
      const peer = createGame(seed, 2);
      expect(host.prizes).toEqual(peer.prizes);
    }
  });

  it('does not depend on how many are at the table', () => {
    // The prize order is a property of the seed alone. If it drifted with the
    // player count, a peer that disagreed about the roster size would silently
    // deal itself a different game.
    const two = createGame(777, 2);
    const six = createGame(777, 6);
    expect(two.prizes).toEqual(six.prizes);
  });

  it('gives different seeds different deals', () => {
    const seen = new Set(
      Array.from({ length: 40 }, (_, s) => createGame(s * 7919 + 1, 2).prizes.join(',')),
    );
    // Not a strict guarantee, but 40 identical deals would mean the seed is
    // being ignored — which is exactly the bug worth catching here.
    expect(seen.size).toBeGreaterThan(35);
  });

  it('is a real permutation for every seed it is given', () => {
    for (let seed = 0; seed < 200; seed++) {
      const g = createGame(seed, 3);
      expect([...g.prizes].sort((a, b) => a - b)).toEqual([...FULL_HAND]);
    }
  });
});
