# Bidstorm — Card drag review

This file exists only to create a reviewable PR. All code is already deployed on
`main` (GitHub Pages).

**Merge to acknowledge the update.** Closing without merging is also fine.

## What changed

- **Grab and play a card with a gesture.** Lift a card up toward the felt and
  let go — or flick it up — to bid it outright, instead of tap-to-arm then Bid.
  Tap-to-arm still works, so nothing you knew is gone. Built on the shared
  `patterns/drag.ts` pointer gesture classifier (tap vs drag vs swipe), covered
  by `tests/drag.test.ts`. Horizontal scrolling of a long hand is untouched
  (`touch-action: pan-x`).

## Verify

- **Play:** https://bidstorm.benrichardson.dev
- On a phone, drag a card up into the play area to bid it; tap still arms it.

---
🤖 Built autonomously by gh-game-factory
