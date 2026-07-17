/**
 * layout.test.ts — the rules that stop the hand eating the game.
 *
 * A real player hit this on a phone: by round 13 the last card in hand was ~355px
 * wide and ~500px tall. It swallowed the felt, hid the prize being bid on, and
 * pushed the Bid button off the bottom of the screen.
 *
 * The cause is a three-ingredient trap, and every ingredient is still there
 * because each is individually correct:
 *   - `.card { flex: 1 1 0 }`  — share the row between the cards
 *   - `.card { aspect-ratio }` — keep cards card-shaped
 *   - `.hand-zone { flex-shrink: 0 }` — never squash the hand
 * Together they mean "fewer cards ⇒ wider cards ⇒ taller cards ⇒ less felt", with
 * nothing to stop it. `max-width` is the brake, and it is the kind of one-line
 * rule that gets tidied away by someone who cannot see what it was holding back.
 *
 * jsdom does not do layout, so this cannot measure pixels — the browser pass does
 * that. What it CAN do is refuse to let the brake be removed, which is exactly
 * the regression that would ship silently.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync('src/styles/main.css', 'utf8');

/** Pull one rule's declaration block out of the stylesheet. */
function rule(selector: string): string {
  const at = css.indexOf(`\n${selector} {`);
  expect(at, `${selector} is gone from main.css`).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf('}', at));
}

describe('the hand cannot grow into the felt', () => {
  it('caps how wide a card may get', () => {
    // Without this, the last card of the match is as wide as the screen.
    expect(rule('.card')).toMatch(/max-width:\s*\d+px/);
  });

  it('caps it well below a phone, so 2 cards look like cards and not billboards', () => {
    const max = Number(/max-width:\s*(\d+)px/.exec(rule('.card'))![1]);
    expect(max).toBeLessThanOrEqual(96); // a 375px phone must never be dominated
    expect(max).toBeGreaterThanOrEqual(44); // …but still a comfortable tap target
  });

  it('keeps the aspect-ratio + flex-grow pair the cap exists to restrain', () => {
    // If either of these ever goes away the cap is harmless, but if BOTH are here
    // and the cap is not, the bug is back. Asserting them together documents why
    // the max-width is not redundant.
    const card = rule('.card');
    expect(card).toMatch(/aspect-ratio/);
    expect(card).toMatch(/flex:\s*1 1 0/);
  });

  it('does not let a bigger desktop cap sneak past the phone budget', () => {
    const wide = /@media \(min-width: 640px\)[\s\S]*?\.card \{([\s\S]*?)\}/.exec(css);
    if (!wide) return; // no desktop override is fine
    const max = Number(/max-width:\s*(\d+)px/.exec(wide[1])![1]);
    expect(max).toBeLessThanOrEqual(96);
  });
});

describe('a full hand stays reachable', () => {
  it('centres the hand with `safe`, so an overflowing row is not clipped', () => {
    // Plain `center` centres the overflow too, stranding the low cards outside
    // the scrollable origin where they can never be tapped. `safe` degrades to
    // flex-start exactly when the row is too wide.
    expect(rule('.hand')).toMatch(/justify-content:\s*safe center/);
  });

  it('keeps the hand scrollable', () => {
    expect(rule('.hand')).toMatch(/overflow-x:\s*auto/);
  });
});
