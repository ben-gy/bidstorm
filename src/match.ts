/**
 * match.ts — one match of Bidstorm, driven by whoever is currently the host.
 *
 * This is the glue between the pure rules (game.ts) and the peer mesh
 * (engine/net.ts), and it is deliberately transport-agnostic: it is handed
 * `send` functions and a clock rather than a Net. That is what lets the
 * host-transfer takeover — the thing that has broken twice in this factory — be
 * proven by a unit test with no relay, no browser, and no timing luck.
 *
 * The model is a host-authoritative star:
 *  - Clients send 'bid' and render whatever 'snap' they are told.
 *  - The host owns the clock, resolves rounds, and broadcasts 'snap'.
 *  - Solo is the SAME code path with zero peers and bots filling the seats, so
 *    the mode that gets played most is the mode that is exercised most.
 *
 * Two rules this file exists to keep:
 *
 *  1. A LIVE BID IS NEVER IN THE BYTES. While a round is open the host sends
 *     each peer a snapshot masked to that peer (game.ts's toSnapshot), so an
 *     opponent's card is not one devtools console away. Only on reveal does one
 *     broadcast carry them all.
 *
 *  2. NOTHING WAITS FOREVER. Every round has a clock; when it expires the host
 *     bids the lowest card for anyone who has not acted. A player who left, a
 *     phone that locked, and a friend who is thinking too long are all the same
 *     survivable thing, and the match always reaches its final scoreline.
 */

import {
  allIn,
  autoBidRest,
  beginReveal,
  createGame,
  fromSnapshot,
  resolve,
  submitBid,
  toSnapshot,
  type GameState,
  type Snapshot,
  type Trick,
} from './game';
import { botBid, type Difficulty, type Style } from './bot';
import { modeOf, type ModeId } from './modes';
import { makeRng, type Rng } from './engine/rng';

/** Channel names. Both well inside Trystero's 12-byte limit, and distinct from
 *  rematch.ts's 'rv'/'rs'/'rq' — net.channel() fans out, so a collision would
 *  quietly feed every message to both subsystems. */
export const CH_BID = 'bid';
export const CH_SNAP = 'snap';

/** Client → host. The round rides along so a late packet is dropped, not applied. */
export interface BidMsg {
  r: number;
  c: number;
}

/**
 * Classic's round clock. The live value is the MODE's (modes.ts) — Blitz runs a
 * 12s round, and the clock is part of why it feels different.
 */
export const ROUND_MS = 30_000;
/** How long the cards stay face up before the pot is awarded. */
export const REVEAL_MS = 2200;
/** The last round earns a beat of silence before it turns over. */
export const FINAL_REVEAL_MS = 2800;

export interface MatchSeat {
  id: string;
  name: string;
}

export interface BotConfig {
  difficulty: Difficulty;
  /** One per bot seat, in seat order after the human. */
  styles: readonly Style[];
  /** Milliseconds a bot "thinks" before its card lands. Pure theatre. */
  thinkMs?: number;
}

export interface MatchConfig {
  seed: number;
  /**
   * The rules to deal under. In live P2P this is the HOST's pick, frozen into
   * the round start by rematch.ts — never each peer's own menu setting.
   */
  mode?: ModeId;
  /** The frozen roster from rematch.ts. Index N is player N on every peer. */
  seats: MatchSeat[];
  selfId: string;
  isHost: boolean;
  /** Bots fill every seat after the first. Solo only; never set for live P2P. */
  bots?: BotConfig;
  /**
   * The round clock, in ms. Defaults to ROUND_MS.
   *
   * Pass 0 to run without one. That is right for SOLO and wrong for live P2P:
   * the clock exists so a table is never held hostage by a player who has left,
   * locked their phone, or gone to make tea — and solo has no such player. A
   * clock there would only take the game away from someone who was thinking,
   * which in a game that is entirely thinking is just a punishment.
   */
  roundMs?: number;
  sendBid: (msg: BidMsg) => void;
  sendSnap: (snap: Snapshot, to?: string | string[]) => void;
  /** Repaint. Fires on every state change, host or client. */
  onUpdate: (g: GameState) => void;
  /** The cards just turned over — juice hangs off this. */
  onReveal: (g: GameState) => void;
  /** A round was scored. */
  onTrick: (t: Trick, g: GameState) => void;
  /** The match is finished. Fires exactly once, on every peer. */
  onOver: (g: GameState) => void;
  /** Injectable for tests. */
  now?: () => number;
}

export class Match {
  g: GameState;
  private cfg: MatchConfig;
  private host: boolean;
  private rng: Rng;
  private now: () => number;
  /** When the open round stops waiting. Host-only. */
  private deadline = 0;
  /** When the face-up cards get scored. Host-only. */
  private revealAt = 0;
  /** Bot seat -> when its card lands. Host-only. */
  private botAt = new Map<number, number>();
  private over = false;
  private destroyed = false;

