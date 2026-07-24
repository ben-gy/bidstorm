// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * main.ts — bootstrap and screen flow. Owns no game rules.
 *
 * Screens: menu → (solo | room entry → lobby) → table → results ⟳
 *
 * The one structural rule here: a live-P2P session calls createNet ONCE and
 * holds the room until the player walks back to the menu. Every rematch happens
 * inside that room via @ben-gy/game-engine/rematch. Leaving and rejoining to
 * "reset" is the bug that shipped twice in this factory; the engine's net.ts now
 * throws if you try, and the shape of this file is what makes it never come up.
 */

// mobile.css FIRST — it is the baseline main.css is allowed to override, not
// the other way round.

import './styles/mobile.css';
import './styles/main.css';
import { hardenViewport } from '@ben-gy/game-engine/mobile';
import { createStore } from '@ben-gy/game-engine/storage';
import { createSfx } from './engine/sound';
import { createNet, roomAppId, setTurnConfig, type Net } from '@ben-gy/game-engine/net';
import { getTurnConfig } from '@ben-gy/game-engine/turn';
import { createRounds, type Rounds, type RoundPlayer } from '@ben-gy/game-engine/rematch';
import {
  clearRoomInUrl,
  createLobby,
  createRoomEntry,
  normalizeRoomCode,
  setRoomInUrl,
} from '@ben-gy/game-engine/lobby';
import { resolveName, withName } from '@ben-gy/game-engine/identity';
import { newSeed } from '@ben-gy/game-engine/rng';
import { Match, CH_BID, CH_SNAP, type BidMsg } from './match';
import { MAX_PLAYERS, MIN_PLAYERS, type GameState, type Snapshot } from './game';
import { DEFAULT_MODE, modeOf, MODES, pointsOf, roundsOf, type ModeId } from './modes';
import { createCountdown, type Countdown } from './countdown';
import { BOT_PROFILES, DIFFICULTY_BLURBS, DIFFICULTY_LABELS, type Difficulty } from './bot';
import { createGameUi, cardFace, escapeHtml, SEAT_COLORS, type GameUi } from './ui';
import { renderResults, type ResultsScreen } from './results';
import { createFx, type Fx } from './fx';

const SLUG = 'bidstorm';
const HUB = 'https://hub.benrichardson.dev';

// Before anything renders: iOS ignores the viewport meta's user-scalable=no, so
// a double-tap or a pinch zooms into a live table with no way back out.
hardenViewport();

/**
 * TURN credentials, fetched at BOOT rather than at join time.
 *
 * Without relays, ICE is STUN-only, and two phones on carrier CGNAT see each
 * other in signaling while the data channel never opens — the "I'm in the room
 * and nobody's here" report. And it has to be set before the FIRST mesh on the
 * page: Trystero builds one global pool of pre-made peer connections from
 * whichever joinRoom fires first, so a later call leaves the initiating half of
 * every pair turnless. Starting the fetch here means it is long resolved by the
 * time anyone taps "Play with friends"; joinRoom awaits it anyway, and
 * getTurnConfig fails open to [] so a dead endpoint can never block a join.
 */
const turnReady: Promise<void> = getTurnConfig().then(setTurnConfig);

const store = createStore(SLUG);
const sfx = createSfx(store.get('muted', false));
const app = document.querySelector<HTMLElement>('#app')!;

let net: Net | null = null;
let rounds: Rounds | null = null;
let lobby: { destroy: () => void } | null = null;
let roomEntry: { destroy: () => void } | null = null;
let match: Match | null = null;
let gameUi: GameUi | null = null;
let fx: Fx | null = null;
let results: ResultsScreen | null = null;
let countdown: Countdown | null = null;
let clock: ReturnType<typeof setInterval> | null = null;
let keepalive: ReturnType<typeof setInterval> | null = null;
let againTick: ReturnType<typeof setInterval> | null = null;
/** Detaches THIS round's receivers from the shared Net (see wireRound). */
let unwireRound: (() => void) | null = null;
let roomCode = '';
let armed: number | null = null;
/** Matches won, by peer id, for the life of the room. */
const series = new Map<string, number>();

const playerName = resolveName(store, () => 'Player');

