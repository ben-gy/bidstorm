/**
 * rematch.test.ts — the multi-round protocol, driven with N simulated peers.
 *
 * What this covers and what it deliberately does not:
 *
 *  - COVERED: our round protocol. Votes, quorum, monotonic round numbers, the
 *    frozen roster, host election, host handover mid-results. This is our logic
 *    and a fake bus exercises it honestly.
 *
 *  - NOT COVERED: the transport bug that started all this. A fake bus sits ABOVE
 *    Trystero's room cache, so it structurally cannot contain that defect and
 *    would happily go green while the real game was broken. Two other tests own
 *    that: trystero-rejoin.test.ts pins the Trystero behaviour itself, and
 *    net-lifecycle.test.ts asserts the "one join per session" invariant that
 *    makes the trap unreachable — no network model required.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRounds, type RoundInfo } from '@ben-gy/game-engine/rematch';
import type { Net, PeerId } from '@ben-gy/game-engine/net';

/** A shared in-memory bus. Delivery is synchronous — we are testing protocol
 *  decisions, not timing. */
class Bus {
  peers = new Map<PeerId, Map<string, Set<(d: unknown, from: PeerId) => void>>>();
  /** peer id -> its onPeersChange subscribers. */
  watchers = new Map<PeerId, Set<(peers: PeerId[]) => void>>();

  join(id: PeerId): void {
    this.peers.set(id, new Map());
    this.announceRoster();
  }

  part(id: PeerId): void {
    this.peers.delete(id);
    this.watchers.delete(id);
    this.announceRoster();
  }

  /** Everyone still here learns the roster moved. This is what feeds rematch.ts's
   *  ROSTER_SETTLE_MS window, so it has to fire for the test to be honest about
   *  when a roster is allowed to be frozen. */
  announceRoster(): void {
    const roster = this.roster();
    for (const [id, subs] of this.watchers) {
      if (!this.peers.has(id)) continue;
      for (const cb of subs) cb(roster);
    }
  }

  watch(id: PeerId, cb: (peers: PeerId[]) => void): () => void {
    if (!this.watchers.has(id)) this.watchers.set(id, new Set());
    this.watchers.get(id)!.add(cb);
    return () => this.watchers.get(id)?.delete(cb);
  }

  roster(): PeerId[] {
    return [...this.peers.keys()].sort();
  }

  send(from: PeerId, name: string, data: unknown, to?: PeerId | PeerId[]): void {
    const targets = to ? (Array.isArray(to) ? to : [to]) : this.roster().filter((p) => p !== from);
    for (const t of targets) {
      for (const h of this.peers.get(t)?.get(name) ?? []) h(data, from);
    }
  }

  on(id: PeerId, name: string, h: (d: unknown, from: PeerId) => void): () => void {
    const chans = this.peers.get(id)!;
    if (!chans.has(name)) chans.set(name, new Set());
    chans.get(name)!.add(h);
    return () => chans.get(name)!.delete(h);
  }
}

function mockNet(bus: Bus, selfId: PeerId): Net {
  bus.join(selfId);
  return {
    selfId,
    peers: () => bus.roster(),
    // Same election rule as the real net.ts: lexicographically smallest id.
    host: () => bus.roster()[0],
    isHost: () => bus.roster()[0] === selfId,
    // These peers are all wired to each other from the first tick; net.ts's
    // settling window is its own business and host-election.test.ts owns it.
    hostSettled: () => true,
    // Terms only matter to the election itself, which this bus does not model:
    // the host here is whoever sorts lowest, and it never changes hands except
    // by a leave. Held at 1 so a reader is not tempted to read meaning into it.
    hostEpoch: () => 1,
    count: () => bus.roster().length,
    onPeersChange: (cb) => bus.watch(selfId, cb),
    // Manual promotion is a lobby affordance for a peer sitting alone; nothing
    // in the round protocol calls it, and this bus has no unsettled state to
    // resolve. Asserting that keeps a future caller from expecting an effect.
    takeover: () => {
      throw new Error('takeover() is not modelled by this bus');
    },
    netDiag: () => ({
      selfId,
      host: bus.roster()[0] ?? null,
      epoch: 1,
      settled: true,
      peers: bus.roster(),
      relaySockets: {},
      turn: false,
    }),
    channel<T>(name: string, onReceive: (d: T, from: PeerId) => void) {
      const off = bus.on(selfId, name, onReceive as (d: unknown, from: PeerId) => void);
      const send = ((data: T, to?: PeerId | PeerId[]) => bus.send(selfId, name, data, to)) as ((
        data: T,
        to?: PeerId | PeerId[],
      ) => void) & { off: () => void };
      send.off = off;
      return send;
    },
    ping: async () => 0,
    leave: async () => bus.part(selfId),
  };
}

