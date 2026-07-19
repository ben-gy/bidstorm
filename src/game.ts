/**
 * game.ts — the rules of Bidstorm, as a pure simulation.
 *
 * No DOM, no network, no randomness beyond the seed it is handed. That is
 * deliberate: the host runs this to decide what happened, the bots read it to
 * decide what to play, the results screen reads it to explain itself, and the
 * tests drive it directly. Everything else in the game is a view over this file.
 *
 * The rules, in full:
 *  - The prizes (1..N, where N is the mode's deck) come out in a seeded random
 *    order.
 *  - Every player starts holding the SAME N cards, 1..N.
 *  - Each round everyone commits one card in secret. Highest bid takes the pot.
 *  - A tie for highest wins nothing. Whether the pot then CARRIES into the next
 *    round or is voided outright is the mode's call (see modes.ts).
 *  - Cards played are gone. After N rounds, most points wins.
 *
 * The total on the table is fixed by the deck — 91 (1+2+…+13) in Classic —
 * whoever takes it, unless a mode voids tied prizes.
 *
 * The mode lives on the state rather than in a module global because two peers
 * must be able to disagree about nothing at all: the state carries its own rules
 * across the wire, so a snapshot rebuilds into the same game it left.
 */

import { deckOf, DEFAULT_MODE, modeOf, type ModeId } from './modes';

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 6;

/** Classic's length. Mode-agnostic code should read `g.prizes.length`. */
export const ROUNDS = 13;

/** Classic's hand. Mode-agnostic code should read `deckOf(g.mode)`. */
export const FULL_HAND: readonly number[] = Object.freeze(deckOf('classic'));

/** Every point available across a whole CLASSIC match. See modes.pointsOf. */
export const TOTAL_POINTS = FULL_HAND.reduce((a, b) => a + b, 0);

export type Phase = 'bidding' | 'reveal' | 'over';

/** One completed round, kept forever so the results table can explain it. */
export interface Trick {
  /** The prize card that was face up. */
  prize: number;
  /** What it was actually worth — the prize plus anything a tie carried in. */
  pot: number;
  /** Each player's committed card, by player index. */
  bids: number[];
  /** Who took it, or null when the highest bid was tied and the pot carried. */
  winner: number | null;
}

export interface GameState {
  seed: number;
  /** The rules this match is played under. Fixed for the match, and on the wire. */
  mode: ModeId;
  /** Number of seats. Fixed for the match. */
  n: number;
  /** The prize order, derived from the seed. Never sent over the wire. */
  prizes: number[];
  /** Index of the round being played, 0..12. Equals ROUNDS once the match ends. */
  round: number;
  phase: Phase;
  /** Remaining cards per player, ascending. */
  hands: number[][];
  /** This round's commits. null = has not committed yet. */
  bids: (number | null)[];
  scores: number[];
  /** Points rolled over from tied rounds, waiting to be won. */
  carry: number;
  /** Completed rounds, in order. */
  history: Trick[];
  /** Seats whose player has left. They still score; the host bids for them. */
  gone: boolean[];
}

/**
 * Deal a match. The prize ORDER is the only random thing in Bidstorm, and it
 * comes from the shared seed — so peers never transmit it, they derive it.
 *
 * The shuffle is inlined rather than taken from rng.ts's `shuffle` so that this
 * module stays free of engine imports and the deal is trivially reproducible in
 * a test from a seed alone.
 */
export function createGame(seed: number, n: number, mode: ModeId = DEFAULT_MODE): GameState {
  if (n < MIN_PLAYERS || n > MAX_PLAYERS) {
    throw new Error(`bidstorm: ${n} players is outside ${MIN_PLAYERS}..${MAX_PLAYERS}`);
  }
  // Validated rather than trusted: `mode` can arrive from a snapshot, a lobby
  // gossip, or localStorage, and an unknown id must land on Classic instead of
  // reaching deckOf() as undefined and dealing a match with no cards in it.
  const id = modeOf(mode).id;
  return {
    seed,
    mode: id,
    n,
    prizes: shufflePrizes(seed, id),
    round: 0,
    phase: 'bidding',
    hands: Array.from({ length: n }, () => deckOf(id)),
    bids: Array.from({ length: n }, () => null),
    scores: Array.from({ length: n }, () => 0),
    carry: 0,
    history: [],
    gone: Array.from({ length: n }, () => false),
  };
}

