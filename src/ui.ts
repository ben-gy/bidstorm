/**
 * ui.ts — the table: the prize, the opponents, your hand, the clock.
 *
 * Hand-written DOM rather than a framework. The screen is one layout with a
 * handful of states, so a framework would cost more than it saved — and the
 * structure below is stable enough that updates only ever patch text, classes
 * and the hand.
 *
 * The one piece of information that makes this game a decision rather than a
 * guess is on screen at all times: EVERY opponent's remaining cards. Everyone
 * started with the same thirteen and every card played is public, so hiding
 * them would only mean asking players to remember what the game already knows.
 */

import { currentPot, currentPrize, upcomingPrizes, type GameState } from './game';
import { makeDraggable } from '@ben-gy/game-engine/drag';

/** Pull a card up this far (px) to bid it outright. */
const PLAY_DY = 55;

/**
 * Okabe–Ito. Chosen because it is the palette designed for deuteranopia and
 * protanopia rather than merely checked against them. Colour is never alone:
 * every player also carries their name and initial.
 */
export const SEAT_COLORS: readonly string[] = Object.freeze([
  '#56b4e9',
  '#e69f00',
  '#009e73',
  '#d55e00',
  '#cc79a7',
  '#f0e442',
]);

export interface UiSeat {
  name: string;
  isSelf: boolean;
}

export interface UiView {
  /** Null when nothing is being waited on. */
  timeLeftMs: number | null;
  /** The card the player has picked but not yet committed. */
  armed: number | null;
  /** Watching rather than playing (joined mid-round). */
  spectating: boolean;
  /** Live P2P and the mesh has not settled — say so rather than look broken. */
  connecting: boolean;
}

export interface GameUi {
  update(g: GameState, view: UiView): void;
  /** The DOM node of a revealed bid, for particles to fire from. */
  bidCardEl(player: number): Element | null;
  prizeEl(): Element | null;
  fxCanvas(): HTMLCanvasElement;
  shakeTarget(): HTMLElement;
  /** Announce something transient (host transfer, a peer leaving). */
  flash(msg: string): void;
  destroy(): void;
}

export interface GameUiConfig {
  container: HTMLElement;
  seats: UiSeat[];
  selfSeat: number;
  onArm: (card: number) => void;
  onBid: () => void;
  /** Play a card outright (arm + commit) — the drag / flick-up gesture. */
  onPlay: (card: number) => void;
  onMenu: () => void;
  onMute: () => void;
  muted: () => boolean;
}

const FACE: Record<number, string> = { 11: 'J', 12: 'Q', 13: 'K' };
/** Cards read as cards, not integers. 11..13 get faces; the rest are pips. */
export const cardFace = (c: number): string => FACE[c] ?? String(c);

