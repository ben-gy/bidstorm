/**
 * sound.ts — procedural sound effects via the Web Audio API. Zero asset files.
 *
 * THE ONE FILE THAT STAYS GAME-SIDE. Everything else under src/engine/ moved to
 * @ben-gy/game-engine at v1.1.0; this did not, because its whole content is
 * Bidstorm-specific. SfxName is a closed union and the engine's is a platformer
 * vocabulary — coin, jump, explosion, powerup — with no hook for adding to it.
 * A card game needs deal, flip, commit, tie, tick and count instead, so
 * importing the engine's would mean calling sfx.play('coin') when a card lands.
 * The engine gains an extensible patch table one day; until then this is a fork
 * of a table, not a fork of any netcode, and it holds none of the v1.1.0 fixes.
 *
 * Call sfx.unlock() from the first user gesture — browsers block audio until then.
 */

export type SfxName =
  | 'blip'
  | 'select'
  | 'deal'
  | 'flip'
  | 'commit'
  | 'tie'
  | 'tick'
  | 'count'
  | 'lose'
  | 'win';

interface Patch {
  type: OscillatorType;
  /** [startFreq, endFreq] Hz — glides between them over `dur`. */
  freq: [number, number];
  dur: number;
  /** Peak gain 0..1. */
  gain?: number;
  /** Add a short noise burst (card snaps/whooshes). */
  noise?: boolean;
}

const PATCHES: Record<SfxName, Patch> = {
  blip: { type: 'square', freq: [440, 620], dur: 0.06, gain: 0.18 },
  // Arming a card: a small upward lift.
  select: { type: 'triangle', freq: [520, 880], dur: 0.09, gain: 0.2 },
  // The prize card slamming down onto the felt.
  deal: { type: 'sawtooth', freq: [260, 70], dur: 0.18, gain: 0.26, noise: true },
  // A card turning over — mostly the noise burst; the tone just gives it a body.
  flip: { type: 'triangle', freq: [700, 380], dur: 0.1, gain: 0.16, noise: true },
  // Your bid leaving your hand, face down.
  commit: { type: 'sine', freq: [300, 620], dur: 0.12, gain: 0.22 },
  // Nobody wins: a dissonant crack, and the pot rolls on.
  tie: { type: 'sawtooth', freq: [220, 180], dur: 0.4, gain: 0.28, noise: true },
  // Round clock, final seconds.
  tick: { type: 'square', freq: [900, 900], dur: 0.04, gain: 0.12 },
  // Each step of the pot counting up into a score.
  count: { type: 'square', freq: [1180, 1180], dur: 0.03, gain: 0.1 },
  lose: { type: 'sawtooth', freq: [400, 100], dur: 0.7, gain: 0.28 },
  win: { type: 'triangle', freq: [520, 1180], dur: 0.7, gain: 0.28 },
};

export interface Sfx {
  unlock(): void;
  play(name: SfxName): void;
  muted(): boolean;
  setMuted(m: boolean): void;
}

export function createSfx(initialMuted = false): Sfx {
  let ctx: AudioContext | null = null;
  let muted = initialMuted;

  const ensure = (): AudioContext | null => {
    try {
      if (!ctx) {
        const AC =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (!AC) return null;
        ctx = new AC();
      }
      if (ctx.state === 'suspended') void ctx.resume();
      return ctx;
    } catch {
      // Audio unavailable (blocked/unsupported) — the game stays fully playable.
      return null;
    }
  };

  const noiseBuffer = (ac: AudioContext, dur: number): AudioBuffer => {
    const len = Math.floor(ac.sampleRate * dur);
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  };

  return {
    unlock() {
      ensure();
    },
    play(name) {
      if (muted) return;
      const ac = ensure();
      if (!ac) return;
      try {
        const p = PATCHES[name];
        const t0 = ac.currentTime;
        const g = ac.createGain();
        g.gain.setValueAtTime(p.gain ?? 0.25, t0);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + p.dur);
        g.connect(ac.destination);

        const osc = ac.createOscillator();
        osc.type = p.type;
        osc.frequency.setValueAtTime(p.freq[0], t0);
        osc.frequency.exponentialRampToValueAtTime(Math.max(1, p.freq[1]), t0 + p.dur);
        osc.connect(g);
        osc.start(t0);
        osc.stop(t0 + p.dur);

        if (p.noise) {
          const n = ac.createBufferSource();
          n.buffer = noiseBuffer(ac, p.dur);
          const ng = ac.createGain();
          ng.gain.setValueAtTime((p.gain ?? 0.25) * 0.6, t0);
          ng.gain.exponentialRampToValueAtTime(0.0001, t0 + p.dur);
          n.connect(ng);
          ng.connect(ac.destination);
          n.start(t0);
          n.stop(t0 + p.dur);
        }
      } catch {
        /* a failed cue must never break the game */
      }
    },
    muted: () => muted,
    setMuted(m) {
      muted = m;
    },
  };
}
