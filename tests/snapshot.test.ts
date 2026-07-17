/**
 * snapshot.test.ts — what goes over the wire.
 *
 * Two things are being defended here.
 *
 *  1. A LIVE BID IS NOT IN THE BYTES. The whole game is that bids are secret
 *     until they are turned over. Sending everyone's card and merely hiding it
 *     in the UI would put every opponent's bid one devtools console away, and
 *     nobody would ever find out. So the masking is asserted on the payload
 *     itself, not on the screen.
 *
 *  2. A SNAPSHOT IS ENOUGH TO BE WHOLE. A peer joining late, missing a packet,
 *     or being promoted to host rebuilds its entire state from one message. If
 *     the round-trip loses anything, that peer is quietly wrong rather than
 *     visibly broken.
 */

import { describe, expect, it } from 'vitest';
import {
  beginReveal,
  createGame,
  fromSnapshot,
  resolve,
  submitBid,
  toSnapshot,
  type GameState,
} from '../src/game';

function playRound(g: GameState, cards: number[]): void {
  cards.forEach((c, p) => submitBid(g, p, c));
  beginReveal(g);
  resolve(g);
}

/** What actually reaches the other browser: JSON, not a live object. */
const overTheWire = (g: GameState, forPlayer: number | null): GameState =>
  fromSnapshot(JSON.parse(JSON.stringify(toSnapshot(g, forPlayer))));

describe('secrecy while a round is open', () => {
  it('does NOT put another player\'s live card in the payload', () => {
    const g = createGame(1, 3);
    submitBid(g, 0, 11);
    submitBid(g, 1, 4);

    const snap = toSnapshot(g, 1); // the snapshot addressed to player 1
    expect(snap.b[1]).toBe(4); // their own card comes back to them
    expect(snap.b[0]).toBeNull(); // player 0's does NOT
    expect(JSON.stringify(snap)).not.toContain('11');
  });

  it('still says WHO has committed, so the wait has visible progress', () => {
    const g = createGame(1, 3);
    submitBid(g, 0, 11);
    submitBid(g, 1, 4);

    const snap = toSnapshot(g, 1);
    // "Committed" is public; the card is not. That distinction is the whole
    // reason `in` exists separately from `b`.
    expect(snap.in).toEqual([true, true, false]);
  });

  it('hides every card from a spectator, including from itself', () => {
    const g = createGame(1, 2);
    submitBid(g, 0, 11);
    const snap = toSnapshot(g, null);
    expect(snap.b).toEqual([null, null]);
    expect(snap.in).toEqual([true, false]);
  });

  it('reveals everything the moment the cards are face up', () => {
    const g = createGame(1, 3);
    submitBid(g, 0, 11);
    submitBid(g, 1, 4);
    submitBid(g, 2, 9);
    beginReveal(g);

    // One broadcast, everyone sees the same cards at the same instant.
    const snap = toSnapshot(g, null);
    expect(snap.b).toEqual([11, 4, 9]);
  });

  it('never hides a past round — the history is public by the rules', () => {
    const g = createGame(1, 2);
    playRound(g, [11, 4]);
    submitBid(g, 0, 3);

    const snap = toSnapshot(g, 1);
    expect(snap.h[0].bids).toEqual([11, 4]);
    expect(snap.b[0]).toBeNull(); // the live round is still secret
  });
});

describe('round-trip', () => {
  it('rebuilds an in-progress match exactly', () => {
    const g = createGame(1234, 3);
    playRound(g, [11, 4, 9]);
    playRound(g, [13, 13, 1]); // a tie, so the carry has to survive too
    submitBid(g, 2, 5);

    const back = overTheWire(g, 2);
    expect(back.seed).toBe(g.seed);
    expect(back.n).toBe(g.n);
    expect(back.round).toBe(g.round);
    expect(back.phase).toBe(g.phase);
    expect(back.scores).toEqual(g.scores);
    expect(back.carry).toBe(g.carry);
    expect(back.history).toEqual(g.history);
    expect(back.gone).toEqual(g.gone);
  });

  it('re-derives the prize order from the seed rather than sending it', () => {
    const g = createGame(4242, 2);
    playRound(g, [11, 4]);

    const back = overTheWire(g, 0);
    expect(back.prizes).toEqual(g.prizes);
    // Thirteen numbers that never need to be transmitted, every round.
    expect(Object.keys(toSnapshot(g, 0))).not.toContain('prizes');
  });

  it('re-derives every hand from the history', () => {
    const g = createGame(1234, 3);
    playRound(g, [11, 4, 9]);
    playRound(g, [2, 13, 1]);

    const back = overTheWire(g, 1);
    // Hands are not sent either — they are whatever is left after what was
    // played, which the history already records.
    expect(back.hands).toEqual(g.hands);
  });

  it('survives a finished match, so the results screen renders from it', () => {
    const g = createGame(99, 2);
    for (let r = 0; r < 13; r++) playRound(g, [g.hands[0][g.hands[0].length - 1], g.hands[1][0]]);
    expect(g.phase).toBe('over');

    // This is the path a spectator and an abandoned seat take to the results
    // table: they never ran the sim, they only ever received this.
    const back = overTheWire(g, 1);
    expect(back.phase).toBe('over');
    expect(back.history).toHaveLength(13);
    expect(back.scores).toEqual(g.scores);
  });

  it('stays small enough to send every round', () => {
    const g = createGame(1, 6);
    for (let r = 0; r < 13; r++) playRound(g, g.hands.map((h) => h[0]));
    // A full six-player match, fully played out, is the biggest this ever gets.
    expect(JSON.stringify(toSnapshot(g, null)).length).toBeLessThan(2500);
  });
});
