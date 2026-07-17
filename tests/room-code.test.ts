/**
 * room-code.test.ts — a hand-typed code must reach the same room as the link.
 *
 * People paste codes into chat, read them aloud, and type them on a different
 * device. If "k7qp" and "K7QP" resolve to different Trystero rooms, both players
 * sit in what they believe is the same room, alone, forever — and the UI has
 * nothing to show them that is wrong.
 */

import { describe, expect, it } from 'vitest';
import { mintCode, normalizeRoomCode } from '../src/engine/lobby';

describe('normalizeRoomCode', () => {
  it('canonicalises what a human actually types', () => {
    // Every one of these is a real thing someone does with a code read off
    // another screen. They must all land in the same room.
    for (const typed of ['k7qp', 'K7QP', ' k7qp ', 'k7-qp', 'K7 QP', 'k7qp.']) {
      expect(normalizeRoomCode(typed)).toBe('K7QP');
    }
  });

  it('is idempotent, so a normalised code survives a second pass', () => {
    const code = normalizeRoomCode('k7-qp');
    expect(normalizeRoomCode(code)).toBe(code);
  });

  it('agrees with the code the invite link carries', () => {
    for (let i = 0; i < 200; i++) {
      const minted = mintCode();
      expect(normalizeRoomCode(minted)).toBe(minted);
      // The typed path lower-cases through an autocapitalize field and back.
      expect(normalizeRoomCode(minted.toLowerCase())).toBe(minted);
    }
  });

  it('caps length so a pasted URL cannot become a room id', () => {
    expect(normalizeRoomCode('https://bidstorm.benrichardson.dev/?room=K7QP').length).toBe(8);
  });

  it('gives back an empty string for nothing usable', () => {
    expect(normalizeRoomCode('')).toBe('');
    expect(normalizeRoomCode('---')).toBe('');
  });
});

describe('mintCode', () => {
  it('makes a 4-character code from an unambiguous alphabet', () => {
    for (let i = 0; i < 500; i++) {
      const c = mintCode();
      expect(c).toHaveLength(4);
      // No I/O/0/1/L: the characters people mishear and mistype are simply not
      // in the alphabet, so a misread code fails fast rather than joining an
      // empty room that looks like a broken connection.
      expect(c).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/);
    }
  });

  it('does not keep handing out the same code', () => {
    const seen = new Set(Array.from({ length: 200 }, () => mintCode()));
    expect(seen.size).toBeGreaterThan(150);
  });
});
