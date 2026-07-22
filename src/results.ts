// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * results.ts — the scoreline, and what everyone actually did to earn it.
 *
 * This screen is not a number and a name. The end of a match is the one moment
 * players compare themselves, so it shows the WHOLE table: every round, every
 * player's card, who took it — and, because Bidstorm has a knowable right answer
 * in hindsight, what each of them left on the table.
 *
 * "What you missed" is honest here rather than hand-wavy. Bids were simultaneous,
 * so holding the rest of the table fixed, the cheapest card that beats everyone
 * else's bid is exactly what a round was worth to a player. Two things fall out:
 *  - OVERSPEND: won it with a K when the 6 in your hand would also have taken it.
 *  - MISSED: lost a round you were holding a winning card for.
 *
 * Every peer reaches this screen — it renders from the match state, which the
 * snapshot carries in full, so a spectator and an abandoned seat get the
 * identical table rather than a frozen board.
 */

import { reports, standings, winners, type GameState } from './game';
import { pointsOf } from './modes';
import { cardFace, escapeHtml, SEAT_COLORS } from './ui';

export interface ResultsSeat {
  name: string;
  isSelf: boolean;
}

/** Live-P2P rematch state, straight from rematch.ts. Null for solo. */
export interface AgainState {
  voted: boolean;
  votes: number;
  present: number;
  startsInMs: number | null;
  isHost: boolean;
  canStart: boolean;
}

export interface ResultsConfig {
  container: HTMLElement;
  g: GameState;
  seats: ResultsSeat[];
  selfSeat: number;
  /** Matches won per seat across this room's life. Null for solo. */
  series: number[] | null;
  multiplayer: boolean;
  onAgain: () => void;
  onForceStart: () => void;
  onLobby: () => void;
  onMenu: () => void;
  onShare: () => void;
}

export interface ResultsScreen {
  /** Repaint just the rematch strip — the table below it never changes. */
  update(again: AgainState | null): void;
  destroy(): void;
}

