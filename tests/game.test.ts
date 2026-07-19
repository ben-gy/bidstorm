/**
 * game.test.ts — the rules.
 *
 * Everything else in Bidstorm is a view over game.ts, so this is where the game
 * is actually specified: who wins a round, what a tie does to the pot, that a
 * card really is gone once played, and that a match always ends with all 91
 * points accounted for.
 */

import { describe, expect, it } from 'vitest';
import { makeRng } from '@ben-gy/game-engine/rng';
import {
  allIn,
  autoBidRest,
  beginReveal,
  canBid,
  createGame,
  currentPot,
  currentPrize,
  FULL_HAND,
  handAt,
  MAX_PLAYERS,
  resolve,
  ROUNDS,
  standings,
  submitBid,
  TOTAL_POINTS,
  trickWinner,
  winners,
  type GameState,
} from '../src/game';

/** Play one round with the given cards, turning them over and scoring them. */
function playRound(g: GameState, cards: number[]): void {
  cards.forEach((c, p) => submitBid(g, p, c));
  beginReveal(g);
  resolve(g);
}

describe('the deal', () => {
  it('gives every player the same thirteen cards', () => {
    const g = createGame(1, 4);
    for (const hand of g.hands) expect(hand).toEqual([...FULL_HAND]);
  });

  it('puts all thirteen prizes out, exactly once each', () => {
    const g = createGame(99, 2);
    expect([...g.prizes].sort((a, b) => a - b)).toEqual([...FULL_HAND]);
  });

  it('refuses a table that is too small or too big', () => {
    expect(() => createGame(1, 1)).toThrow(/outside/);
    expect(() => createGame(1, MAX_PLAYERS + 1)).toThrow(/outside/);
  });

  it('starts every seat level — there is no luck in what you hold', () => {
    // The card-game equivalent of the turn-0 fairness check: nobody may open
    // with an advantage, so the ONLY asymmetry is the prize order everyone
    // faces together.
    for (let seed = 0; seed < 50; seed++) {
      const g = createGame(seed, 4);
      expect(new Set(g.hands.map((h) => h.join(',')))).toHaveProperty('size', 1);
      expect(g.scores).toEqual([0, 0, 0, 0]);
    }
  });
});

describe('bidding', () => {
  it('accepts a card in hand and refuses one that is not', () => {
    const g = createGame(1, 2);
    expect(canBid(g, 0, 7)).toBe(true);
    expect(submitBid(g, 0, 7)).toBe(true);
    expect(submitBid(g, 1, 99)).toBe(false);
  });

  it('refuses a second bid from the same player in one round', () => {
    const g = createGame(1, 2);
    submitBid(g, 0, 7);
    expect(submitBid(g, 0, 8)).toBe(false);
    expect(g.bids[0]).toBe(7);
  });

  it('keeps the card in hand until the reveal, so a commit leaks nothing', () => {
    const g = createGame(1, 2);
    submitBid(g, 0, 7);
    // A peer that removed the card on commit would be broadcasting which card
    // it was to anyone reading the hand.
    expect(g.hands[0]).toContain(7);
  });

  it('does not resolve until everyone is in', () => {
    const g = createGame(1, 3);
    submitBid(g, 0, 5);
    submitBid(g, 1, 6);
    expect(allIn(g)).toBe(false);
    expect(beginReveal(g)).toBe(false);
    expect(resolve(g)).toBeNull();
  });

  it('refuses to score cards that are still face down', () => {
    const g = createGame(1, 2);
    submitBid(g, 0, 5);
    submitBid(g, 1, 6);
    // The cards must be turned over before they count — that gap is a real
    // state, not an animation.
    expect(resolve(g)).toBeNull();
    expect(g.scores).toEqual([0, 0]);
  });
});

describe('winning a round', () => {
  it('gives the pot to the highest bid and burns every card played', () => {
    const g = createGame(1, 2);
    const prize = currentPrize(g)!;
    playRound(g, [9, 4]);

    expect(g.scores[0]).toBe(prize);
    expect(g.scores[1]).toBe(0);
    expect(g.hands[0]).not.toContain(9);
    expect(g.hands[1]).not.toContain(4);
    expect(g.hands[0]).toHaveLength(12);
  });

  it('carries the pot when the top bid is tied, and awards it next round', () => {
    const g = createGame(1, 2);
    const first = g.prizes[0];
    playRound(g, [10, 10]);

    expect(g.scores).toEqual([0, 0]);
    expect(g.carry).toBe(first);
    // The next round is worth both — this is how a 3 becomes a 24.
    expect(currentPot(g)).toBe(first + g.prizes[1]);

    playRound(g, [9, 2]);
    expect(g.scores[0]).toBe(first + g.prizes[1]);
    expect(g.carry).toBe(0);
  });

  it('stacks carries across several tied rounds', () => {
    const g = createGame(1, 2);
    playRound(g, [13, 13]);
    playRound(g, [12, 12]);
    expect(g.carry).toBe(g.prizes[0] + g.prizes[1]);
    playRound(g, [11, 1]);
    expect(g.scores[0]).toBe(g.prizes[0] + g.prizes[1] + g.prizes[2]);
  });

  it('gives a three-way top tie to nobody', () => {
    const g = createGame(1, 3);
    playRound(g, [8, 8, 3]);
    expect(g.scores).toEqual([0, 0, 0]);
    expect(g.history[0].winner).toBeNull();
  });

  it('is only a tie at the TOP — a tie underneath is irrelevant', () => {
    expect(trickWinner([9, 4, 4])).toBe(0);
    expect(trickWinner([9, 9, 4])).toBeNull();
    expect(trickWinner([1, 2, 3])).toBe(2);
  });
});