interface Seat {
  id: PeerId;
  net: Net;
  rounds: ReturnType<typeof createRounds>;
  got: RoundInfo[];
}

function table(ids: PeerId[], opts: { minPlayers?: number; modes?: Record<string, string> } = {}): Seat[] {
  const bus = new Bus();
  return ids.map((id) => {
    const net = mockNet(bus, id);
    const seat: Seat = { id, net, rounds: null as never, got: [] };
    seat.rounds = createRounds({
      net,
      playerName: id.toUpperCase(),
      minPlayers: opts.minPlayers ?? 2,
      // Each peer reports the mode ITS OWN menu is set to. Only the host's may
      // ever reach the table — that is the whole point of roundOpts.
      roundOpts: opts.modes ? () => ({ mode: opts.modes![id] }) : undefined,
      onRound: (info) => seat.got.push(info),
    });
    return seat;
  });
}

/** The mode the host froze into a round, as the game reads it back. */
function optMode(info: RoundInfo): string | undefined {
  return (info.opts as { mode?: string } | undefined)?.mode;
}

/**
 * Let the roster hold still long enough for a start to be allowed.
 *
 * rematch.ts no longer starts on the last vote. A host that froze its roster the
 * instant quorum arrived was freezing a half-formed mesh — the peers still
 * finishing their handshake were simply left out, which is what "I got ejected
 * when the round started" actually was. So the start waits for ROSTER_SETTLE_MS
 * (4s) of no roster movement and is retried by a 1.5s poll; 6s covers the window
 * plus the next tick. Roster changes RESET it, so this is needed again after any
 * join or leave.
 */
const settle = (): void => {
  vi.advanceTimersByTime(6000);
};

