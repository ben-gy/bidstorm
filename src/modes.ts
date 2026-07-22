// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * modes.ts — the three shapes a round of Bidstorm can take.
 *
 * A mode has to change how the game PLAYS, not just a number on a menu. These
 * three pull on deliberately different levers, so no two of them feel like each
 * other:
 *
 *  - CLASSIC has you reacting to a prize you learn about the instant you must
 *    pay for it. Ties inflate a pot, so a stand-off is a jackpot.
 *  - FORESIGHT shows you the next two prizes. That is the same deck and the same
 *    scoring, and it is a different game: you stop reacting and start planning,
 *    because banking your K for the Q you can SEE coming is now a real line, and
 *    so is the trap of everyone else seeing it too.
 *  - BLITZ cuts the deck to seven and voids a tied prize instead of carrying it.
 *    Losing the pot mechanic inverts what a tie is FOR: in Classic you tie by
 *    accident and get rich; in Blitz you tie on purpose to burn a prize your
 *    rival was about to take. Fewer cards also means every one of them is a real
 *    decision, and the clock is short enough that you make it on instinct.
 *
 * The axes, so a fourth mode has to justify itself against them: information
 * (lookahead), deck size (rounds), scoring (ties carry or void), and clock.
 *
 * The HOST's pick is what the room plays. It travels frozen inside the round
 * start via rematch.ts's roundOpts — a setting each peer read from its own UI is
 * a setting two peers can disagree about, and since a mode changes the deck size
 * they would then be playing genuinely different games on the same seed.
 */

export type ModeId = 'classic' | 'foresight' | 'blitz';

export interface Mode {
  id: ModeId;
  name: string;
  /** One line, shown under the picker. Says what CHANGES, not what's nice. */
  blurb: string;
  /** Highest card in the deck. Also the number of prizes, and the hand size. */
  deck: number;
  /** Does a tied top bid carry the pot into the next round, or void the prize? */
  tiesCarry: boolean;
  /** How many upcoming prizes are face up beyond the current one. */
  lookahead: number;
  /** How long a player has to commit before the host plays their lowest card. */
  roundMs: number;
}

export const MODES: readonly Mode[] = Object.freeze([
  {
    id: 'classic',
    name: 'Classic',
    blurb: 'Thirteen prizes in the dark. Tie for the lead and the pot carries — stand-offs get rich.',
    deck: 13,
    tiesCarry: true,
    lookahead: 0,
    roundMs: 30_000,
  },
  {
    id: 'foresight',
    name: 'Foresight',
    blurb: 'The next two prizes are face up. Stop reacting and start planning — so does everyone else.',
    deck: 13,
    tiesCarry: true,
    lookahead: 2,
    roundMs: 30_000,
  },
  {
    id: 'blitz',
    name: 'Blitz',
    blurb: 'Seven cards, twelve seconds, and a tie burns the prize instead of banking it.',
    deck: 7,
    tiesCarry: false,
    lookahead: 0,
    roundMs: 12_000,
  },
]);

export const DEFAULT_MODE: ModeId = 'classic';

/**
 * Resolve a mode id that may have come off the wire, out of localStorage, or out
 * of a URL — i.e. somewhere that is not this file.
 *
 * An unknown id falls back to Classic rather than reaching the deck generator as
 * `undefined`, where it would produce a game with no prizes and no hand and take
 * the whole room down with it.
 */
export function modeOf(id: unknown): Mode {
  return MODES.find((m) => m.id === id) ?? MODES[0];
}

/** The hand every player starts with, and the prizes fought over. 1..deck. */
export function deckOf(id: unknown): number[] {
  const { deck } = modeOf(id);
  return Array.from({ length: deck }, (_, i) => i + 1);
}

/** Rounds in a match of this mode. Same as the deck size — one card per prize. */
export function roundsOf(id: unknown): number {
  return modeOf(id).deck;
}

/** Every point available across a whole match of this mode. */
export function pointsOf(id: unknown): number {
  return deckOf(id).reduce((a, b) => a + b, 0);
}