/** mulberry32 + Fisher-Yates, matching the engine's rng.ts exactly. */
function shufflePrizes(seed: number, mode: ModeId): number[] {
  let a = seed >>> 0;
  const rng = (): number => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = deckOf(mode);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** The prize card currently face up, or null once the match is over. */
export function currentPrize(g: GameState): number | null {
  return g.round < g.prizes.length ? g.prizes[g.round] : null;
}

/**
 * The prizes queued up behind the current one that this mode shows you.
 * Empty in Classic and Blitz; the next two in Foresight — which is the whole of
 * that mode, and it is derived rather than transmitted: every peer already has
 * the prize order, since it comes from the shared seed.
 */
export function upcomingPrizes(g: GameState): number[] {
  const n = modeOf(g.mode).lookahead;
  return n <= 0 ? [] : g.prizes.slice(g.round + 1, g.round + 1 + n);
}

/** What this round is actually worth: the prize plus everything a tie carried. */
export function currentPot(g: GameState): number {
  const prize = currentPrize(g);
  return prize === null ? 0 : prize + g.carry;
}

/** Is this a card that player may legally commit right now? */
export function canBid(g: GameState, player: number, card: number): boolean {
  if (g.phase !== 'bidding') return false;
  if (player < 0 || player >= g.n) return false;
  if (g.bids[player] !== null) return false;
  return g.hands[player].includes(card);
}

/**
 * Commit a card. Returns whether it was accepted, so a caller can tell a
 * rejected duplicate from a real one rather than guessing.
 *
 * The card is NOT removed from the hand here — it leaves on reveal. Keeping it
 * until then is what lets a peer render "you have committed" without leaking
 * which card to the rest of the table.
 */
export function submitBid(g: GameState, player: number, card: number): boolean {
  if (!canBid(g, player, card)) return false;
  g.bids[player] = card;
  return true;
}

/** Everyone who can still act has committed — the round is ready to turn over. */
export function allIn(g: GameState): boolean {
  return g.phase === 'bidding' && g.bids.every((b) => b !== null);
}

/**
 * Turn the committed cards face up WITHOUT scoring them yet.
 *
 * The gap between these two is the best moment in the game, so it is a real
 * state rather than an animation: in `reveal` the bids are public, the pot is
 * still unclaimed, and a snapshot taken here shows every peer the same cards at
 * the same time. It also means a host that dies mid-reveal hands its successor a
 * round it can finish (see Match.setHost).
 */
export function beginReveal(g: GameState): boolean {
  if (!allIn(g)) return false;
  g.phase = 'reveal';
  return true;
}

/** Who takes the pot this round, or null when the top bid is tied. */
export function trickWinner(bids: readonly number[]): number | null {
  const high = Math.max(...bids);
  const claimants = bids.reduce<number[]>((acc, b, i) => (b === high ? [...acc, i] : acc), []);
  // Two players who both went to the wall win nothing, and the pot rolls on.
  return claimants.length === 1 ? claimants[0] : null;
}

/**
 * Commit a card on behalf of every seat that has not acted: the round clock ran
 * out, or the player left. They play their LOWEST card — the least damaging
 * thing you can do with a hand you are not looking at, and predictable enough
 * that the table can reason about an abandoned seat.
 */
export function autoBidRest(g: GameState): number[] {
  if (g.phase !== 'bidding') return [];
  const forced: number[] = [];
  for (let p = 0; p < g.n; p++) {
    if (g.bids[p] === null) {
      g.bids[p] = g.hands[p][0];
      forced.push(p);
    }
  }
  return forced;
}

/**
 * Score the round: burn the cards, award the pot (or carry it), and advance.
 *
 * Only legal from `reveal` — the cards must be face up before they count.
 * Returns the completed Trick, or null if the round is not ready.
 */
export function resolve(g: GameState): Trick | null {
  if (g.phase !== 'reveal' || g.bids.some((b) => b === null)) return null;

  const bids = g.bids.map((b) => b as number);
  const pot = currentPot(g);
  const winner = trickWinner(bids);

  for (let p = 0; p < g.n; p++) {
    const i = g.hands[p].indexOf(bids[p]);
    if (i >= 0) g.hands[p].splice(i, 1);
  }

  if (winner !== null) {
    g.scores[winner] += pot;
    g.carry = 0;
  } else if (modeOf(g.mode).tiesCarry) {
    // Classic/Foresight: nobody took it, so it rides on top of the next prize.
    g.carry = pot;
  } else {
    // Blitz: a tied prize is burned. That is what makes a deliberate tie a
    // weapon — you cannot win the pot, but you can make sure nobody does.
    g.carry = 0;
  }

  const trick: Trick = { prize: g.prizes[g.round], pot, bids, winner };
  g.history.push(trick);
  g.round++;
  g.bids = Array.from({ length: g.n }, () => null);
  g.phase = g.round >= g.prizes.length ? 'over' : 'bidding';
  return trick;
}

/** Final standings, best first. Ties share a rank rather than being broken. */
export interface Standing {
  player: number;
  score: number;
  /** 1-based. Two players on the same score get the same rank. */
  rank: number;
}

export function standings(g: GameState): Standing[] {
  const sorted = g.scores
    .map((score, player) => ({ player, score, rank: 1 }))
    .sort((a, b) => b.score - a.score || a.player - b.player);
  for (let i = 1; i < sorted.length; i++) {
    sorted[i].rank = sorted[i].score === sorted[i - 1].score ? sorted[i - 1].rank : i + 1;
  }
  return sorted;
}

/** Everyone on the top score. More than one means the match itself was a draw. */
export function winners(g: GameState): number[] {
  const best = Math.max(...g.scores);
  return g.scores.reduce<number[]>((acc, s, i) => (s === best ? [...acc, i] : acc), []);
}

// ── post-match analysis ─────────────────────────────────────────────────────
// Bidstorm has a knowable right answer for every round in hindsight: the bids
// were simultaneous, so holding one player's card fixed, the cheapest card that
// beats everyone ELSE'S bid is exactly what that round was worth to them. That
// makes "what you missed" honest rather than hand-wavy, which is why the results
// screen can show it to every player.

/** What a player was holding at the start of a completed round. */
export function handAt(g: GameState, player: number, round: number): number[] {
  const spent = new Set(g.history.slice(0, round).map((t) => t.bids[player]));
  return deckOf(g.mode).filter((c) => !spent.has(c));
}

export interface RoundNote {
  round: number;
  /** The cheapest card this player held that would have taken the pot. */
  cheapest: number | null;
  /** Won it, but a smaller card would have done — this many pips wasted. */
  overspend: number;
  /** Lost it, though a card in hand would have won: this many points missed. */
  missed: number;
}

export interface PlayerReport {
  player: number;
  score: number;
  /** Rounds taken outright. */
  taken: number;
  /** Total pips spent on winning bids beyond what was needed. */
  wasted: number;
  /** Points lost in rounds a card in hand would have won. */
  missed: number;
  notes: RoundNote[];
}

/**
 * Per-player breakdown of the whole match — what each of them actually did, and
 * what each of them left on the table. Every player sees this for EVERY player,
 * which is the point: the end of a round is when people compare themselves.
 */
export function report(g: GameState, player: number): PlayerReport {
  const notes: RoundNote[] = [];
  let wasted = 0;
  let missed = 0;
  let taken = 0;

  g.history.forEach((t, round) => {
    // Bids are simultaneous, so the rest of the table is fixed no matter what
    // this player did — the bar to clear is simply the best of everyone else.
    const bar = Math.max(...t.bids.filter((_, i) => i !== player));
    const hand = handAt(g, player, round);
    const cheapest = hand.find((c) => c > bar) ?? null;
    const note: RoundNote = { round, cheapest, overspend: 0, missed: 0 };

    if (t.winner === player) {
      taken++;
      // cheapest is never null here: the card they won with clears the bar.
      note.overspend = t.bids[player] - (cheapest ?? t.bids[player]);
      wasted += note.overspend;
    } else if (cheapest !== null) {
      // They were holding a card that would have taken it. A tie counts too —
      // matching the top bid still lost them the pot.
      note.missed = t.pot;
      missed += t.pot;
    }
    notes.push(note);
  });

  return { player, score: g.scores[player], taken, wasted, missed, notes };
}

/** The full table's reports, in seat order. */
export function reports(g: GameState): PlayerReport[] {
  return Array.from({ length: g.n }, (_, p) => report(g, p));
}

// ── serialization ───────────────────────────────────────────────────────────
// The host broadcasts the whole state rather than deltas. It is small — a dozen
// rounds of small ints — and sending all of it means a peer that joins late,
// drops a packet, or is promoted to host is instantly whole again with nothing
// to reconcile.

export interface Snapshot {
  s: number;
  /**
   * The mode. It rides in every snapshot rather than being assumed, because the
   * deck size is derived from it: a peer that guessed Classic while the host
   * dealt Blitz would rebuild a 13-card game from a 7-card match and disagree
   * about the hands, the round count, and when the thing ends.
   */
  m: ModeId;
  n: number;
  r: number;
  p: Phase;
  /** Bids are masked to a plain "committed" flag until the reveal (see toSnapshot). */
  b: (number | null)[];
  sc: number[];
  c: number;
  h: Trick[];
  g: boolean[];
  /** Who has committed. Sent separately BECAUSE `b` is masked while bidding. */
  in: boolean[];
}

/**
 * Freeze the state for the wire.
 *
 * `reveal` is the whole reason this is not a plain structuredClone: while a
 * round is live, other players' cards must not be in the bytes at all. Sending
 * them and hiding them in the UI would put every opponent's bid one devtools
 * console away.
 */
export function toSnapshot(g: GameState, forPlayer: number | null): Snapshot {
  const revealed = g.phase !== 'bidding';
  return {
    s: g.seed,
    m: g.mode,
    n: g.n,
    r: g.round,
    p: g.phase,
    b: g.bids.map((b, i) => (revealed || i === forPlayer ? b : null)),
    sc: [...g.scores],
    c: g.carry,
    h: g.history.map((t) => ({ ...t, bids: [...t.bids] })),
    g: [...g.gone],
    in: g.bids.map((b) => b !== null),
  };
}

/** Rebuild a state from a snapshot. Hands are re-derived from the history. */
export function fromSnapshot(s: Snapshot): GameState {
  // Validated on the way in, not trusted: this is the wire. An id we do not know
  // lands on Classic rather than dealing a deck of `undefined`.
  const mode = modeOf(s.m).id;
  const deck = deckOf(mode);
  const hands = Array.from({ length: s.n }, (_, p) => {
    const spent = new Set(s.h.map((t) => t.bids[p]));
    return deck.filter((c) => !spent.has(c));
  });
  return {
    seed: s.s,
    mode,
    n: s.n,
    prizes: shufflePrizes(s.s, mode),
    round: s.r,
    phase: s.p,
    hands,
    bids: [...s.b],
    scores: [...s.sc],
    carry: s.c,
    history: s.h.map((t) => ({ ...t, bids: [...t.bids] })),
    gone: [...s.g],
  };
}