  constructor(cfg: MatchConfig) {
    this.cfg = cfg;
    this.host = cfg.isHost;
    this.now = cfg.now ?? (() => Date.now());
    this.g = createGame(cfg.seed, cfg.seats.length, cfg.mode);
    // Seeded from the shared seed, so a solo match replays identically from its
    // seed and the shared-seed challenge is an honest comparison.
    this.rng = makeRng(cfg.seed ^ 0x9e3779b9);
    if (this.host) this.openRound();
  }

  /** This peer's seat, or -1 if it is watching rather than playing. */
  get seat(): number {
    return this.cfg.seats.findIndex((s) => s.id === this.cfg.selfId);
  }

  /** A peer with no seat is a spectator: it sees everything, commits nothing. */
  get spectating(): boolean {
    return this.seat < 0;
  }

  get isHost(): boolean {
    return this.host;
  }

  /** Seconds left on the round clock, or null when nothing is being waited on. */
  get timeLeftMs(): number | null {
    if (this.g.phase !== 'bidding' || !this.deadline) return null;
    return Math.max(0, this.deadline - this.now());
  }

  // ── local play ────────────────────────────────────────────────────────────

  /**
   * Commit this peer's card.
   *
   * A client sets its own bid locally too — that is display state, so the hand
   * can show "committed" without a network round-trip, and the next snapshot
   * overwrites it either way. It never touches scores, history or the round
   * number: on a client those come only from the host.
   */
  submit(card: number): boolean {
    const p = this.seat;
    if (p < 0) return false;
    if (this.host) {
      if (!submitBid(this.g, p, card)) return false;
      this.afterBid();
      return true;
    }
    if (this.g.phase !== 'bidding' || this.g.bids[p] !== null) return false;
    if (!this.g.hands[p].includes(card)) return false;
    this.g.bids[p] = card;
    this.cfg.sendBid({ r: this.g.round, c: card });
    this.cfg.onUpdate(this.g);
    return true;
  }

  // ── inbound ───────────────────────────────────────────────────────────────

  /** Host: a client's card arrived. */
  onBid(msg: BidMsg, from: string): void {
    if (!this.host || this.destroyed) return;
    const p = this.cfg.seats.findIndex((s) => s.id === from);
    if (p < 0) return;
    // A bid for a round we have already turned over is noise from a slow peer.
    if (msg.r !== this.g.round) return;
    if (!submitBid(this.g, p, msg.c)) return;
    this.afterBid();
  }

  /** Client: the host has spoken. */
  onSnap(snap: Snapshot, from: string): void {
    if (this.destroyed) return;
    // A promoted host must stop taking orders from the peer it replaced.
    if (this.host) return;
    const prev = this.g.phase;
    const prevRound = this.g.round;
    this.g = fromSnapshot(snap);
    this.cfg.onUpdate(this.g);
    if (this.g.phase === 'reveal' && (prev !== 'reveal' || prevRound !== this.g.round)) {
      this.cfg.onReveal(this.g);
    }
    if (this.g.round > prevRound && this.g.history.length) {
      this.cfg.onTrick(this.g.history[this.g.history.length - 1], this.g);
    }
    this.checkOver();
    void from;
  }

  /**
   * A peer left. The seat stays on the board and keeps its score — the round
   * must still be able to finish honestly — but the host now bids for it.
   */
  onPeerLeave(livePeerIds: readonly string[]): void {
    const live = new Set(livePeerIds);
    let changed = false;
    this.cfg.seats.forEach((s, i) => {
      const gone = s.id !== this.cfg.selfId && !live.has(s.id);
      if (gone !== this.g.gone[i]) {
        this.g.gone[i] = gone;
        changed = true;
      }
    });
    if (!changed) return;
    this.cfg.onUpdate(this.g);
    if (this.host) {
      // Don't make the table wait 30s on a chair that is empty.
      this.bidForAbsentSeats();
      this.broadcast();
    }
  }

  // ── the takeover ──────────────────────────────────────────────────────────

  /**
   * The host left and net.ts promoted this peer. Everything below is what
   * "keeps playing" actually requires — election alone changes nothing.
   *
   * This peer has been storing every snapshot precisely so that it can adopt the
   * last one as canonical here. It then re-broadcasts (so the room agrees who is
   * speaking), restarts the host-only clocks it never ran as a client, and
   * finishes any round the old host died holding.
   */
  setHost(isHost: boolean): void {
    if (this.host === isHost || this.destroyed) return;
    this.host = isHost;
    if (!isHost) {
      // Demoted — a converged election, not a normal path. Stop deciding.
      this.deadline = 0;
      this.revealAt = 0;
      this.botAt.clear();
      return;
    }

    if (this.g.phase === 'bidding') {
      // A fresh clock, not the dead host's: nobody should be timed out by the
      // handover itself.
      this.openRound();
      // The old host may have died holding the last card the table was waiting on.
      if (allIn(this.g)) this.startReveal();
    } else if (this.g.phase === 'reveal') {
      // It went down mid-reveal. Finish the round rather than freeze on it.
      this.revealAt = this.now() + REVEAL_MS;
    }
    this.broadcast();
    this.cfg.onUpdate(this.g);
    this.checkOver();
  }

