/**
 * modes.test.ts — the three shapes a round can take.
 *
 * A mode changes the DECK SIZE, which makes it the most dangerous setting in the
 * game: if two peers ever disagree about it, they deal different numbers of
 * cards off the same seed and nothing looks wrong until the scores stop making
 * sense. So the rules here are pinned hard, and modeOf() is required to swallow
 * anything unknown rather than let it reach the deck generator.
 */

import { describe, expect, it } from 'vitest';
import {
  deckOf,
  DEFAULT_MODE,
  MODES,
  modeOf,
  pointsOf,
  roundsOf,
  type ModeId,
} from '../src/modes';
import { beginReveal, createGame, currentPot, resolve, submitBid, upcomingPrizes } from '../src/game';

const IDS: ModeId[] = ['classic', 'foresight', 'blitz'];

describe('the mode table', () => {
  it('offers three modes, and Classic is the default', () => {
    expect(MODES.map((m) => m.id)).toEqual(IDS);
    expect(DEFAULT_MODE).toBe('classic');
    expect(modeOf(DEFAULT_MODE).deck).toBe(13);
  });

  it('gives every mode a real deck, clock and blurb', () => {
    for (const m of MODES) {
      expect(m.deck).toBeGreaterThanOrEqual(5);
      expect(m.roundMs).toBeGreaterThan(0);
      expect(m.blurb.length).toBeGreaterThan(20);
    }
  });

  it('makes no two modes the same game', () => {
    // A mode has to pull a different lever, or it is a label. Compare the axes.
    const shapes = MODES.map((m) => `${m.deck}|${m.tiesCarry}|${m.lookahead}|${m.roundMs}`);
    expect(new Set(shapes).size).toBe(MODES.length);
  });
});

describe('modeOf — nothing unknown reaches the deck', () => {
  it('falls back to Classic for anything it does not recognise', () => {
    // These arrive from a snapshot, a URL and localStorage respectively. An
    // `undefined` reaching deckOf() would deal a match with no cards in it and
    // take the whole room down.
    for (const bad of [undefined, null, '', 'CLASSIC', 'chess', 42, {}]) {
      expect(modeOf(bad).id).toBe('classic');
    }
  });

  it('resolves each real id to itself', () => {
    for (const id of IDS) expect(modeOf(id).id).toBe(id);
  });
});

describe('deck, rounds and points follow the mode', () => {
  it('deals 1..deck, ascending', () => {
    expect(deckOf('classic')).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    expect(deckOf('blitz')).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('gives one round per card', () => {
    for (const id of IDS) expect(roundsOf(id)).toBe(deckOf(id).length);
  });

  it('totals the points on the table', () => {
    expect(pointsOf('classic')).toBe(91);
    expect(pointsOf('blitz')).toBe(28);
  });

  it('hands out a FRESH deck array each time', () => {
    // deckOf's result is mutated in place by the shuffle. A shared array would
    // mean the first match dealt quietly reorders every match after it.
    const a = deckOf('classic');
    a[0] = 99;
    expect(deckOf('classic')[0]).toBe(1);
  });
});

describe('a match takes its shape from its mode', () => {
  it('deals Blitz seven cards and seven prizes', () => {
    const g = createGame(1, 2, 'blitz');
    expect(g.mode).toBe('blitz');
    expect(g.prizes).toHaveLength(7);
    expect(g.hands[0]).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect([...g.prizes].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('ends a Blitz match after seven rounds', () => {
    const g = createGame(5, 2, 'blitz');
    for (let r = 0; r < 7; r++) {
      submitBid(g, 0, g.hands[0][0]);
      submitBid(g, 1, g.hands[1][g.hands[1].length - 1]);
      beginReveal(g);
      resolve(g);
    }
    expect(g.phase).toBe('over');
    expect(g.history).toHaveLength(7);
  });

  it('validates a mode that arrives from somewhere untrusted', () => {
    const g = createGame(1, 2, 'nonsense' as ModeId);
    expect(g.mode).toBe('classic');
    expect(g.prizes).toHaveLength(13);
  });
});

describe('ties: Classic carries the pot, Blitz burns it', () => {
  it('carries in Classic, so a stand-off gets rich', () => {
    const g = createGame(1, 2, 'classic');
    const first = g.prizes[0];
    submitBid(g, 0, 5);
    submitBid(g, 1, 5);
    beginReveal(g);
    resolve(g);

    expect(g.carry).toBe(first);
    expect(currentPot(g)).toBe(first + g.prizes[1]);
  });

  it('VOIDS the prize in Blitz, so a tie is a weapon', () => {
    const g = createGame(1, 2, 'blitz');
    submitBid(g, 0, 5);
    submitBid(g, 1, 5);
    beginReveal(g);
    resolve(g);

    // Nothing carries: the prize is simply gone. That inverts what a tie is FOR
    // — you match on purpose to burn a pot your rival was about to take.
    expect(g.carry).toBe(0);
    expect(g.history[0].winner).toBeNull();
    expect(currentPot(g)).toBe(g.prizes[1]);
  });

  it('leaves Blitz points unaccounted for exactly when a tie burned them', () => {
    const g = createGame(9, 2, 'blitz');
    let burned = 0;
    for (let r = 0; r < 7; r++) {
      const pot = currentPot(g);
      // Both play their lowest: every round ties, so every prize burns.
      submitBid(g, 0, g.hands[0][0]);
      submitBid(g, 1, g.hands[1][0]);
      beginReveal(g);
      const t = resolve(g)!;
      if (t.winner === null) burned += pot;
    }
    expect(g.scores).toEqual([0, 0]);
    expect(g.carry).toBe(0);
    expect(burned).toBe(pointsOf('blitz'));
  });
});

describe('Foresight shows what is coming', () => {
  it('shows the next two prizes, and nothing in Classic or Blitz', () => {
    expect(upcomingPrizes(createGame(1, 2, 'classic'))).toEqual([]);
    expect(upcomingPrizes(createGame(1, 2, 'blitz'))).toEqual([]);

    const g = createGame(1, 2, 'foresight');
    expect(upcomingPrizes(g)).toEqual([g.prizes[1], g.prizes[2]]);
  });

  it('is derived from the seed, never transmitted', () => {
    // Both peers already hold the whole prize order — the lookahead is just a
    // window onto it, so it costs no bytes and cannot desync.
    const host = createGame(777, 2, 'foresight');
    const peer = createGame(777, 2, 'foresight');
    expect(upcomingPrizes(host)).toEqual(upcomingPrizes(peer));
  });

  it('runs out gracefully at the end of the deck', () => {
    const g = createGame(1, 2, 'foresight');
    g.round = 12; // the last prize: there is nothing after it
    expect(upcomingPrizes(g)).toEqual([]);
    g.round = 11;
    expect(upcomingPrizes(g)).toHaveLength(1);
  });

  it('deals the same deck as Classic — only the information differs', () => {
    // Foresight must be Classic plus knowledge, not a different game. If the
    // decks diverged, the mode would be doing two things at once.
    const classic = createGame(4242, 2, 'classic');
    const fore = createGame(4242, 2, 'foresight');
    expect(fore.prizes).toEqual(classic.prizes);
  });
});