/**
 * The mode to play. A challenge link's mode WINS over the menu, because the deal
 * it is promising only exists in the mode it was played in — a shared seed read
 * with the wrong deck is a different game wearing the same link.
 *
 * Otherwise: whatever this player last chose. Validated either way, since
 * neither a URL nor localStorage is a contract.
 */
function storedMode(): ModeId {
  if (challengeMode) return challengeMode;
  return modeOf(store.get<string>('mode', DEFAULT_MODE)).id;
}

/**
 * A ?room= in the URL (an invite link) is honoured ONCE. Leave it live and a
 * reload — or reopening from a home-screen icon — silently drags the player back
 * into a room they left, with no way to start a fresh one.
 */
let pendingRoom: string | null = (() => {
  const c = normalizeRoomCode(new URL(location.href).searchParams.get('room') ?? '');
  return c.length >= 3 ? c : null;
})();

/** ?seed= is the async challenge: play the exact deal a friend just played. */
const challengeSeed: number | null = (() => {
  const raw = new URL(location.href).searchParams.get('seed');
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n >>> 0 : null;
})();

/** The mode that deal was played in. Only meaningful alongside ?seed=. */
const challengeMode: ModeId | null = (() => {
  const raw = new URL(location.href).searchParams.get('mode');
  return challengeSeed !== null && raw ? modeOf(raw).id : null;
})();

const unlock = (): void => sfx.unlock();
window.addEventListener('pointerdown', unlock, { once: true });
window.addEventListener('keydown', unlock, { once: true });

// A tab closing mid-match must free its seat rather than leave the table waiting
// out a 30s clock on a chair that will never be filled.
window.addEventListener('pagehide', () => {
  void net?.leave();
});

// ── screens ─────────────────────────────────────────────────────────────────

function clearScreen(): void {
  // Before the timers: a countdown left running would start a match on a screen
  // that no longer exists.
  countdown?.cancel();
  countdown = null;
  if (clock) clearInterval(clock);
  if (keepalive) clearInterval(keepalive);
  if (againTick) clearInterval(againTick);
  clock = keepalive = againTick = null;
  unwireRound?.();
  unwireRound = null;
  match?.destroy();
  match = null;
  gameUi?.destroy();
  gameUi = null;
  fx?.destroy();
  fx = null;
  results?.destroy();
  results = null;
  lobby?.destroy();
  lobby = null;
  roomEntry?.destroy();
  roomEntry = null;
  armed = null;
}

async function leaveRoom(): Promise<void> {
  rounds?.destroy();
  rounds = null;
  const n = net;
  net = null;
  series.clear();
  // Awaited, so a later "Play with friends" can legitimately join again — the
  // registry in net.ts throws on a rejoin that races the teardown.
  if (n) await n.leave();
  clearRoomInUrl();
}

