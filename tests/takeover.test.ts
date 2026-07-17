/**
 * takeover.test.ts — the host leaves and the game keeps going.
 *
 * This is the gate two games in this factory have already failed. Electing a new
 * host is the easy half and net.ts does it for free; the half that actually
 * matters is whether the promoted peer can RUN the table — keep the clock,
 * resolve rounds, and still reach a final scoreline. A survivor stuck on a
 * frozen board is the bug, and it looks exactly like a working election.
 *
 * Match is built to be provable here: it takes send functions and a clock rather
 * than a Net, so the whole takeover is exercised with no relay, no browser, and
 * no timing luck.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { Match, REVEAL_MS, ROUND_MS, FINAL_REVEAL_MS, type BidMsg } from '../src/match';
import { ROUNDS, type Snapshot } from '../src/game';

const SEATS = [
  { id: 'H', name: 'Host' },
  { id: 'C', name: 'Client' },
];

let t = 0;
const now = (): number => t;

interface Table {
  host: Match;
  client: Match;
  /** Cut the wire, as closing the host's tab would. */
  killHost(): void;
}

function table(): Table {
  let hostAlive = true;
  let host: Match;
  let client: Match;

  host = new Match({
    seed: 4242,
    seats: SEATS,
    selfId: 'H',
    isHost: true,
    now,
    sendBid: () => {},
    // The host's snapshots only reach the client while its tab is open.
    sendSnap: (s: Snapshot) => {
      if (hostAlive) client?.onSnap(s, 'H');
    },
    onUpdate: () => {},
    onReveal: () => {},
    onTrick: () => {},
    onOver: () => {},
  });

  client = new Match({
    seed: 4242,
    seats: SEATS,
    selfId: 'C',
    isHost: false,
    now,
    sendBid: (m: BidMsg) => {
      if (hostAlive) host.onBid(m, 'C');
    },
    sendSnap: () => {},
    onUpdate: () => {},
    onReveal: () => {},
    onTrick: () => {},
    onOver: () => {},
  });

  return {
    host,
    client,
    killHost() {
      hostAlive = false;
      host.destroy();
    },
  };
}

/** Play one round out under whichever peer is currently hosting. */
function runRound(m: Match): void {
  t += ROUND_MS + 1;
  m.tick(); // the clock expires: anyone who did not act plays their lowest
  t += FINAL_REVEAL_MS + 1;
  m.tick(); // the cards are scored and the next round opens
}

beforeEach(() => {
  t = 0;
});

describe('before promotion, a client decides nothing', () => {
  it('does not score, resolve, or advance the round on its own', () => {
    const { client } = table();
    const round = client.g.round;

    client.submit(9);
    t += ROUND_MS * 3;
    client.tick();

    // A client that ran the sim would double-count every round it also received.
    expect(client.g.round).toBe(round);
    expect(client.g.scores).toEqual([0, 0]);
    expect(client.g.history).toEqual([]);
    expect(client.g.phase).toBe('bidding');
  });

  it('shows its own card as committed without waiting for the host', () => {
    const { client } = table();
    expect(client.submit(9)).toBe(true);
    // Display state only — it is what lets the hand say "committed" with no
    // round-trip, and the next snapshot overwrites it either way.
    expect(client.g.bids[1]).toBe(9);
    expect(client.isHost).toBe(false);
  });

  it('takes the round from the host, not from its own opinion', () => {
    const { host, client } = table();
    host.submit(13);
    client.submit(2);
    t += REVEAL_MS + 1;
    host.tick();
    t += REVEAL_MS + 1;
    host.tick();

    expect(host.g.round).toBe(1);
    expect(client.g.round).toBe(1);
    expect(client.g.scores).toEqual(host.g.scores);
    expect(client.g.history).toEqual(host.g.history);
  });
});