let seats: Seat[];
beforeEach(() => {
  seats = [];
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createRounds — dealing a table', () => {
  it('deals once every peer has voted, with one host and an identical seed', () => {
    seats = table(['a', 'b']);
    seats.forEach((s) => s.rounds.vote());
    settle();

    // Auto-start fires once everyone has voted AND the roster has held still;
    // nobody had to press Deal.
    expect(seats.map((s) => s.got.length)).toEqual([1, 1]);
    expect(seats[0].got[0].seed).toBe(seats[1].got[0].seed);
    expect(seats.filter((s) => s.got[0].isHost)).toHaveLength(1);
    expect(seats[0].got[0].round).toBe(1);
  });

  it('freezes ONE roster into the start, so player indices match on every peer', () => {
    seats = table(['b', 'a', 'c'], { minPlayers: 3 });
    seats.forEach((s) => s.rounds.vote());
    settle();

    const rosters = seats.map((s) => s.got[0].players.map((p) => `${p.id}:${p.name}`));
    // Every peer must agree on who is player 0 — this is what stops a score
    // landing on the wrong name. The roster comes from the host's bytes, not
    // from each peer re-deriving it locally.
    expect(rosters[0]).toEqual(rosters[1]);
    expect(rosters[1]).toEqual(rosters[2]);
    expect(rosters[0]).toEqual(['a:A', 'b:B', 'c:C']);
  });

  it('waits below quorum', () => {
    seats = table(['a', 'b', 'c'], { minPlayers: 3 });
    seats[0].rounds.vote();
    seats[1].rounds.vote();
    // A full settle window with two of three in: quorum, not patience, is what
    // is missing, so no amount of waiting may deal this table.
    settle();
    expect(seats.every((s) => s.got.length === 0)).toBe(true);

    seats[2].rounds.vote();
    expect(seats.every((s) => s.got.length === 1)).toBe(true);
  });

  it('lets the host deal early with go(), leaving a non-voter out of the roster', () => {
    seats = table(['a', 'b', 'c']);
    seats[0].rounds.vote();
    seats[1].rounds.vote();
    settle();
    expect(seats[0].got.length).toBe(0); // c has not voted — no auto-start

    seats[0].rounds.go(); // host forces it
    expect(seats[0].got[0].players.map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('ignores a start from a peer that is not the host', () => {
    seats = table(['a', 'b']);
    // 'b' is not the host; forge a start and make sure nobody honours it.
    seats[1].net.channel('rs', () => {})({
      round: 1,
      seed: 42,
      roster: [{ id: 'b', name: 'B' }],
    } as never);
    expect(seats.every((s) => s.got.length === 0)).toBe(true);
  });
});

describe('createRounds — the host settings travel frozen', () => {
  it("gives every peer the HOST's mode, not the one their own menu is set to", () => {
    // The guest is sitting on Blitz. It must play the host's Classic, because a
    // mode decides the DECK SIZE: if the guest believed its own menu, the two of
    // them would deal 7 cards and 13 cards off the same seed and never find out.
    seats = table(['a', 'b'], { modes: { a: 'classic', b: 'blitz' } });
    seats.forEach((s) => s.rounds.vote());
    settle();

    expect(seats[0].net.isHost()).toBe(true);
    for (const s of seats) expect(optMode(s.got[0])).toBe('classic');
  });

  it('follows the mode when the HOST is the one on Blitz', () => {
    seats = table(['a', 'b'], { modes: { a: 'blitz', b: 'classic' } });
    seats.forEach((s) => s.rounds.vote());
    settle();
    for (const s of seats) expect(optMode(s.got[0])).toBe('blitz');
  });

  it('carries the settings into every rematch, not just the first deal', () => {
    seats = table(['a', 'b'], { modes: { a: 'foresight', b: 'blitz' } });
    seats.forEach((s) => s.rounds.vote());
    settle();
    seats.forEach((s) => s.rounds.finish());
    seats.forEach((s) => s.rounds.vote());
    settle();

    for (const s of seats) expect(optMode(s.got[1])).toBe('foresight');
  });

  it('re-reads the host settings each round, so a change takes effect', () => {
    const bus = new Bus();
    let hostMode = 'classic';
    const net = mockNet(bus, 'a');
    const guest = mockNet(bus, 'b');
    const got: RoundInfo[] = [];
    const host = createRounds({
      net,
      playerName: 'A',
      roundOpts: () => ({ mode: hostMode }),
      onRound: (i) => got.push(i),
    });
    const other = createRounds({ net: guest, playerName: 'B', onRound: () => {} });

    host.vote();
    other.vote();
    settle();
    expect(optMode(got[0])).toBe('classic');

    host.finish();
    other.finish();
    hostMode = 'blitz'; // the host changed its mind at the results screen
    host.vote();
    other.vote();
    settle();
    expect(optMode(got[1])).toBe('blitz');
  });

  it('hands back no opts at all when a game does not use them', () => {
    // rematch.ts is engine code shared across games; a game with no settings
    // must not have to know that roundOpts exists. It passes the host's bytes
    // through untouched rather than inventing an empty object, so a game that
    // reads opts has to cope with "the host sent nothing" — which is exactly the
    // case main.ts guards when it validates the mode.
    seats = table(['a', 'b']);
    seats.forEach((s) => s.rounds.vote());
    settle();
    expect(seats[0].got[0].opts).toBeUndefined();
  });
});

describe('createRounds — the rematch (the bug this all exists for)', () => {
  it('runs a second round in the SAME room, both peers together, one host', () => {
    seats = table(['a', 'b']);
    seats.forEach((s) => s.rounds.vote());
    settle();
    seats.forEach((s) => s.rounds.finish());

    // Both players hit "Play again" — the exact sequence the user reported.
    // finish() deliberately restarts the settle window, so a rematch is held for
    // the same 4s of roster quiet as the first deal — anyone reconnecting between
    // rounds is in the next roster instead of being frozen out of it.
    seats.forEach((s) => s.rounds.vote());
    settle();

    expect(seats.map((s) => s.got.length)).toEqual([2, 2]);
    expect(seats[0].got[1].round).toBe(2);
    expect(seats[0].got[1].seed).toBe(seats[1].got[1].seed);
    // The symptom was TWO hosts. There must be exactly one, every round.
    expect(seats.filter((s) => s.got[1].isHost)).toHaveLength(1);
    // …and a fresh deal, not a replay of round 1.
    expect(seats[0].got[1].seed).not.toBe(seats[0].got[0].seed);
  });

  it("keeps both peers in each other's roster across the rematch", () => {
    seats = table(['a', 'b']);
    seats.forEach((s) => s.rounds.vote());
    settle();
    seats.forEach((s) => s.rounds.finish());
    seats.forEach((s) => s.rounds.vote());
    settle();

    // "Neither can see each other" — assert the opposite, directly.
    for (const s of seats) {
      expect(s.got[1].players.map((p) => p.id)).toEqual(['a', 'b']);
      expect(s.net.count()).toBe(2);
    }
  });

  it('ignores a stale or duplicated start rather than restarting a live round', () => {
    seats = table(['a', 'b']);
    seats.forEach((s) => s.rounds.vote());
    settle();
    const seed = seats[0].got[0].seed;

    // Replay round 1's start — e.g. a duplicate delivery, or both peers pressing
    // at the same instant. The monotonic guard must swallow it.
    seats[0].net.channel('rs', () => {})({
      round: 1,
      seed: 999,
      roster: [{ id: 'a', name: 'A' }],
    } as never);
    expect(seats[1].got.length).toBe(1);
    expect(seats[1].got[0].seed).toBe(seed);
  });

  it('does not deal a rematch while a round is still being played', () => {
    seats = table(['a', 'b']);
    seats.forEach((s) => s.rounds.vote()); // round 1 playing; no finish()
    settle();
    seats.forEach((s) => s.rounds.vote()); // premature "play again"
    settle();
    expect(seats[0].got.length).toBe(1);
  });

  it('drops the vote of a peer who leaves, and still rematches the rest', () => {
    seats = table(['a', 'b', 'c'], { minPlayers: 2 });
    seats.forEach((s) => s.rounds.vote());
    settle();
    seats.forEach((s) => s.rounds.finish());

    seats[0].rounds.vote();
    seats[1].rounds.vote();
    expect(seats[0].got.length).toBe(1); // still waiting on c

    seats[2].net.leave(); // c closes the tab
    // The leave moved the roster, so the start waits out a fresh settle window
    // before freezing it — the whole point of the window is that a roster in
    // motion is not one you may deal from.
    settle();

    expect(seats[0].got[1].players.map((p) => p.id)).toEqual(['a', 'b']);
  });
});

describe('createRounds — host handover', () => {
  it('promotes the next peer and still deals when the host leaves at results', () => {
    seats = table(['a', 'b', 'c'], { minPlayers: 2 });
    seats.forEach((s) => s.rounds.vote());
    settle();
    seats.forEach((s) => s.rounds.finish());
    expect(seats[0].net.isHost()).toBe(true);

    seats[0].net.leave(); // the host walks away between rounds
    expect(seats[1].net.isHost()).toBe(true); // b is promoted by min-id election

    seats[1].rounds.vote();
    seats[2].rounds.vote();
    settle(); // the leave reset the roster window

    // The promoted host must be able to run the rematch — inheriting no tally
    // from the old host is the classic way this deadlocks.
    expect(seats[1].got.length).toBe(2);
    expect(seats[1].got[1].players.map((p) => p.id)).toEqual(['b', 'c']);
    expect(seats[1].got[1].isHost).toBe(true);
  });
});

describe('createRounds — never deadlock waiting for a vote that never comes', () => {
  it('deals anyway once the grace countdown expires, without the silent player', () => {
    seats = table(['a', 'b', 'c'], { minPlayers: 2 });
    seats.forEach((s) => s.rounds.vote());
    settle();
    seats.forEach((s) => s.rounds.finish());

    // Two of three hit "Play again". The third is still reading the results
    // table — which is the whole point of it, and takes a while. The OLD rule
    // demanded unanimity forever, so this hung the room with no way out but the
    // menu.
    seats[0].rounds.vote();
    seats[1].rounds.vote();
    settle(); // the roster window first; only then may a countdown even begin
    expect(seats[0].got.length).toBe(1); // not yet — the countdown is running

    const s = seats[0].rounds.state();
    expect(s.startsInMs).toBeGreaterThan(0); // and it is VISIBLE, not a silent hang

    vi.advanceTimersByTime(8100);

    expect(seats[0].got.length).toBe(2);
    expect(seats[0].got[1].players.map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('goes immediately when everyone votes, with no countdown', () => {
    seats = table(['a', 'b'], { minPlayers: 2 });
    seats.forEach((s) => s.rounds.vote());
    settle();
    seats.forEach((s) => s.rounds.finish());
    seats.forEach((s) => s.rounds.vote());
    settle();

    // Unanimity must not be punished with the 8s grace wait — that countdown is
    // for stragglers, and there are none. The 4s roster window settle() covers
    // is a different thing and applies either way.
    expect(seats[0].got.length).toBe(2);
    expect(seats[0].rounds.state().startsInMs).toBeNull();
  });

  it('lets the host force the rematch immediately with go()', () => {
    seats = table(['a', 'b', 'c'], { minPlayers: 2 });
    seats.forEach((s) => s.rounds.vote());
    settle();
    seats.forEach((s) => s.rounds.finish());

    seats[0].rounds.vote();
    seats[1].rounds.vote();
    // go() is the host's override and answers to neither window.
    seats[0].rounds.go();

    expect(seats[0].got.length).toBe(2);
  });

  it('cancels the countdown if quorum is lost again', () => {
    seats = table(['a', 'b', 'c'], { minPlayers: 2 });
    seats.forEach((s) => s.rounds.vote());
    settle();
    seats.forEach((s) => s.rounds.finish());

    seats[0].rounds.vote();
    seats[1].rounds.vote();
    settle();
    expect(seats[0].rounds.state().startsInMs).toBeGreaterThan(0);

    seats[1].rounds.unvote(); // changed their mind
    expect(seats[0].rounds.state().startsInMs).toBeNull();

    vi.advanceTimersByTime(8100);
    expect(seats[0].got.length).toBe(1); // no table dealt below quorum
  });

  it('a peer who readies up mid-countdown still lands in the table', () => {
    seats = table(['a', 'b', 'c'], { minPlayers: 2 });
    seats.forEach((s) => s.rounds.vote());
    settle();
    seats.forEach((s) => s.rounds.finish());

    seats[0].rounds.vote();
    seats[1].rounds.vote();
    seats[2].rounds.vote(); // the straggler taps just in time
    settle();

    expect(seats[2].got.length).toBe(2);
    expect(seats[2].got[1].players.map((p) => p.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('createRounds — teardown', () => {
  it('stops answering once destroyed', () => {
    seats = table(['a', 'b']);
    seats[1].rounds.destroy();
    seats.forEach((s) => s.rounds.vote());
    settle();

    // A destroyed Rounds must not keep driving a screen that is gone.
    expect(seats[1].got.length).toBe(0);
  });
});