function showMenu(): void {
  clearScreen();
  void leaveRoom();

  const diff = store.get<Difficulty>('difficulty', 'sharp');
  const bots = store.get<number>('bots', 1);
  const mode = storedMode();

  app.innerHTML = `
    <div class="screen menu-screen">
      <main class="main-content">
        <div class="brand">
          <h1 class="title">Bidstorm</h1>
          <p class="tagline">Everyone holds the same thirteen cards.<br />Spend them well.</p>
        </div>

        ${
          challengeSeed !== null
            ? `<p class="challenge-note">You've been sent a deal — the same thirteen prizes, in the same order. Beat their score.</p>`
            : ''
        }

        <label class="name-field">
          <span>Your name</span>
          <input type="text" data-el="name" maxlength="16" value="${escapeHtml(playerName)}"
                 autocomplete="off" spellcheck="false" aria-label="Your name" />
        </label>

        <div class="opt">
          <span class="opt-label">Mode</span>
          <div class="seg" role="group" aria-label="Game mode">
            ${MODES.map(
              (m) => `<button class="seg-btn ${m.id === mode ? 'on' : ''}" type="button"
                         data-mode="${m.id}" aria-pressed="${m.id === mode}">${m.name}</button>`,
            ).join('')}
          </div>
          <p class="opt-blurb">${escapeHtml(modeOf(mode).blurb)}</p>
        </div>

        <div class="opt">
          <span class="opt-label">Opponents</span>
          <div class="seg" role="group" aria-label="Number of opponents">
            ${[1, 2, 3]
              .map(
                (n) => `<button class="seg-btn ${n === bots ? 'on' : ''}" type="button"
                           data-bots="${n}" aria-pressed="${n === bots}">${n}</button>`,
              )
              .join('')}
          </div>
        </div>

        <div class="opt">
          <span class="opt-label">Difficulty</span>
          <div class="seg" role="group" aria-label="Difficulty">
            ${(['casual', 'sharp', 'ruthless'] as Difficulty[])
              .map(
                (d) => `<button class="seg-btn ${d === diff ? 'on' : ''}" type="button"
                           data-diff="${d}" aria-pressed="${d === diff}">${DIFFICULTY_LABELS[d]}</button>`,
              )
              .join('')}
          </div>
          <p class="opt-blurb" data-el="blurb">${DIFFICULTY_BLURBS[diff]}</p>
        </div>

        <div class="menu-actions">
          <button class="btn primary big" type="button" data-act="solo">Play</button>
          <button class="btn big" type="button" data-act="friends">Play with friends</button>
        </div>

        <div class="menu-links">
          <button class="btn ghost" type="button" data-act="how">How to play</button>
          <button class="btn ghost" type="button" data-act="about">About</button>
          <button class="btn ghost" type="button" data-act="mute" data-el="mute"></button>
        </div>
      </main>
      ${footer()}
    </div>`;

  const nameInput = app.querySelector<HTMLInputElement>('[data-el="name"]')!;
  nameInput.addEventListener('change', () => {
    const v = nameInput.value.trim().slice(0, 16) || 'Player';
    nameInput.value = v;
    store.set('name', v);
  });

  app.querySelectorAll<HTMLButtonElement>('[data-bots]').forEach((b) =>
    b.addEventListener('click', () => {
      store.set('bots', Number(b.dataset.bots));
      sfx.play('blip');
      showMenu();
    }),
  );
  app.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) =>
    b.addEventListener('click', () => {
      store.set('mode', b.dataset.mode);
      sfx.play('blip');
      showMenu();
    }),
  );
  app.querySelectorAll<HTMLButtonElement>('[data-diff]').forEach((b) =>
    b.addEventListener('click', () => {
      store.set('difficulty', b.dataset.diff as Difficulty);
      sfx.play('blip');
      showMenu();
    }),
  );

  app.querySelector('[data-act="solo"]')?.addEventListener('click', () => startSolo());
  app.querySelector('[data-act="friends"]')?.addEventListener('click', () => showRoomEntry());
  app.querySelector('[data-act="how"]')?.addEventListener('click', () => showModal('how'));
  app.querySelector('[data-act="about"]')?.addEventListener('click', () => showModal('about'));
  wireMute(app.querySelector('[data-el="mute"]'));

  if (!store.get('seenHow', false)) {
    store.set('seenHow', true);
    showModal('how');
  }
}

function wireMute(btn: Element | null): void {
  if (!(btn instanceof HTMLElement)) return;
  const paint = (): void => {
    btn.textContent = sfx.muted() ? 'Sound off' : 'Sound on';
    btn.setAttribute('aria-pressed', String(!sfx.muted()));
  };
  paint();
  btn.addEventListener('click', () => {
    sfx.setMuted(!sfx.muted());
    store.set('muted', sfx.muted());
    if (!sfx.muted()) sfx.play('blip');
    paint();
  });
}

function footer(): string {
  return `<footer class="site-footer">
    Built by <a href="${withName('https://benrichardson.dev/', playerName)}" target="_blank" rel="noopener">benrichardson.dev</a>
    · <a href="${withName(HUB, playerName)}" target="_blank" rel="noopener">more games, tools &amp; sites</a>
  </footer>`;
}

// ── modals ──────────────────────────────────────────────────────────────────

function showModal(which: 'how' | 'about'): void {
  const body =
    which === 'how'
      ? `<h2>How to play</h2>
         <p>A prize card flips. Everyone secretly plays one card from their hand — and everyone
            holds the same thirteen, <b>1 to 13</b>.</p>
         <p><b>Highest bid wins the prize.</b> Tied for highest? Nobody wins it, and the pot
            carries into the next round.</p>
         <p>Every card you play is gone for good. Spend big to win big — and watch what your
            rivals have left, because you can see their whole hand.</p>
         <p>Most points after ${roundsOf(storedMode())} prizes wins — there are
            ${pointsOf(storedMode())} on the table in ${escapeHtml(modeOf(storedMode()).name)}.</p>
         <p class="modal-modes">${MODES.map(
           (m) => `<b>${escapeHtml(m.name)}:</b> ${escapeHtml(m.blurb)}`,
         ).join('<br />')}</p>
         <p class="modal-keys">Tap a card, then <b>Bid</b>. On a keyboard: <b>1–9</b> and
            <b>Q W E R</b> for 10–13, <b>Enter</b> to commit.</p>`
      : `<h2>About Bidstorm</h2>
         <p>A bidding game with no luck in the deal: every player starts with the identical
            hand, so the only thing chance decides is the order the prizes arrive in.</p>
         <p>It's an original take on a classic public-domain auction game. All art and sound
            are procedural — no asset files, no third-party fonts, no cookies, no fingerprinting.
            Anonymous, cookie-less page-view counts come from Cloudflare Web Analytics.</p>
         <p><b>Playing with friends</b> connects your browsers <b>directly, peer to peer</b>. There
            is no game server and nothing is stored anywhere: a free public signaling relay only
            introduces the browsers to each other, then gets out of the way.</p>
         <p><b>Being straight with you about secret bids:</b> the host's browser collects everyone's
            cards and turns them over together, and it never shows a bid early. But a modified
            client could peek. This is a game for people you'd play cards with in person, not a
            tournament.</p>
         <p>Built by <a href="${withName('https://benrichardson.dev/', playerName)}" target="_blank" rel="noopener">benrichardson.dev</a>
            · <a href="${withName(HUB, playerName)}" target="_blank" rel="noopener">more games, tools &amp; sites</a></p>`;

  const wrap = document.createElement('div');
  wrap.className = 'modal-wrap';
  wrap.innerHTML = `<div class="modal" role="dialog" aria-modal="true">
      ${body}
      <button class="btn primary" type="button" data-act="close">Got it</button>
    </div>`;
  const close = (): void => {
    wrap.remove();
    window.removeEventListener('keydown', onEsc);
  };
  const onEsc = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') close();
  };
  wrap.addEventListener('click', (e) => {
    if (e.target === wrap) close();
  });
  wrap.querySelector('[data-act="close"]')?.addEventListener('click', close);
  window.addEventListener('keydown', onEsc);
  document.body.appendChild(wrap);
  wrap.querySelector<HTMLButtonElement>('[data-act="close"]')?.focus();
}

// ── solo ────────────────────────────────────────────────────────────────────

function startSolo(): void {
  clearScreen();
  const diff = store.get<Difficulty>('difficulty', 'sharp');
  const botCount = Math.min(store.get<number>('bots', 1), MAX_PLAYERS - 1);
  const profiles = BOT_PROFILES.slice(0, botCount);
  const seed = challengeSeed ?? newSeed();

  const seats = [
    { id: 'self', name: store.get('name', playerName) },
    ...profiles.map((p, i) => ({ id: `bot${i}`, name: p.name })),
  ];

  // The identical Match the network path uses — solo just has no peers and bots
  // in the other chairs, so the mode that gets played most is the one that gets
  // exercised most.
  startMatch({
    seed,
    seats,
    selfId: 'self',
    isHost: true,
    multiplayer: false,
    mode: storedMode(),
    bots: { difficulty: diff, styles: profiles.map((p) => p.style) },
    // No clock: there is nobody at this table to keep waiting.
    roundMs: 0,
    sendBid: () => {},
    sendSnap: () => {},
  });
}

// ── the table ───────────────────────────────────────────────────────────────

interface StartMatchArgs {
  seed: number;
  seats: { id: string; name: string }[];
  selfId: string;
  isHost: boolean;
  multiplayer: boolean;
  bots?: { difficulty: Difficulty; styles: readonly ('even' | 'greedy' | 'thrifty')[] };
  mode: ModeId;
  roundMs?: number;
  sendBid: (m: BidMsg) => void;
  sendSnap: (s: Snapshot, to?: string | string[]) => void;
}

function startMatch(args: StartMatchArgs): void {
  const selfSeat = args.seats.findIndex((s) => s.id === args.selfId);

  gameUi = createGameUi({
    container: app,
    seats: args.seats.map((s, i) => ({ name: s.name, isSelf: i === selfSeat })),
    selfSeat,
    onArm: (card) => {
      if (!match || match.g.phase !== 'bidding') return;
      if (selfSeat < 0 || match.g.bids[selfSeat] !== null) return;
      armed = armed === card ? null : card;
      sfx.play('select');
      repaint();
    },
    onBid: () => {
      if (armed === null || !match) return;
      if (match.submit(armed)) {
        sfx.play('commit');
        armed = null;
        repaint();
      }
    },
    // Drag / flick a card up to bid it outright — arm and commit in one gesture.
    onPlay: (card) => {
      if (!match || match.g.phase !== 'bidding') return;
      if (selfSeat < 0 || match.g.bids[selfSeat] !== null) return;
      if (match.submit(card)) {
        sfx.play('commit');
        armed = null;
        repaint();
      }
    },
    onMenu: () => showMenu(),
    onMute: () => {
      sfx.setMuted(!sfx.muted());
      store.set('muted', sfx.muted());
    },
    muted: () => sfx.muted(),
  });

  fx = createFx({ canvas: gameUi.fxCanvas(), shakeTarget: gameUi.shakeTarget() });

  let lastTickSecond = -1;
  let seenRound = 0;

  match = new Match({
    seed: args.seed,
    seats: args.seats,
    selfId: args.selfId,
    isHost: args.isHost,
    bots: args.bots,
    mode: args.mode,
    roundMs: args.roundMs,
    sendBid: args.sendBid,
    sendSnap: args.sendSnap,
    onUpdate: () => repaint(),
    onReveal: (g) => {
      sfx.play('flip');
      const prize = g.prizes[g.round];
      // The 13 should land harder than the 2.
      fx?.shake(3 + prize * 0.5);
      repaint();
    },
    onTrick: (t, g) => {
      if (t.winner === null) {
        sfx.play('tie');
        fx?.shake(9);
        // The pot didn't go anywhere — the cards just broke on each other.
        t.bids.forEach((_, i) => {
          const el = gameUi?.bidCardEl(i);
          if (el) fx?.burst(rect(el).x, rect(el).y, '#d55e00', 14);
        });
      } else {
        sfx.play(t.winner === selfSeat ? 'win' : 'count');
        fx?.shake(4 + t.pot * 0.35);
        const el = gameUi?.bidCardEl(t.winner);
        if (el) fx?.burstAt(el, SEAT_COLORS[t.winner % SEAT_COLORS.length], 12 + t.pot * 2);
      }
      void g;
    },
    onOver: (g) => showResults(g, args, selfSeat),
  });

  function repaint(): void {
    if (!match || !gameUi) return;
    // A card armed for the last round is stale intent: the prize has changed,
    // and leaving it lifted invites a player to commit to a decision they made
    // about a different pot. It also survives the round clock playing their
    // lowest card for them, which reads as the game ignoring their pick.
    if (match.g.round !== seenRound) {
      seenRound = match.g.round;
      armed = null;
    }
    const left = match.timeLeftMs;
    gameUi.update(match.g, {
      timeLeftMs: left,
      armed,
      spectating: match.spectating,
      connecting: args.multiplayer && !!net && !net.hostSettled(),
    });
    if (left !== null) {
      const s = Math.ceil(left / 1000);
      if (s <= 5 && s !== lastTickSecond) {
        lastTickSecond = s;
        sfx.play('tick');
      }
    }
  }

  sfx.play('deal');
  repaint();

  // 3 · 2 · 1 · GO before anyone may act. Without it whoever happened to be
  // looking at their screen gets a free head start, and the deal reads as a
  // jump-cut. The clock only starts once it lands.
  countdown = createCountdown({
    container: gameUi.shakeTarget(),
    onStep: (label) => sfx.play(label === 'GO' ? 'deal' : 'tick'),
    onDone: () => {
      countdown = null;
      match?.beginPlay();
      // setInterval, never rAF alone: a backgrounded host must keep the room
      // moving, and a rAF clock stops dead in a hidden tab.
      clock = setInterval(() => {
        match?.tick();
        repaint();
      }, 200);
      repaint();
    },
  });

  if (args.multiplayer) {
    keepalive = setInterval(() => {
      if (match?.isHost) match.resend();
    }, 1000);
  }
}

function rect(el: Element): { x: number; y: number } {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

// ── results ─────────────────────────────────────────────────────────────────

function showResults(g: GameState, args: StartMatchArgs, selfSeat: number): void {
  const won = g.scores.reduce<number[]>(
    (acc, s, i) => (s === Math.max(...g.scores) ? [...acc, i] : acc),
    [],
  );
  for (const w of won) {
    const id = args.seats[w].id;
    series.set(id, (series.get(id) ?? 0) + 1);
  }
  sfx.play(won.includes(selfSeat) ? 'win' : 'lose');

  if (args.multiplayer) {
    // Reopens voting. The room, the Net and the whole mesh stay exactly as they
    // are — a rematch is a vote and a round number, never a rejoin.
    rounds?.finish();
  }

  if (clock) clearInterval(clock);
  if (keepalive) clearInterval(keepalive);
  clock = keepalive = null;
  gameUi?.destroy();
  gameUi = null;
  fx?.destroy();
  fx = null;

  if (args.multiplayer && store.get('bestSolo', 0) === 0) {
    /* solo bests are not set from multiplayer matches */
  } else if (!args.multiplayer && g.scores[selfSeat] > store.get('bestSolo', 0)) {
    store.set('bestSolo', g.scores[selfSeat]);
  }

  results = renderResults({
    container: app,
    g,
    seats: args.seats.map((s, i) => ({ name: s.name, isSelf: i === selfSeat })),
    selfSeat,
    series: args.multiplayer ? args.seats.map((s) => series.get(s.id) ?? 0) : null,
    multiplayer: args.multiplayer,
    onAgain: () => {
      if (!args.multiplayer) return startSolo();
      const s = rounds?.state();
      if (s?.voted) rounds?.unvote();
      else rounds?.vote();
      paintAgain();
    },
    onForceStart: () => rounds?.go(),
    onLobby: () => showLobby(),
    onMenu: () => showMenu(),
    onShare: () => void share(g, args, selfSeat),
  });

  const paintAgain = (): void => {
    if (!args.multiplayer) return results?.update(null);
    const s = rounds?.state();
    if (!s) return;
    results?.update({
      voted: s.voted,
      votes: s.votes.length,
      present: s.present.length,
      startsInMs: s.startsInMs,
      isHost: s.isHost,
      canStart: s.canStart,
    });
  };
  paintAgain();
  // The grace countdown has to visibly run down, so this repaints on a timer
  // rather than only on protocol events.
  if (args.multiplayer) againTick = setInterval(paintAgain, 250);
}

async function share(g: GameState, args: StartMatchArgs, selfSeat: number): Promise<void> {
  const url = new URL(location.href);
  url.search = '';
  url.searchParams.set('seed', String(g.seed));
  // The mode rides along or the link is a lie: it decides the DECK, so a friend
  // set to Blitz would open a "same deal" link and be dealt seven cards.
  url.searchParams.set('mode', g.mode);
  const rounds = g.prizes.length;
  const text = `I scored ${g.scores[selfSeat]}/${pointsOf(g.mode)} on this Bidstorm deal${
    g.history.length
      ? ` — took the ${cardFace(Math.max(...g.history.filter((t) => t.winner === selfSeat).map((t) => t.prize), 0))} pot`
      : ''
  }. Same ${rounds} prizes, same order — beat it.`;
  const data = { title: 'Bidstorm', text, url: url.toString() };
  try {
    if (navigator.share) {
      await navigator.share(data);
      return;
    }
  } catch {
    /* cancelled — fall through to the clipboard */
  }
  try {
    await navigator.clipboard.writeText(`${text}\n${url.toString()}`);
    gameUi?.flash('Challenge link copied');
    flashToast('Challenge link copied');
  } catch {
    flashToast(url.toString());
  }
  void args;
}

function flashToast(msg: string): void {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2400);
}

// ── multiplayer ─────────────────────────────────────────────────────────────

function showRoomEntry(): void {
  clearScreen();

  // A deep link is spent once. After that "Play with friends" always offers the
  // choice — otherwise the room's creator finds this button silently re-entering
  // a finished room while their guest, who spent the link, gets the real screen.
  if (pendingRoom) {
    const code = pendingRoom;
    pendingRoom = null;
    return void joinRoom(code, false);
  }

  app.innerHTML = `<div class="screen entry-screen"><main class="main-content" data-el="slot"></main>${footer()}</div>`;
  roomEntry = createRoomEntry({
    container: app.querySelector<HTMLElement>('[data-el="slot"]')!,
    title: 'Play with friends',
    subtitle: `Start a room and share the code, or type a friend's code to join. ${MIN_PLAYERS}–${MAX_PLAYERS} players.`,
    onSubmit: (code, created) => void joinRoom(code, created),
    onCancel: () => showMenu(),
  });
}

