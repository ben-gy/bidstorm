/**
 * bot.ts — the opponents you meet when you tap Play.
 *
 * Solo is the front door of this game, so the bots have to be worth beating.
 * They are built on the one strategy that actually works in a game like this:
 *
 *   RANK MATCHING. You always hold exactly as many cards as there are prizes
 *   left, so the k-th most valuable prize remaining and your k-th highest card
 *   correspond one-to-one. Spend the card whose rank matches the pot's rank.
 *
 * That is strong, and it is also the strategy a good human converges on, which
 * makes these bots feel like players rather than dice. Two refinements matter:
 *
 *  - The pot is ranked by VALUE, not by the prize card's face. A 3 carrying an
 *    18-point pot from two tied rounds is the biggest thing on the table and the
 *    bots treat it that way.
 *  - Every bot randomises a little. That is not a handicap — in a simultaneous
 *    game like this a perfectly predictable opponent is a solved one, and two
 *    pure rank-matchers would tie all thirteen rounds and carry all 91 points to
 *    the end. The noise is what makes them opponents.
 *
 * Every draw comes from the seeded RNG, in a fixed order, so a solo match is
 * reproducible from its seed — that is what makes the shared-seed challenge an
 * honest comparison rather than two different games.
 */

import { currentPot, ROUNDS, type GameState } from './game';
import { randInt, type Rng } from '@ben-gy/game-engine/rng';

export type Difficulty = 'casual' | 'sharp' | 'ruthless';

/** A bot's standing bias — what it does when the rank is ambiguous. */
export type Style = 'even' | 'greedy' | 'thrifty';

export interface BotProfile {
  name: string;
  style: Style;
}

/**
 * Table names, paired with a temperament so a four-handed game has texture
 * rather than three copies of the same opponent.
 */
export const BOT_PROFILES: readonly BotProfile[] = Object.freeze([
  { name: 'Vex', style: 'greedy' },
  { name: 'Juno', style: 'thrifty' },
  { name: 'Marlow', style: 'even' },
  { name: 'Sable', style: 'greedy' },
  { name: 'Pike', style: 'thrifty' },
]);

export const DIFFICULTY_LABELS: Record<Difficulty, string> = {
  casual: 'Casual',
  sharp: 'Sharp',
  ruthless: 'Ruthless',
};

export const DIFFICULTY_BLURBS: Record<Difficulty, string> = {
  casual: 'Loose with their cards. A good place to learn what a pot is worth.',
  sharp: 'Matches value to value. Punishes a wasted 13.',
  ruthless: 'Reads the pot, counts your hand, and dumps its junk on your prizes.',
};

const STYLE_BIAS: Record<Style, number> = {
  even: 0,
  // Overpays for a pot it wants, and runs out of top cards early.
  greedy: 1,
  // Hoards the big cards for a big prize that may never come.
  thrifty: -1,
};

/**
 * How far this difficulty is willing to stray from the rank-matched card.
 * `chance` is how often it strays at all.
 */
const NOISE: Record<Difficulty, { spread: number; chance: number }> = {
  casual: { spread: 3, chance: 0.75 },
  sharp: { spread: 1, chance: 0.5 },
  ruthless: { spread: 1, chance: 0.25 },
};

/** Prizes not yet turned over, including the one currently face up. */
export function remainingPrizes(g: GameState): number[] {
  return g.prizes.slice(g.round);
}

/**
 * The rank of the pot among what is still to come: 0 means nothing left is
 * bigger. Ranking by the POT rather than the prize card is what makes a bot
 * respect a pot that ties have inflated.
 */
export function potRank(g: GameState): number {
  const pot = currentPot(g);
  return remainingPrizes(g).filter((p) => p > pot).length;
}

/** Points still to be fought over, including whatever a tie is carrying. */
export function pointsLeft(g: GameState): number {
  return remainingPrizes(g).reduce((a, b) => a + b, 0) + g.carry;
}

/**
 * Pick a card for a bot. Never mutates the game — the caller commits it through
 * the same submitBid() path a human uses, so bots cannot cheat the rules even
 * by accident.
 */
export function botBid(g: GameState, player: number, diff: Difficulty, rng: Rng, style: Style = 'even'): number {
  const hand = g.hands[player];
  if (hand.length === 1) return hand[0];

  // The rank-matched card: as many cards left as prizes left, so the k-th
  // highest prize maps onto the k-th highest card.
  let idx = hand.length - 1 - potRank(g);

  idx += STYLE_BIAS[style];

  const { spread, chance } = NOISE[diff];
  if (rng() < chance) idx += randInt(rng, -spread, spread);

  if (diff === 'ruthless') {
    // The match is already won — there is no reason left to spend anything.
    const best = Math.max(...g.scores.filter((_, i) => i !== player));
    if (g.scores[player] > best + pointsLeft(g)) idx = 0;
  }

  return hand[Math.max(0, Math.min(hand.length - 1, idx))];
}

/** Fill in every bot seat for the current round. Seat 0 is always the human. */
export function botBidsForRound(
  g: GameState,
  diff: Difficulty,
  rng: Rng,
  styles: readonly Style[],
): { player: number; card: number }[] {
  const out: { player: number; card: number }[] = [];
  // Fixed seat order, one draw per bot per round: this is what keeps a seeded
  // solo match reproducible.
  for (let p = 1; p < g.n; p++) {
    if (g.round >= ROUNDS) break;
    out.push({ player: p, card: botBid(g, p, diff, rng, styles[p - 1] ?? 'even') });
  }
  return out;
}