export function renderResults(cfg: ResultsConfig): ResultsScreen {
  const { container, g, seats, selfSeat } = cfg;
  const rank = standings(g);
  const won = winners(g);
  const reps = reports(g);

  const color = (i: number): string => SEAT_COLORS[i % SEAT_COLORS.length];

  const headline = (): string => {
    if (won.length > 1) {
      return `Dead heat — ${won.map((i) => escapeHtml(seats[i].name)).join(' & ')} tie on ${g.scores[won[0]]}`;
    }
    const w = won[0];
    // The total on the table is the mode's, not always Classic's 91.
    const total = pointsOf(g.mode);
    if (w === selfSeat) return `You win with ${g.scores[w]} of ${total}`;
    return `${escapeHtml(seats[w].name)} wins with ${g.scores[w]} of ${total}`;
  };

  container.innerHTML = `
    <div class="results">
      <div class="res-head">
        <h2 class="res-title ${won.includes(selfSeat) ? 'is-win' : ''}">${headline()}</h2>
        ${
          cfg.series
            ? `<p class="res-series">${seats
                .map((s, i) => `<span style="--seat:${color(i)}"><b>${cfg.series![i] ?? 0}</b> ${escapeHtml(s.name)}</span>`)
                .join('<i>—</i>')}</p>`
            : ''
        }
      </div>

      <ol class="res-standings">
        ${rank
          .map(
            (s) => `<li style="--seat:${color(s.player)}" class="${s.player === selfSeat ? 'is-self' : ''}">
              <span class="rs-rank">${s.rank}</span>
              <span class="rs-dot" aria-hidden="true"></span>
              <span class="rs-name">${escapeHtml(seats[s.player].name)}${s.player === selfSeat ? ' (you)' : ''}</span>
              <span class="rs-score">${s.score}</span>
            </li>`,
          )
          .join('')}
      </ol>

      <div class="res-again" data-el="again"></div>

      <h3 class="res-sub">Every round</h3>
      <div class="res-scroll">
        <table class="res-table">
          <thead>
            <tr>
              <th scope="col">Pot</th>
              ${seats.map((s, i) => `<th scope="col" style="--seat:${color(i)}">${escapeHtml(s.name)}</th>`).join('')}
            </tr>
          </thead>
          <tbody>
            ${g.history
              .map((t, r) => {
                const tie = t.winner === null;
                return `<tr class="${tie ? 'is-tie' : ''}">
                  <th scope="row">
                    <span class="rt-prize">${cardFace(t.prize)}</span>
                    ${t.pot !== t.prize ? `<span class="rt-pot">pot ${t.pot}</span>` : ''}
                  </th>
                  ${seats
                    .map((_, i) => {
                      const winner = t.winner === i;
                      const note = reps[i].notes[r];
                      const title = winner
                        ? note.overspend > 0
                          ? `Won it, but ${cardFace(note.cheapest!)} would have done — ${note.overspend} wasted`
                          : 'Won it at the cheapest price'
                        : note.missed > 0
                          ? `${cardFace(note.cheapest!)} would have taken this — ${note.missed} missed`
                          : 'Nothing in hand could win this';
                      return `<td class="${winner ? 'is-win' : ''} ${note.missed > 0 ? 'is-missed' : ''}"
                                  style="--seat:${color(i)}" title="${escapeHtml(title)}">
                        <span class="rt-bid">${cardFace(t.bids[i])}</span>
                        ${winner && note.overspend > 0 ? `<span class="rt-flag">-${note.overspend}</span>` : ''}
                      </td>`;
                    })
                    .join('')}
                </tr>`;
              })
              .join('')}
          </tbody>
        </table>
      </div>
      <p class="res-legend">
        <span class="lg-win">Bold</span> took the pot · <span class="lg-missed">underlined</span> could
        have won it with a card still in hand · <span class="lg-flag">-n</span> pips spent beyond what was needed.
      </p>

      <h3 class="res-sub">What it cost</h3>
      <ul class="res-cards">
        ${reps
          .map(
            (rep) => `<li style="--seat:${color(rep.player)}" class="${rep.player === selfSeat ? 'is-self' : ''}">
            <p class="rc-name"><span class="rc-dot" aria-hidden="true"></span>${escapeHtml(seats[rep.player].name)}</p>
            <dl class="rc-stats">
              <div><dt>Score</dt><dd>${rep.score}</dd></div>
              <div><dt>Pots taken</dt><dd>${rep.taken}</dd></div>
              <div><dt>Pips wasted</dt><dd>${rep.wasted}</dd></div>
              <div><dt>Points missed</dt><dd>${rep.missed}</dd></div>
            </dl>
            <p class="rc-note">${verdict(rep.wasted, rep.missed)}</p>
          </li>`,
          )
          .join('')}
      </ul>

      <div class="res-actions">
        <button class="btn ghost" type="button" data-act="share">Share this deal</button>
        ${cfg.multiplayer ? '<button class="btn ghost" type="button" data-act="lobby">Back to lobby</button>' : ''}
        <button class="btn ghost" type="button" data-act="menu">Menu</button>
      </div>
    </div>`;

  container.querySelector('[data-act="share"]')?.addEventListener('click', () => cfg.onShare());
  container.querySelector('[data-act="lobby"]')?.addEventListener('click', () => cfg.onLobby());
  container.querySelector('[data-act="menu"]')?.addEventListener('click', () => cfg.onMenu());

  const againEl = container.querySelector<HTMLElement>('[data-el="again"]')!;
  let painted = '';

  function paintAgain(again: AgainState | null): void {
    const key = JSON.stringify(again);
    if (key === painted) return;
    painted = key;

    if (!again) {
      againEl.innerHTML = '<button class="btn primary big" type="button" data-act="again">Play again</button>';
    } else {
      const secs = again.startsInMs !== null ? Math.ceil(again.startsInMs / 1000) : null;
      againEl.innerHTML = `
        <button class="btn primary big" type="button" data-act="again">
          ${again.voted ? 'Ready — waiting for the table' : 'Play again'}
        </button>
        <p class="again-status">
          ${
            secs !== null
              ? // A silent wait is indistinguishable from a hang. Always say what
                // is being waited on, and when it stops.
                `<span class="spinner sm" aria-hidden="true"></span> ${again.votes} of ${again.present} ready — dealing in ${secs}s`
              : again.voted
                ? `<span class="spinner sm" aria-hidden="true"></span> ${again.votes} of ${again.present} ready — waiting for the others`
                : `${again.votes} of ${again.present} ready`
          }
        </p>
        ${
          again.isHost && again.canStart
            ? '<button class="btn" type="button" data-act="force">Deal now</button>'
            : ''
        }`;
    }
    againEl.querySelector('[data-act="again"]')?.addEventListener('click', () => cfg.onAgain());
    againEl.querySelector('[data-act="force"]')?.addEventListener('click', () => cfg.onForceStart());
  }

  return {
    update: paintAgain,
    destroy() {
      /* the container is replaced wholesale by the next screen */
    },
  };
}

/** A plain-English read on a player's line, rather than four numbers alone. */
function verdict(wasted: number, missed: number): string {
  if (wasted === 0 && missed === 0) return 'Perfect. Every card exactly where it had to be.';
  if (missed === 0) return `Won everything winnable, ${wasted} pips too generously.`;
  if (wasted === 0) return `Never overpaid — but left ${missed} points in hand.`;
  if (missed > wasted * 3) return `Hoarded. ${missed} points went past a hand that could have taken them.`;
  if (wasted > missed * 3) return `Overpaid for what you won — ${wasted} pips of margin you never needed.`;
  return `${wasted} pips overspent, ${missed} points let by.`;
}