async function joinRoom(code: string, created: boolean): Promise<void> {
  clearScreen();
  roomCode = code;
  setRoomInUrl(code);

  if (net) await leaveRoom();

  // Already resolved in practice — see turnReady. Awaited rather than assumed so
  // the very first mesh this page builds is the one that carries the relays.
  await turnReady;

  // Wired with its handlers, never bare: onHostChange IS the host transfer, and
  // a live-P2P game that omits it cannot survive its host leaving.
  net = createNet(
    { appId: roomAppId(SLUG), roomId: code, claimHost: created },
    {
      onHostChange: (_id, isSelfHost) => {
        match?.setHost(isSelfHost);
        if (isSelfHost && match) gameUi?.flash("The host left — you're running the table now");
      },
      onPeerLeave: () => match?.onPeerLeave(net?.peers() ?? []),
      onPeers: () => match?.onPeerLeave(net?.peers() ?? []),
    },
  );

  rounds = createRounds({
    net,
    playerName: store.get('name', playerName),
    minPlayers: MIN_PLAYERS,
    // Only read on the host. Everyone else is TOLD the mode in the start message,
    // because a mode each peer read from its own menu is a deck size two peers
    // can disagree about — the same seed dealing two different games.
    roundOpts: () => ({ mode: storedMode() }),
    // rematch.ts is engine code and hands opts back as `unknown` — it cannot know
    // what a game puts in there. modeOf() validates whatever arrives, so a start
    // from an older or malformed peer falls back to the default deck rather than
    // dealing a hand nobody agrees on.
    onRound: (info) =>
      startNetRound(
        info.seed,
        info.players,
        modeOf((info.opts as { mode?: string } | null)?.mode ?? '').id,
      ),
  });

  showLobby();
}

