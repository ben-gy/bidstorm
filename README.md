# Bidstorm

**Every player holds the same thirteen cards — spend them to win the prizes, and never spend more than you had to.**

🎮 Play: https://bidstorm.benrichardson.dev

## What it is

A prize card flips face up. Everyone secretly plays one card from their hand, and
the highest bid takes the prize. Every card you play is burned forever.

There is no luck in what you hold: you start with the *identical* hand — 1 to 13 —
as every opponent, so the only thing chance decides is the order the prizes come
out in. Winning the 13-prize with your King feels great until round nine, when a
Queen shows up and you're holding a 4. Spending your King to take a 2 is a
disaster you will absolutely talk yourself into.

The twist that makes it a decision rather than a guess: **every hand is public**.
Everyone began with the same thirteen and every card played is revealed, so you
can always see exactly what your rivals still hold. And a tie for the highest bid
wins *nothing* — the pot carries into the next round, so two players stubbornly
matching each other is how a 3-point prize becomes a 24-point pot.

Solo is the front door: tap Play and you're bidding against bots inside five
seconds. Multiplayer is the same game with the guessing put back in.

## How to play

- **Desktop:** click a card to arm it, then **Bid**. Number keys `1`–`9` and
  `Q W E R` for 10–13 arm directly; `Enter` commits.
- **Mobile:** tap a card, then the big **Bid** button.
- **Goal:** most points after all the prizes are gone. 91 are on the table in
  Classic.

## Modes

- **Classic** — thirteen prizes in the dark. Ties carry the pot; stand-offs get rich.
- **Foresight** — the next two prizes are face up. Same deck, same scoring, and a
  different game: you stop reacting and start planning, and so does everyone else.
- **Blitz** — seven cards, twelve seconds, and a tie *burns* the prize instead of
  banking it. That inverts what a tie is for — you match on purpose to destroy a
  pot your rival was about to take.

## Multiplayer

**Live P2P, 2–6 players.** Create a room and share the 4-character code (or the
invite link), or type a friend's code to join. Host-authoritative: the host's
browser collects everyone's cards and turns them over together.

There is **no game server**. Browsers connect directly to each other over WebRTC;
a free public signaling relay only introduces them and then gets out of the way.
Nothing is stored anywhere.

- The prize order never crosses the wire — every peer derives it from a shared seed.
- A live bid is never in the bytes: while a round is open, each peer receives a
  snapshot masked to itself.
- **If the host leaves, the game keeps going.** A survivor is promoted, adopts the
  last snapshot, and can still play the match to its final scoreline.
- Nothing waits forever: a 30-second round clock (12 in Blitz) plays the lowest
  card for anyone who's left, locked their phone, or gone to make tea.
- "Play again" never touches the room — a rematch is a vote and a new round.

**Being straight about secret bids:** the host's browser sees the cards before it
reveals them, and never shows a bid early — but a modified client could peek. This
is a game for people you'd play cards with in person, not a tournament.

**Async challenge:** the results screen shares a link carrying the seed and mode,
so a friend plays the exact same deal solo and compares scorelines.

## Tech

- Vite 6 + vanilla TypeScript
- DOM/CSS rendering, with a canvas overlay for particles and screen shake
- Shared engine: Trystero P2P netcode, seeded RNG, procedural audio, one-room
  rematch protocol
- Vitest for logic, P2P-sync determinism, host-transfer takeover, and the
  netcode's one-join invariant
- GitHub Pages hosting

No cookies, no fingerprinting, no third-party fonts, no service worker. Anonymous,
cookie-less page-view counts via Cloudflare Web Analytics.

## Local dev

```bash
npm install
npm run dev
npm test
npm run build
npm run preview
npm run icons   # regenerate the home-screen icons from the mark
```

## license

[GNU Affero General Public License v3.0 or later](./LICENSE), with an attribution
requirement added under section 7(b) — see
[ADDITIONAL-TERMS.md](./ADDITIONAL-TERMS.md).

In short: you may run, modify, redistribute and even sell this, but if you
distribute it — or run a modified version where other people can reach it — you
have to publish your source under the same licence and keep the attribution. A
separate commercial licence without those obligations is available on request:
<hi@ben.gy>.

Third-party components keep their own licences — see
[THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md).