export function createGameUi(cfg: GameUiConfig): GameUi {
  const { container, seats, selfSeat } = cfg;

  container.innerHTML = `
    <div class="table-screen">
      <header class="hud">
        <button class="icon-btn" type="button" data-act="menu" aria-label="Back to menu">&#9664;</button>
        <div class="hud-mid">
          <span class="round-pill" data-el="round">Round 1</span>
          <span class="clock" data-el="clock" aria-live="off"></span>
        </div>
        <button class="icon-btn" type="button" data-act="mute" aria-label="Toggle sound" data-el="mute"></button>
      </header>

      <ul class="players" data-el="players"></ul>

      <div class="felt" data-el="felt">
        <canvas class="fx-canvas" data-el="fx" aria-hidden="true"></canvas>
        <div class="felt-inner" data-el="shake">
          <div class="prize-zone">
            <div class="prize-card" data-el="prize"><span class="pc-value">—</span></div>
            <div class="pot-badge" data-el="pot">Pot 0</div>
            <p class="carry-note" data-el="carry" hidden></p>
            <div class="next-prizes" data-el="next" hidden></div>
          </div>
          <div class="bid-row" data-el="bids"></div>
          <p class="felt-status" data-el="status"></p>
        </div>
      </div>

      <div class="hand-zone">
        <p class="hand-label" data-el="handlabel">Your hand</p>
        <div class="hand" data-el="hand" role="group" aria-label="Your hand"></div>
        <button class="bid-btn" type="button" data-el="bidbtn" disabled>Pick a card</button>
      </div>

      <div class="flash" data-el="flash" role="status" aria-live="polite"></div>
    </div>`;

  const el = <T extends Element = HTMLElement>(name: string): T =>
    container.querySelector<T>(`[data-el="${name}"]`)!;

  const roundEl = el('round');
  const clockEl = el('clock');
  const muteEl = el<HTMLButtonElement>('mute');
  const playersEl = el<HTMLUListElement>('players');
  const prizeEl = el('prize');
  const potEl = el('pot');
  const carryEl = el('carry');
  const nextEl = el('next');
  const bidsEl = el('bids');
  const statusEl = el('status');
  const handEl = el('hand');
  const handLabelEl = el('handlabel');
  const bidBtn = el<HTMLButtonElement>('bidbtn');
  const flashEl = el('flash');
  const fx = el<HTMLCanvasElement>('fx');
  const shake = el('shake');

  container.querySelector('[data-act="menu"]')?.addEventListener('click', () => cfg.onMenu());
  container.querySelector('[data-act="mute"]')?.addEventListener('click', () => {
    cfg.onMute();
    paintMute();
  });
  bidBtn.addEventListener('click', () => cfg.onBid());

  function paintMute(): void {
    muteEl.textContent = cfg.muted() ? '\u{1F507}' : '\u{1F50A}';
    muteEl.setAttribute('aria-pressed', String(cfg.muted()));
  }
  paintMute();

  // Number keys arm a card directly — the whole hand is reachable without a
  // mouse, and Enter commits. Q/W/E/R stand in for 10..13 since the row only
  // goes to 9.
  const KEYMAP: Record<string, number> = {
    '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
    q: 10, w: 11, e: 12, r: 13,
  };
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const target = ev.target as HTMLElement | null;
    if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return;
    if (ev.key === 'Enter' || ev.key === ' ') {
      if (!bidBtn.disabled) {
        ev.preventDefault();
        cfg.onBid();
      }
      return;
    }
    const card = KEYMAP[ev.key.toLowerCase()];
    if (card && !handEl.querySelector(`[data-card="${card}"][disabled]`)) {
      const btn = handEl.querySelector<HTMLButtonElement>(`[data-card="${card}"]`);
      if (btn) cfg.onArm(card);
    }
  };
  window.addEventListener('keydown', onKey);

  let handKey = '';
  let playersKey = '';
  let bidsKey = '';
  let flashTimer: ReturnType<typeof setTimeout> | undefined;

  function paintPlayers(g: GameState): void {
    const key = JSON.stringify([g.scores, g.gone, g.bids.map((b) => b !== null), g.hands, g.phase]);
    if (key === playersKey) return;
    playersKey = key;

    playersEl.innerHTML = seats
      .map((s, i) => {
        const color = SEAT_COLORS[i % SEAT_COLORS.length];
        const committed = g.bids[i] !== null;
        // Their whole remaining hand, always. It is public information by the
        // rules; showing it is the difference between a decision and a guess.
        const cards = g.hands[i]
          .map((c) => `<span class="mini-card">${cardFace(c)}</span>`)
          .join('');
        return `<li class="player ${s.isSelf ? 'is-self' : ''} ${g.gone[i] ? 'is-gone' : ''}"
                    style="--seat:${color}">
          <div class="p-top">
            <span class="p-dot" aria-hidden="true"></span>
            <span class="p-name">${escapeHtml(s.name)}${s.isSelf ? ' (you)' : ''}</span>
            ${g.gone[i] ? '<span class="p-tag">left</span>' : ''}
            ${committed && g.phase === 'bidding' ? '<span class="p-tag ok">in</span>' : ''}
            <span class="p-score">${g.scores[i]}</span>
          </div>
          <div class="p-cards" aria-label="${escapeHtml(s.name)} holds ${g.hands[i].map(cardFace).join(', ') || 'nothing'}">${cards}</div>
        </li>`;
      })
      .join('');
  }

  function paintBids(g: GameState): void {
    const revealed = g.phase !== 'bidding';
    const key = JSON.stringify([g.round, g.phase, g.bids]);
    if (key === bidsKey) return;
    bidsKey = key;

    if (!revealed) {
      // Face-down backs, one per player who has committed: the wait has visible
      // progress rather than a spinner and a promise.
      bidsEl.innerHTML = seats
        .map((s, i) =>
          g.bids[i] !== null
            ? `<div class="bid-card back" style="--seat:${SEAT_COLORS[i % SEAT_COLORS.length]}"
                    data-bid="${i}" aria-label="${escapeHtml(s.name)} has committed"></div>`
            : '',
        )
        .join('');
      return;
    }

    const bids = g.bids.map((b) => b as number);
    const high = Math.max(...bids);
    const tied = bids.filter((b) => b === high).length > 1;
    bidsEl.innerHTML = seats
      .map((s, i) => {
        const win = !tied && bids[i] === high;
        return `<div class="bid-card up ${win ? 'is-win' : ''} ${tied && bids[i] === high ? 'is-tie' : ''}"
                     style="--seat:${SEAT_COLORS[i % SEAT_COLORS.length]}; --i:${i}"
                     data-bid="${i}">
          <span class="bc-value">${cardFace(bids[i])}</span>
          <span class="bc-name">${escapeHtml(s.name)}</span>
        </div>`;
      })
      .join('');
  }

  function paintHand(g: GameState, view: UiView): void {
    if (selfSeat < 0) {
      handLabelEl.textContent = 'Watching this round';
      const key = 'spectator';
      if (key !== handKey) {
        handKey = key;
        handEl.innerHTML = '';
      }
      bidBtn.disabled = true;
      bidBtn.textContent = 'Watching';
      return;
    }

    const hand = g.hands[selfSeat];
    const mine = g.bids[selfSeat];
    const key = JSON.stringify([hand, view.armed, mine, g.phase]);
    if (key !== handKey) {
      handKey = key;
      handEl.innerHTML = hand
        .map((c) => {
          const armed = view.armed === c;
          const spent = mine === c && g.phase !== 'bidding';
          return `<button class="card ${armed ? 'is-armed' : ''} ${spent ? 'is-spent' : ''}"
                          type="button" data-card="${c}"
                          aria-pressed="${armed}"
                          ${g.phase !== 'bidding' || mine !== null ? 'disabled' : ''}>
            <span class="c-value">${cardFace(c)}</span>
          </button>`;
        })
        .join('');
      handEl.querySelectorAll<HTMLButtonElement>('.card').forEach((btn) => {
        const card = Number(btn.dataset.card);
        // Tap still arms (then Bid), but a card also wants to be PLAYED with a
        // gesture: lift it up toward the felt and let go — or flick it up — to bid
        // it outright. Horizontal stays with the browser (pan-x) so a long hand
        // still scrolls; only the upward pull is ours.
        const reset = (): void => {
          btn.classList.remove('is-dragging', 'will-play');
          btn.style.transform = '';
        };
        makeDraggable(btn, {
          onTap: () => cfg.onArm(card),
          onDragStart: () => btn.classList.add('is-dragging'),
          onDragMove: (_dx, dy) => {
            btn.style.transform = `translateY(${Math.min(0, dy)}px)`;
            btn.classList.toggle('will-play', dy < -PLAY_DY);
          },
          onDrop: (_dx, dy) => {
            reset();
            if (dy < -PLAY_DY) cfg.onPlay(card);
          },
          onSwipe: (dir) => {
            reset();
            if (dir === 'up') cfg.onPlay(card);
          },
          onCancel: reset,
        });
      });
    }

    if (g.phase !== 'bidding') {
      bidBtn.disabled = true;
      bidBtn.textContent = mine !== null ? `You played ${cardFace(mine)}` : 'Cards down';
    } else if (mine !== null) {
      bidBtn.disabled = true;
      bidBtn.textContent = 'Committed — waiting';
    } else if (view.armed === null) {
      bidBtn.disabled = true;
      bidBtn.textContent = 'Pick a card';
    } else {
      bidBtn.disabled = false;
      bidBtn.textContent = `Bid ${cardFace(view.armed)}`;
    }
  }

  return {
    update(g, view) {
      // The deck is the mode's, so the length of a match is too — Blitz is seven.
      const rounds = g.prizes.length;
      roundEl.textContent = `Round ${Math.min(g.round + 1, rounds)} / ${rounds}`;

      // Foresight's whole point, and the only thing on screen that mode adds.
      const next = upcomingPrizes(g);
      if (next.length) {
        nextEl.hidden = false;
        nextEl.innerHTML =
          '<span class="nx-label">Next</span>' +
          next.map((p) => `<span class="nx-card">${cardFace(p)}</span>`).join('');
      } else {
        nextEl.hidden = true;
      }

      const prize = currentPrize(g);
      const pot = currentPot(g);
      prizeEl.querySelector('.pc-value')!.textContent = prize === null ? '—' : cardFace(prize);
      prizeEl.setAttribute('data-prize', String(prize ?? 0));
      potEl.textContent = `Pot ${pot}`;
      potEl.classList.toggle('is-fat', g.carry > 0);

      if (g.carry > 0) {
        carryEl.hidden = false;
        carryEl.textContent = `+${g.carry} carried from a tie`;
      } else {
        carryEl.hidden = true;
      }

      const ms = view.timeLeftMs;
      if (ms === null) {
        clockEl.textContent = '';
        clockEl.classList.remove('is-low');
      } else {
        const s = Math.ceil(ms / 1000);
        clockEl.textContent = `0:${String(s).padStart(2, '0')}`;
        clockEl.classList.toggle('is-low', s <= 5);
      }

      statusEl.textContent = view.connecting
        ? 'Connecting to the table…'
        : g.phase === 'reveal'
          ? ''
          : view.spectating
            ? 'You joined mid-round — you deal in on the next one.'
            : g.bids[selfSeat] !== null
              ? 'Waiting for the others…'
              : '';

      paintPlayers(g);
      paintBids(g);
      paintHand(g, view);
    },

    bidCardEl(player) {
      return bidsEl.querySelector(`[data-bid="${player}"]`);
    },
    prizeEl: () => prizeEl,
    fxCanvas: () => fx,
    shakeTarget: () => shake,

    flash(msg) {
      flashEl.textContent = msg;
      flashEl.classList.add('show');
      if (flashTimer) clearTimeout(flashTimer);
      flashTimer = setTimeout(() => flashEl.classList.remove('show'), 2600);
    },

    destroy() {
      window.removeEventListener('keydown', onKey);
      if (flashTimer) clearTimeout(flashTimer);
    },
  };
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}
