# Game Plan: Bidstorm

> **Addendum (during build): modes + countdown.** The game shipped with three
> modes (`src/modes.ts`) rather than one, and a 3·2·1·GO before each round
> (`src/countdown.ts`). The modes pull deliberately different levers — information
> (Foresight shows the next two prizes), deck size (Blitz cuts to seven), and
> scoring (Blitz *voids* a tied prize instead of carrying it, which inverts what a
> tie is for). Consequences that rippled through the plan below: "thirteen" is now
> the *Classic* deck and mode-agnostic code reads `g.prizes.length`; the mode
> decides the round clock; and the mode had to become part of the netcode contract
> — it travels **frozen in the round start** via `rematch.ts`'s new `roundOpts`,
> exactly like the roster, because a mode each peer read from its own menu is a
> deck size two peers can silently disagree about. The share link carries the mode
> for the same reason. Solo runs with **no** round clock at all (see below).

## Overview
- **Name:** Bidstorm
- **Repo name:** bidstorm
- **Tagline:** Every player holds the same thirteen cards — spend them to win the prizes, and never spend more than you had to.
- **Genre (directory category):** card

## Core Loop

A prize card flips face up. Everyone secretly picks one card from their hand and
commits it. Reveal: **highest bid takes the prize**. Every card played is burned
forever, by everyone.

That is the whole game, and it is a vice. You start with the *identical* hand —
1 through 13 — as every opponent, so there is no luck in what you hold, only in
what order the prizes come out. Winning the 13-prize with your 13 feels great
until round nine, when a 12 shows up and you are holding a 4. Spending your 13 to
take a 2 is a disaster you will absolutely talk yourself into.

The twist that makes it readable rather than a guessing game: **every hand is
public**. Cards played are revealed, and everyone began with the same thirteen —
so you can always see exactly what each opponent still holds. When only you and
one rival remain and you can both see they are holding the 11 and you are holding
the 12, the next prize is not a guess. It is a decision.

- **A tie for the highest bid wins nothing.** The prize *carries over* and the
  next round is worth both — cards burned, pot grows. Two players stubbornly
  matching each other is how a 3-point prize becomes a 24-point pot.
- **Win:** most points after all 13 prizes. 91 points on the table.
- **Lose:** someone out-spends you. There is no failure state, only a scoreline.
- **Solo:** instant. Tap Play and you are bidding against bots inside 5 seconds.

## Controls
- **Desktop:** click a card to arm it, click **Bid** (or press Enter/Space) to
  commit. Number keys 1–9 and Q/W/E/R for 10–13 arm directly. Esc closes panels.
- **Mobile:** tap a card in the fanned hand to arm it, tap the big **Bid** button
  to commit. No D-pad — this is a tap game, so `patterns/input.ts` is not needed.
  Cards are ≥44px targets and the hand scrolls horizontally if it must.

## Multiplayer
- **Mode:** live P2P **and** async-seed (share a seed so a friend plays the same
  prize order solo, then compare scorelines).
- **Players:** 2–6.
- **Topology:** **host-authoritative star.** The prize order is derived on every
  peer from the shared round seed via `rng.ts`, so it is never transmitted.

**Channels (≤12 bytes):**
- `bid` — client→host, `{r, c}`: the round number and the card committed. Round
  number is included so a late packet from a previous round is dropped, not
  applied to the current one.
- `snap` — host→all, the authoritative round state: round number, phase,
  who-has-committed flags, revealed bids (only once the phase is `reveal`),
  scores, pot, and the full round history. It is small (13 rounds × 6 players of
  small ints) and sending the whole thing means **a peer that joins late, drops a
  packet, or gets promoted to host is instantly whole again** — no deltas to
  reconcile. Broadcast on every state change plus a 500ms `setInterval` keepalive.

**Room entry:** `createRoomEntry(...)` — **Create a room** or type a code and
**Join**. The invite link is a convenience. `?room=` is consumed once and cleared
via `clearRoomInUrl()` on the way out.

**Late joiner:** a peer arriving mid-round is seated as a **spectator** for the
remainder of that round — it receives snapshots and watches the table live, and
it is in the roster for the next round's vote. It is never dropped on a black
screen, and it still reaches the results screen with everyone else.

**A peer leaves mid-game:** the host marks that seat `gone` and **auto-bids their
lowest remaining card** the moment the round would otherwise stall. The game never
waits on an empty chair. Their score stays on the board, greyed, so the round can
still finish honestly.

**The 30-second round clock:** host-only, on `setInterval` (never rAF — a
backgrounded host must not freeze the room). If a player has not committed when it
expires, the host auto-bids their **lowest** card. This is what makes an AFK
player, a closed tab, and a phone that locked all the same, survivable thing.

**If the host leaves — the takeover.** `net.ts` promotes exactly one survivor and
fires `onHostChange`; `Match.setHost(true)` is wired to it and does the work:
1. The promoted peer **adopts its last received snapshot as canonical** — it was
   already storing every one, precisely so it can.
2. It **re-broadcasts** it immediately, so the room agrees on who is now speaking.
3. It **starts the host-only timers** it never ran as a client: the round clock
   and the snapshot keepalive.
4. It resolves any round that was already complete but never revealed (the old
   host may have died holding the last bid).

The game keeps running and can still reach its final scoreline. Wired via
`createNet(..., { onHostChange, onPeerLeave, onPeers })` — never bare. Proven by
`tests/takeover.test.ts` **and** the manual host-leave smoke test.