describe('the host leaves mid-match', () => {
  it('promotes the survivor, which then drives the game to a real ending', () => {
    const { host, client, killHost } = table();

    // Get a couple of rounds on the board so the takeover inherits real state.
    host.submit(13);
    client.submit(2);
    t += REVEAL_MS + 1;
    host.tick();
    t += REVEAL_MS + 1;
    host.tick();
    expect(client.g.round).toBe(1);
    const inherited = [...client.g.scores];

    killHost();
    client.onPeerLeave(['C']); // net.ts's onPeers: only we are left
    client.setHost(true); // net.ts's onHostChange

    expect(client.isHost).toBe(true);
    // It adopts the last snapshot it received — it was storing them for exactly
    // this — rather than starting a fresh game on top of a live one.
    expect(client.g.scores).toEqual(inherited);
    expect(client.g.round).toBe(1);

    // THE GATE: it must keep going, and it must be able to finish.
    for (let r = client.g.round; r < ROUNDS; r++) runRound(client);

    expect(client.g.phase).toBe('over');
    expect(client.g.round).toBe(ROUNDS);
    expect(client.g.history).toHaveLength(ROUNDS);
  });

  it('fires onOver exactly once on the promoted peer', () => {
    let overs = 0;
    let client!: Match;
    client = new Match({
      seed: 1,
      seats: SEATS,
      selfId: 'C',
      isHost: false,
      now,
      sendBid: () => {},
      sendSnap: () => {},
      onUpdate: () => {},
      onReveal: () => {},
      onTrick: () => {},
      onOver: () => {
        overs++;
      },
    });

    client.setHost(true);
    for (let r = 0; r < ROUNDS; r++) runRound(client);
    // A promoted peer that never reached its own results screen would sit on a
    // finished board forever.
    expect(client.g.phase).toBe('over');
    expect(overs).toBe(1);

    client.tick();
    expect(overs).toBe(1);
  });

  it('finishes a round the old host died holding', () => {
    const { host, client, killHost } = table();

    // Both cards are in, but the host dies before it turns them over.
    host.submit(13);
    client.submit(2);
    expect(host.g.phase).toBe('reveal');
    killHost();

    // The client saw the reveal snapshot; it must resolve it, not freeze on it.
    expect(client.g.phase).toBe('reveal');
    client.setHost(true);
    t += REVEAL_MS + 1;
    client.tick();

    expect(client.g.round).toBe(1);
    expect(client.g.history).toHaveLength(1);
    expect(client.g.phase).toBe('bidding');
  });

  it('turns over a round whose last card landed as the host died', () => {
    const { host, client, killHost } = table();

    // The client's card is in; the host's is not, and never will be.
    client.submit(2);
    expect(host.g.bids[1]).toBe(2);
    killHost();

    client.setHost(true);
    // The absent seat must not hold the round open for its full clock.
    client.onPeerLeave(['C']);

    expect(client.g.phase).not.toBe('bidding');
    t += FINAL_REVEAL_MS + 1;
    client.tick();
    expect(client.g.history).toHaveLength(1);
  });

  it('gives the table a fresh clock rather than the dead host\'s', () => {
    const { client, killHost } = table();
    t += ROUND_MS - 500; // the old round was nearly out of time
    killHost();
    client.setHost(true);

    // Nobody should be timed out by the handover itself.
    expect(client.timeLeftMs).toBeGreaterThan(ROUND_MS - 100);
  });

  it('stops taking orders from the host it replaced', () => {
    const { client, killHost } = table();
    killHost();
    client.setHost(true);
    const mine = { ...client.g };

    // A late or duplicated snapshot from the old host must not overwrite the
    // state the new host is now authoritative for.
    client.onSnap(
      {
        s: 4242,
        m: 'classic',
        n: 2,
        r: 9,
        p: 'bidding',
        b: [null, null],
        sc: [99, 0],
        c: 0,
        h: [],
        g: [false, false],
        in: [false, false],
      },
      'H',
    );
    expect(client.g.round).toBe(mine.round);
    expect(client.g.scores).toEqual([0, 0]);
  });
});

describe('the round clock', () => {
  it('takes the round off anyone who did not act in time', () => {
    const { host } = table();
    t += ROUND_MS + 1;
    host.tick();
    // Both seats played their lowest card rather than the table hanging.
    expect(host.g.phase).toBe('reveal');
    expect(host.g.bids).toEqual([1, 1]);
  });

  it('does NOT run at all when roundMs is 0 — solo waits for you', () => {
    const solo = new Match({
      seed: 1,
      seats: SEATS,
      selfId: 'H',
      isHost: true,
      roundMs: 0,
      now,
      sendBid: () => {},
      sendSnap: () => {},
      onUpdate: () => {},
      onReveal: () => {},
      onTrick: () => {},
      onOver: () => {},
    });

    expect(solo.timeLeftMs).toBeNull();
    t += ROUND_MS * 20; // go and make a cup of tea
    solo.tick();

    // A clock exists to stop a table waiting on someone who is gone. Solo has
    // nobody to wait for, so taking the round away from a player who is thinking
    // would be a punishment with no purpose.
    expect(solo.g.phase).toBe('bidding');
    expect(solo.g.bids[0]).toBeNull();
    expect(solo.g.round).toBe(0);
  });
});

describe('a peer leaving that is NOT the host', () => {
  it('does not stall the host — the empty chair plays itself', () => {
    const { host } = table();
    host.onPeerLeave(['H']); // the client closed its tab

    expect(host.g.gone[1]).toBe(true);
    // The absent seat bids immediately, so the table is only ever waiting on the
    // people who are actually there.
    expect(host.g.bids[1]).toBe(1);

    host.submit(5);
    t += FINAL_REVEAL_MS + 1;
    host.tick();
    expect(host.g.history).toHaveLength(1);

    for (let r = host.g.round; r < ROUNDS; r++) runRound(host);
    expect(host.g.phase).toBe('over');
  });
});