describe('a full match', () => {
  it('ends after thirteen rounds with every point accounted for', () => {
    const g = createGame(7, 2);
    for (let r = 0; r < ROUNDS; r++) {
      expect(g.phase).toBe('bidding');
      // Player 0 spends top-down, player 1 bottom-up.
      playRound(g, [g.hands[0][g.hands[0].length - 1], g.hands[1][0]]);
    }
    expect(g.phase).toBe('over');
    expect(g.round).toBe(ROUNDS);
    expect(g.history).toHaveLength(ROUNDS);
    expect(g.hands.every((h) => h.length === 0)).toBe(true);

    // Conservation: every point either sits on a scoreboard or is still riding
    // on a carry. Points can never be created or quietly lost.
    expect(g.scores.reduce((a, b) => a + b, 0) + g.carry).toBe(TOTAL_POINTS);
  });

  it('conserves every point across any line of play, on any seed', () => {
    for (let seed = 0; seed < 60; seed++) {
      const g = createGame(seed, 3);
      const rng = makeRng(seed);
      for (let r = 0; r < ROUNDS; r++) {
        playRound(
          g,
          g.hands.map((h) => h[Math.floor(rng() * h.length)]),
        );
      }
      expect(g.scores.reduce((a, b) => a + b, 0) + g.carry).toBe(TOTAL_POINTS);
    }
  });

  it('makes it IMPOSSIBLE for one player to take all thirteen', () => {
    // Both players hold every card, so whoever plays the 13 cannot be beaten
    // that round — and both of them hold a 13. A clean sweep is not merely
    // unlikely, it is arithmetically unavailable, and any test that assumes one
    // is testing a game other than this one.
    const g = createGame(7, 2);
    for (let r = 0; r < ROUNDS; r++) {
      playRound(g, [g.hands[0][g.hands[0].length - 1], g.hands[1][0]]);
    }
    const swept = g.history.filter((t) => t.winner === 0).length;
    expect(swept).toBeLessThan(ROUNDS);
    expect(g.history.some((t) => t.winner === null)).toBe(true);
  });

  it('leaves points unclaimed only if the LAST round ties', () => {
    const g = createGame(7, 2);
    for (let r = 0; r < ROUNDS; r++) playRound(g, [g.hands[0][0], g.hands[1][0]]);
    // Two mirror players tie all thirteen rounds; the whole pot carries off the
    // end of the game and nobody scores a thing.
    expect(g.phase).toBe('over');
    expect(g.scores).toEqual([0, 0]);
    expect(g.carry).toBe(TOTAL_POINTS);
  });

  it('ranks the table, sharing a rank on a tie', () => {
    const g = createGame(3, 3);
    g.scores = [20, 40, 20];
    const s = standings(g);
    expect(s.map((x) => x.player)).toEqual([1, 0, 2]);
    expect(s.map((x) => x.rank)).toEqual([1, 2, 2]);
    expect(winners(g)).toEqual([1]);
  });

  it('reports every player on the top score when the match itself draws', () => {
    const g = createGame(3, 3);
    g.scores = [30, 30, 10];
    expect(winners(g)).toEqual([0, 1]);
  });
});

describe('nothing waits forever', () => {
  it('plays the lowest card for anyone who did not act', () => {
    const g = createGame(1, 3);
    submitBid(g, 1, 12);
    const forced = autoBidRest(g);

    // A player who left, a locked phone and a friend who is thinking too long
    // are all the same survivable thing.
    expect(forced).toEqual([0, 2]);
    expect(g.bids).toEqual([1, 12, 1]);
    expect(allIn(g)).toBe(true);
  });

  it('forces the lowest card REMAINING, not the lowest card there ever was', () => {
    const g = createGame(1, 2);
    playRound(g, [1, 13]);
    autoBidRest(g);
    expect(g.bids[0]).toBe(2);
  });

  it('does nothing once the cards are already down', () => {
    const g = createGame(1, 2);
    submitBid(g, 0, 5);
    submitBid(g, 1, 6);
    beginReveal(g);
    expect(autoBidRest(g)).toEqual([]);
  });
});

describe('handAt — reconstructing a hand from the history', () => {
  it('gives back the full hand for round 0 and shrinks by one each round', () => {
    const g = createGame(1, 2);
    playRound(g, [5, 6]);
    playRound(g, [7, 8]);

    // The results screen depends on this: it re-derives what a player was
    // holding at any past round rather than storing thirteen snapshots of it.
    expect(handAt(g, 0, 0)).toEqual([...FULL_HAND]);
    expect(handAt(g, 0, 1)).toEqual(FULL_HAND.filter((c) => c !== 5));
    expect(handAt(g, 0, 2)).toEqual(FULL_HAND.filter((c) => c !== 5 && c !== 7));
    expect(handAt(g, 1, 2)).toEqual(FULL_HAND.filter((c) => c !== 6 && c !== 8));
  });
});
