/**
 * bot.test.ts — the opponents you meet in the first five seconds.
 *
 * Solo is the front door, so a bot that plays badly is a bad game. The property
 * that matters most is that a bot always plays a card it ACTUALLY HOLDS: a
 * strategy that reaches past the end of its hand would throw `undefined` into
 * submitBid and stall the round forever, and it would only happen on the rare
 * late-game hand where the rank index runs off the edge.
 */

import { describe, expect, it } from 'vitest';
import {
  beginReveal,
  createGame,
  resolve,
  submitBid,
  ROUNDS,
  TOTAL_POINTS,
  type GameState,
} from '../src/game';
import { botBid, potRank, pointsLeft, remainingPrizes, BOT_PROFILES, type Difficulty } from '../src/bot';
import { makeRng } from '../src/engine/rng';

/** Run a whole solo match of bots-vs-bots and hand back the finished state. */
function autoMatch(seed: number, n: number, diff: Difficulty): GameState {
  const g = createGame(seed, n);
  const rng = makeRng(seed);
  for (let r = 0; r < ROUNDS; r++) {
    for (let p = 0; p < n; p++) {
      const card = botBid(g, p, diff, rng, BOT_PROFILES[p % BOT_PROFILES.length].style);
      // submitBid rejects a card that is not in hand, so a false here IS the bug.
      expect(submitBid(g, p, card), `seat ${p} played ${card} it does not hold`).toBe(true);
    }
    beginReveal(g);
    resolve(g);
  }
  return g;
}

describe('a bot always plays a card it holds', () => {
  it('never reaches past the end of its hand, across every difficulty and size', () => {
    for (const diff of ['casual', 'sharp', 'ruthless'] as Difficulty[]) {
      for (let n = 2; n <= 6; n++) {
        for (let seed = 0; seed < 12; seed++) {
          const g = autoMatch(seed * 31 + n, n, diff);
          expect(g.phase).toBe('over');
          expect(g.hands.every((h) => h.length === 0)).toBe(true);
        }
      }
    }
  });

  it('plays its last card when only one is left', () => {
    const g = createGame(1, 2);
    g.hands[0] = [6];
    g.round = 12;
    expect(botBid(g, 0, 'ruthless', makeRng(1))).toBe(6);
  });
});

describe('rank matching — the strategy the bots are built on', () => {
  it('ranks the pot among what is still to come, not among all thirteen', () => {
    const g = createGame(1, 2);
    g.prizes = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];

    // Round 0: the 1 is the smallest thing left, so twelve prizes beat it.
    expect(remainingPrizes(g)).toHaveLength(13);
    expect(potRank(g)).toBe(12);

    g.round = 12; // the 13 is the last prize standing
    expect(potRank(g)).toBe(0);
  });

  it('respects a pot that ties have inflated, not the prize card on the table', () => {
    const g = createGame(1, 2);
    g.prizes = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];
    g.carry = 40; // two tied rounds rolled into this one

    // A 3 carrying a 43-point pot is the biggest thing on the table, and a bot
    // that ranked the CARD would dump its junk on it.
    g.round = 2;
    expect(potRank(g)).toBe(0);
    expect(botBid(g, 0, 'ruthless', makeRng(5))).toBeGreaterThan(9);
  });

  it('spends its top card on the top prize and its junk on the bottom one', () => {
    // Averaged over many seeds, because every difficulty randomises on purpose.
    const forPrize = (prize: number): number => {
      let total = 0;
      const runs = 60;
      for (let i = 0; i < runs; i++) {
        const g = createGame(i, 2);
        g.prizes = [prize, ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13].filter((p) => p !== prize)];
        total += botBid(g, 0, 'sharp', makeRng(i));
      }
      return total / runs;
    };

    expect(forPrize(13)).toBeGreaterThan(11);
    expect(forPrize(1)).toBeLessThan(3);
    expect(forPrize(13)).toBeGreaterThan(forPrize(7));
    expect(forPrize(7)).toBeGreaterThan(forPrize(1));
  });

  it('counts what is still worth fighting over', () => {
    const g = createGame(1, 2);
    expect(pointsLeft(g)).toBe(TOTAL_POINTS);
    g.round = 13;
    g.carry = 5;
    expect(pointsLeft(g)).toBe(5);
  });
});

describe('difficulty is a real difference, not a label', () => {
  it('makes Ruthless beat Casual over a run of matches', () => {
    // Seat 0 plays ruthless, seat 1 plays casual, on the same deals.
    let ruthless = 0;
    let casual = 0;
    for (let seed = 0; seed < 60; seed++) {
      const g = createGame(seed * 17 + 3, 2);
      const rng = makeRng(seed);
      for (let r = 0; r < ROUNDS; r++) {
        submitBid(g, 0, botBid(g, 0, 'ruthless', rng, 'even'));
        submitBid(g, 1, botBid(g, 1, 'casual', rng, 'even'));
        beginReveal(g);
        resolve(g);
      }
      ruthless += g.scores[0];
      casual += g.scores[1];
    }
    // Not every match — a loose player gets lucky. But over sixty deals the
    // difficulty setting has to actually mean something.
    expect(ruthless).toBeGreaterThan(casual);
  });

  it('makes Casual stray further from the rank-matched card than Sharp', () => {
    const spread = (diff: Difficulty): number => {
      let total = 0;
      const runs = 200;
      for (let i = 0; i < runs; i++) {
        const g = createGame(i, 2);
        g.prizes = [7, 1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13];
        total += Math.abs(botBid(g, 0, diff, makeRng(i * 7 + 1)) - 7);
      }
      return total / runs;
    };
    expect(spread('casual')).toBeGreaterThan(spread('sharp'));
    expect(spread('sharp')).toBeGreaterThan(spread('ruthless'));
  });

  it('stops spending once Ruthless has the match mathematically won', () => {
    const g = createGame(1, 2);
    g.prizes = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];
    g.round = 11; // the 12 and 13 are all that is left: 25 points
    g.scores = [90, 0];
    g.hands = [
      [2, 13],
      [4, 5],
    ];
    // There is nothing left to buy. Spending the King here would be theatre.
    expect(botBid(g, 0, 'ruthless', makeRng(1))).toBe(2);
  });
});

describe('a solo match replays from its seed', () => {
  it('gives the identical match twice — which is what the shared deal promises', () => {
    const a = autoMatch(9182, 3, 'sharp');
    const b = autoMatch(9182, 3, 'sharp');
    expect(a.history).toEqual(b.history);
    expect(a.scores).toEqual(b.scores);
  });

  it('gives a different match on a different seed', () => {
    const a = autoMatch(1, 3, 'sharp');
    const b = autoMatch(2, 3, 'sharp');
    expect(a.history).not.toEqual(b.history);
  });
});

describe('bot profiles', () => {
  it('has a distinct name for every seat a table can hold', () => {
    expect(BOT_PROFILES.length).toBeGreaterThanOrEqual(5);
    expect(new Set(BOT_PROFILES.map((p) => p.name)).size).toBe(BOT_PROFILES.length);
  });

  it('mixes temperaments, so a full table is not three of the same opponent', () => {
    expect(new Set(BOT_PROFILES.slice(0, 3).map((p) => p.style)).size).toBeGreaterThan(1);
  });
});