**Fairness disclosure (honest, in About):** the host's browser collects bids and
reveals them together; it never renders another player's bid before the reveal.
A modified client could peek, so this is a game for people you would play cards
with in person — not a tournament. Stated plainly rather than implied.

## End of round → rematch (MANDATORY, live P2P)

The session is a **loop**: lobby → 13 prizes → results → rematch → results…
The Net and the whole peer mesh **stay up for the room's entire life**. There is
exactly one `createNet` call per session; `net.leave()` happens only on the way
back to the menu. A rematch is a vote plus a new round number, nothing more —
`patterns/rematch.ts` (`createRounds`) owns it, and the host broadcasts the new
seed **and the frozen roster** so every peer indexes players identically.

- **"Play again"** calls `rounds.vote()`. The results screen shows who has voted,
  live, and the **visible grace countdown** once quorum is reached.
- **A player who declines or closes the tab** does not hold the room: quorum plus
  the 8s countdown starts the next match without them. The host can **force start**
  at any time.
- **If the host leaves on the results screen**, the promoted peer runs the rematch,
  inheriting no tally (`rematch.ts`'s resync poll re-collects the votes).
- **Persists across rounds:** a running **match tally** — matches won per player,
  displayed as a series score ("Ben 2 — 1 Sam"). Cards, prizes and points reset.
- **Back to lobby** is offered and does **not** leave the room. Menu does.

## Everyone's result, every time (principle #9)

The results screen is a **full round-by-round table**: all 13 prizes down the
side, every player's bid across, the winner of each row highlighted. Not a name
and a number — what each player actually *did*.

And Bidstorm has a knowable perfect answer per row, so it shows **what everyone
missed**:
- **Overspend** — you won a prize with your 12 when your 6 would also have taken
  it. The table shows the cheapest card that would have won each row, and each
  player's total wasted pips.
- **Missed steals** — rounds you lost while holding a card that would have won.

Every player reaches this screen: it renders from the snapshot's history, so a
spectator, a player whose seat went `gone`, and the host all get the identical
table. There is no path where a peer sits on a frozen board instead.

## Juice Plan
- **Prize card slams** in from above with an eased overshoot; a **screen shake**
  scaled to the prize's value (the 13 hits hard). Sound: `flip`.
- **Arming a card** lifts it out of the fan, tilts it, and glows in your colour.
  Sound: `blip`.
- **Committing:** the card whooshes to the centre and lands **face down**. A
  "committed" pip lights next to each player's name as their bid lands, so the
  wait has visible progress. Sound: `commit`.
- **The reveal** is the moment: all bids flip face up in sequence, 90ms apart —
  a 3D `rotateY` flip — then the winner's card **pulses**, fires a particle burst
  in their colour, and the pot counts up into their score with a rolling number.
  Sound: `flip` × N, then `win` or `lose`.
- **A tie** cracks: red flash, both cards shatter into particles, the pot badge
  swells and a lightning arc drags it to the next round. Sound: `tie`.
- **The last round** slows to a 600ms hold before the reveal. It earns it.
- **`prefers-reduced-motion`:** no shake, no particles, flips become 120ms
  cross-fades. The game stays fully legible — juice degrades, never gates.

## Style Direction
**Vibe:** neon casino-noir — dark felt, cards that glow rather than gleam.
**Palette:** ink `#0d1117` felt, `#161d2b` panels, cards in bone `#f2f4ff`.
Players take **Okabe–Ito** colour-blind-safe hues: blue `#56b4e9`, orange
`#e69f00`, green `#009e73`, vermillion `#d55e00`, purple `#cc79a7`, yellow
`#f0e442`. Chosen because it is the standard palette *designed* for deuteranopia
and protanopia — and every player is additionally tagged by **name and initial**,
so colour is never the only channel carrying identity.
**Theme:** dark.
**Reference feel:** the tactility of a good digital card game; the readability of
a well-made 2048.

## Technical Architecture
- **Stack:** Vanilla TypeScript + Vite. No React — this is one screen with a
  handful of states, and hand-written DOM keeps the bundle tiny.
- **Render:** **DOM/CSS.** Cards are text and shape; DOM gives crisp type, free
  hit targets, trivial responsive layout, and real accessibility. Particles and
  shake ride on a small canvas overlay (`fx.ts`) pinned behind the cards, so the
  juice never costs the DOM its legibility.
- **Engine modules copied from `patterns/`:** `net`, `rematch`, `lobby`, `rng`,
  `sound`, `storage`, `mobile` (+ `mobile.css`), `identity`. **Not** `loop.ts`
  (turn-based — no fixed-timestep sim) and **not** `input.ts` (no D-pad; taps).
- **Persistence:** `storage.ts` — mute, player name, best solo score per
  difficulty, series tally, "how to play seen".

## Non-Goals
- No commit–reveal cryptography. Host-authoritative collection, honestly
  disclosed. (Noted in EXPANSION_IDEAS if it ever matters.)
- No online ranking, accounts, or persistence beyond this browser.
- No 3+ player "highest unique bid" variant — ties carry the pot, one rule.
- No service worker.

## How To Play (player-facing copy)

> A prize card flips. Everyone secretly plays one card from their hand — and
> everyone holds the same thirteen, 1 to 13.
>
> **Highest bid wins the prize.** Tied for highest? Nobody wins it and the pot
> carries into the next round.
>
> Every card you play is gone for good. Spend big to win big, and watch what your
> rivals have left — you can see their whole hand.
>
> Most points after 13 prizes wins.
