/**
 * analysis.test.ts — "what everyone missed".
 *
 * The results screen makes a strong claim to every player: this round was worth
 * exactly this card to you. That claim is only honest because bids are
 * SIMULTANEOUS — the rest of the table is fixed no matter what you did, so the
 * cheapest card beating everyone else's bid really is the right answer in
 * hindsight. These tests pin that arithmetic down, because a results screen that
 * lies to a player is worse than one that says nothing.
 *
 * The prize order is set by hand here rather than drawn from a seed: the point
 * is the arithmetic, and a named prize makes a failure readable.
 */

import { describe, expect, it } from 'vitest';
import {
  beginReveal,
  createGame,
  report,
  reports,
  resolve,
  submitBid,
  type GameState,
} from '../src/game';

function playRound(g: GameState, cards: number[]): void {
  cards.forEach((c, p) => submitBid(g, p, c));
  beginReveal(g);
  resolve(g);
}

/** A two-hander with a prize order we choose. */
function rigged(prizes: number[]): GameState {
  const g = createGame(1, 2);
  g.prizes = prizes;
  return g;
}

describe('overspend — won it, but paid too much', () => {
  it('measures the winning bid against the cheapest card that would have won', () => {
    const g = rigged([5, 10, 1, 2, 3, 4, 6, 7, 8, 9, 11, 12, 13]);
    playRound(g, [13, 2]); // takes the 5 with a King, over a 2

    const r = report(g, 0);
    // A 3 would have taken it just as well. Ten pips, thrown away.
    expect(r.notes[0].cheapest).toBe(3);
    expect(r.notes[0].overspend).toBe(10);
    expect(r.wasted).toBe(10);
    expect(r.taken).toBe(1);
    expect(r.missed).toBe(0);
  });

  it('calls a bid that won by exactly one the perfect price', () => {
    const g = rigged([5, 10, 1, 2, 3, 4, 6, 7, 8, 9, 11, 12, 13]);
    playRound(g, [3, 2]);

    const r = report(g, 0);
    expect(r.notes[0].overspend).toBe(0);
    expect(r.wasted).toBe(0);
  });
});

describe('missed — a card in hand would have taken it', () => {
  it('counts the whole pot as missed when a winning card was held back', () => {
    const g = rigged([5, 10, 1, 2, 3, 4, 6, 7, 8, 9, 11, 12, 13]);
    playRound(g, [13, 2]);
    playRound(g, [1, 9]); // player 0 dumps a 1 on the 10 and loses it

    const r = report(g, 0);
    // They were still holding 10, 11 and 12. The 10 was the cheapest that
    // cleared a 9, and it would have won ten points.
    expect(r.notes[1].cheapest).toBe(10);
    expect(r.notes[1].missed).toBe(10);
    expect(r.missed).toBe(10);
  });

  it('does not blame a player who was holding nothing that could win', () => {
    const g = rigged([5, 10, 1, 2, 3, 4, 6, 7, 8, 9, 11, 12, 13]);
    playRound(g, [13, 2]); // player 1 loses to a King it could never beat

    const r = report(g, 1);
    expect(r.notes[0].cheapest).toBeNull();
    expect(r.notes[0].missed).toBe(0);
  });

  it('counts a TIE as missed — matching the top bid still lost you the pot', () => {
    const g = rigged([5, 10, 1, 2, 3, 4, 6, 7, 8, 9, 11, 12, 13]);
    playRound(g, [7, 7]);

    for (const p of [0, 1]) {
      const r = report(g, p);
      // Nobody won it, and both of them were holding an 8 that would have.
      expect(r.notes[0].cheapest).toBe(8);
      expect(r.notes[0].missed).toBe(5);
      expect(r.taken).toBe(0);
    }
  });

  it('measures a missed round against the CARRIED pot, not the prize card', () => {
    const g = rigged([5, 10, 1, 2, 3, 4, 6, 7, 8, 9, 11, 12, 13]);
    playRound(g, [13, 13]); // both burn a King; the 5 carries
    playRound(g, [1, 9]); // the "10" is really worth 15, and p0 dumps a 1 on it

    const r = report(g, 0);
    expect(g.history[1].pot).toBe(15);
    // The cost of a missed round is what it was actually worth, not the number
    // printed on the prize card.
    expect(r.notes[1].cheapest).toBe(10);
    expect(r.notes[1].missed).toBe(15);
    // Round 0 is NOT blamed on it: a tie at 13 is the one bid nothing beats, so
    // there was no card it could have played instead.
    expect(r.notes[0].missed).toBe(0);
    expect(r.missed).toBe(15);
  });
});

describe('the report as a whole', () => {
  it('accounts for every round, for every player', () => {
    const g = rigged([5, 10, 1, 2, 3, 4, 6, 7, 8, 9, 11, 12, 13]);
    playRound(g, [13, 2]);
    playRound(g, [1, 9]);

    const all = reports(g);
    expect(all).toHaveLength(2);
    for (const r of all) expect(r.notes).toHaveLength(2);
    expect(all.map((r) => r.player)).toEqual([0, 1]);
  });

  it('reconstructs each round from the hand held AT THAT ROUND, not the final one', () => {
    const g = rigged([13, 12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    playRound(g, [10, 11]); // p0 loses the 13; it was holding 11,12,13
    playRound(g, [13, 1]); // p0 takes the 12 with the King

    const r = report(g, 0);
    // Round 0: 12 was the cheapest card over an 11 — and p0 still had it then.
    expect(r.notes[0].cheapest).toBe(12);
    expect(r.notes[0].missed).toBe(13);
    // Round 1: the 12 is gone by now, so the King is judged against what was
    // actually left, and a 2 would have done.
    expect(r.notes[1].cheapest).toBe(2);
    expect(r.notes[1].overspend).toBe(11);
  });

  it('gives a flawless line no waste at all', () => {
    const g = rigged([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    // p0 always answers p1's lowest card with the next one up: it wins every
    // round it plays, and never by more than a single pip.
    for (let r = 0; r < 12; r++) playRound(g, [g.hands[0][1], g.hands[1][0]]);

    const r0 = report(g, 0);
    expect(r0.taken).toBe(12);
    expect(r0.wasted).toBe(0);
    expect(r0.missed).toBe(0);
  });
});