  // ── the host clock ────────────────────────────────────────────────────────

  /**
   * Advance time. Driven by a setInterval, never by requestAnimationFrame: a
   * backgrounded host must keep the room running, and rAF is paused in a hidden
   * tab. It is also what makes every branch below reachable from a test.
   */
  tick(): void {
    if (!this.host || this.destroyed) return;
    const t = this.now();

    if (this.g.phase === 'bidding') {
      for (const [p, at] of this.botAt) {
        if (t >= at && this.g.bids[p] === null) {
          this.botAt.delete(p);
          const card = botBid(this.g, p, this.cfg.bots!.difficulty, this.rng, this.cfg.bots!.styles[p - 1] ?? 'even');
          submitBid(this.g, p, card);
        }
      }
      if (allIn(this.g)) return this.startReveal();
      if (this.deadline && t >= this.deadline) {
        // Nothing waits forever. Whoever did not act plays their lowest card.
        autoBidRest(this.g);
        return this.startReveal();
      }
      return;
    }

    if (this.g.phase === 'reveal' && this.revealAt && t >= this.revealAt) {
      this.revealAt = 0;
      const trick = resolve(this.g);
      if (trick) {
        this.cfg.onTrick(trick, this.g);
        // resolve() has moved us on to the next round, or ended the match.
        // Asking `phase === 'bidding'` here reads as dead code to the compiler,
        // which narrowed it to 'reveal' on the way in and cannot see the mutation.
        if (this.g.round < this.g.prizes.length) this.openRound();
      }
      this.broadcast();
      this.cfg.onUpdate(this.g);
      this.checkOver();
    }
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private afterBid(): void {
    if (allIn(this.g)) this.startReveal();
    else {
      this.broadcast();
      this.cfg.onUpdate(this.g);
    }
  }

  private startReveal(): void {
    if (!beginReveal(this.g)) return;
    this.deadline = 0;
    this.botAt.clear();
    // The last round earns a longer beat — it decides the match.
    this.revealAt = this.now() + (this.g.round === this.g.prizes.length - 1 ? FINAL_REVEAL_MS : REVEAL_MS);
    this.broadcast();
    this.cfg.onUpdate(this.g);
    this.cfg.onReveal(this.g);
  }

  private openRound(): void {
    // The mode owns the clock — Blitz is 12s, and a hard-coded 30 here would
    // quietly make it Classic with a smaller deck.
    const limit = this.cfg.roundMs ?? modeOf(this.g.mode).roundMs;
    this.deadline = limit > 0 ? this.now() + limit : 0;
    this.botAt.clear();
    if (this.cfg.bots) {
      const think = this.cfg.bots.thinkMs ?? 900;
      for (let p = 1; p < this.g.n; p++) {
        // Stagger them so the table does not slap its cards down in unison.
        this.botAt.set(p, this.now() + think + p * 260);
      }
    }
    this.bidForAbsentSeats();
  }

  /** An empty chair plays instantly — there is nobody to wait for. */
  private bidForAbsentSeats(): void {
    if (this.g.phase !== 'bidding') return;
    let any = false;
    for (let p = 0; p < this.g.n; p++) {
      if (this.g.gone[p] && this.g.bids[p] === null) {
        submitBid(this.g, p, this.g.hands[p][0]);
        any = true;
      }
    }
    if (any && allIn(this.g)) this.startReveal();
  }

  /**
   * Tell the room where things stand.
   *
   * While a round is open this is one masked snapshot PER PEER — that is the
   * only way an opponent's live card stays out of the bytes. Once the cards are
   * face up there is nothing to hide, so it is a single broadcast.
   */
  private broadcast(): void {
    if (!this.host || this.destroyed) return;
    if (this.g.phase === 'bidding') {
      for (const s of this.cfg.seats) {
        if (s.id === this.cfg.selfId) continue;
        this.cfg.sendSnap(toSnapshot(this.g, this.cfg.seats.findIndex((x) => x.id === s.id)), s.id);
      }
    } else {
      this.cfg.sendSnap(toSnapshot(this.g, null));
    }
  }

  /** Host-only keepalive + a resync for anyone who joined or missed a packet. */
  resend(): void {
    this.broadcast();
  }

  /**
   * The countdown has landed — start the round for real.
   *
   * The clock and the bots are re-armed from NOW rather than from whenever the
   * Match was constructed, so the 3-2-1 does not quietly eat two seconds of a
   * player's thinking time (which in Blitz's twelve is a sixth of the round).
   */
  beginPlay(): void {
    if (!this.host || this.destroyed || this.g.phase !== 'bidding') return;
    this.openRound();
  }

  private checkOver(): void {
    if (this.over || this.g.phase !== 'over') return;
    this.over = true;
    this.cfg.onOver(this.g);
  }

  destroy(): void {
    this.destroyed = true;
    this.botAt.clear();
  }
}