function showLobby(): void {
  clearScreen();
  if (!net || !rounds) return showMenu();
  // The secrecy disclosure sits OUTSIDE the lobby's container: createLobby owns
  // that element's innerHTML and repaints it, so anything the game wants to keep
  // on screen has to be a sibling.
  app.innerHTML = `<div class="screen entry-screen"><main class="main-content">
      <div data-el="slot"></div>
      <p class="lobby-note">Bids are collected by the host and turned over together — see About.</p>
    </main>${footer()}</div>`;
  lobby = createLobby({
    container: app.querySelector<HTMLElement>('[data-el="slot"]')!,
    net,
    rounds,
    roomCode,
    minPlayers: MIN_PLAYERS,
    maxPlayers: MAX_PLAYERS,
    onCancel: () => showMenu(),
  });
}

function startNetRound(seed: number, players: RoundPlayer[], mode: ModeId): void {
  clearScreen();
  if (!net) return;
  const n = net;

  const sendBid = n.channel<BidMsg>(CH_BID, (msg, from) => match?.onBid(msg, from));
  const sendSnap = n.channel<Snapshot>(CH_SNAP, (snap, from) => {
    // Only the elected host speaks for the table.
    if (from === n.host()) match?.onSnap(snap, from);
  });
  // Detached when the round ends: a stale receiver on a shared Net is how a dead
  // screen keeps answering peers.
  unwireRound = () => {
    sendBid.off();
    sendSnap.off();
  };

  startMatch({
    seed,
    seats: players.map((p) => ({ id: p.id, name: p.name })),
    selfId: n.selfId,
    isHost: n.isHost(),
    multiplayer: true,
    mode,
    sendBid: (m) => sendBid(m, n.host() ?? undefined),
    sendSnap: (s, to) => sendSnap(s, to),
  });

  match?.onPeerLeave(n.peers());
}

showMenu();
