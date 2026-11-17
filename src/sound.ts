/**
 * In-app notification sounds, synthesized with Web Audio (no sound files to download).
 * Browsers only allow audio after the user has tapped the page once, so the audio engine is
 * "unlocked" on the first tap.
 */

export type Chime = 'cashin' | 'receipt' | 'done';

const KEY = 'sound-enabled';
let ctx: AudioContext | null = null;

export function soundEnabled() {
  try {
    return localStorage.getItem(KEY) !== '0';
  } catch {
    return true;
  }
}

export function setSoundEnabled(on: boolean) {
  try {
    localStorage.setItem(KEY, on ? '1' : '0');
  } catch {
    // ignore
  }
}

function audio() {
  if (!ctx) {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  return ctx;
}

/** Call once at startup: the first tap anywhere unlocks audio for the rest of the session. */
export function unlockAudioOnFirstTap() {
  const unlock = () => {
    const a = audio();
    a?.resume().catch(() => undefined);
    // A silent blip makes iOS treat audio as unlocked.
    if (a) {
      const o = a.createOscillator();
      const g = a.createGain();
      g.gain.value = 0;
      o.connect(g).connect(a.destination);
      o.start();
      o.stop(a.currentTime + 0.01);
    }
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown', unlock);
  };
  window.addEventListener('pointerdown', unlock, { once: false });
  window.addEventListener('keydown', unlock, { once: false });
}

/** One bell-like note: a sine with a quick attack and a soft decay, plus a quieter octave for shimmer. */
function note(a: AudioContext, freq: number, start: number, length: number, volume: number) {
  for (const [mult, vol] of [
    [1, volume],
    [2, volume * 0.25],
  ] as const) {
    const o = a.createOscillator();
    const g = a.createGain();
    o.type = 'sine';
    o.frequency.value = freq * mult;
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(vol, start + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, start + length);
    o.connect(g).connect(a.destination);
    o.start(start);
    o.stop(start + length + 0.05);
  }
}

const PATTERNS: Record<Chime, { notes: [number, number][]; length: number; volume: number; vibrate: number[] }> = {
  // Cash-in request: bright rising three-note "ding-ding-ding" — needs action, so the most noticeable.
  cashin: { notes: [[784, 0], [988, 0.13], [1319, 0.26]], length: 0.55, volume: 0.32, vibrate: [180, 80, 180, 80, 180] },
  // New receipt: two-note "ding-dong".
  receipt: { notes: [[1047, 0], [784, 0.16]], length: 0.5, volume: 0.25, vibrate: [150, 80, 150] },
  // Your cash-in was sent: soft single confirmation tone.
  done: { notes: [[880, 0], [1175, 0.09]], length: 0.45, volume: 0.22, vibrate: [120] },
};

/** Plays a chime (and vibrates on phones that support it) if sounds are on. */
export function playChime(kind: Chime, force = false) {
  if (!force && !soundEnabled()) return;
  const p = PATTERNS[kind];
  try {
    navigator.vibrate?.(p.vibrate);
  } catch {
    // ignore
  }
  const a = audio();
  if (!a) return;
  const start = () => {
    const t = a.currentTime + 0.02;
    for (const [freq, offset] of p.notes) note(a, freq, t + offset, p.length, p.volume);
  };
  if (a.state === 'suspended') a.resume().then(start, () => undefined);
  else start();
}

let lastLocalAction = 0;
/** Mark that this user just did something themselves, so their own action doesn't chime at them. */
export function markLocalAction() {
  lastLocalAction = Date.now();
}
export function recentLocalAction(ms = 8000) {
  return Date.now() - lastLocalAction < ms;
}

/* ------------------------------------------------------------------ */
/* Voice: "Cash in po!" / "Pa-cash out po!"                            */
/* ------------------------------------------------------------------ */

function pickVoice(): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis?.getVoices() ?? [];
  return (
    voices.find((v) => /^(fil|tl)([-_]|$)/i.test(v.lang)) ?? // Filipino / Tagalog voice if the phone has one
    voices.find((v) => /^en[-_]PH/i.test(v.lang)) ??
    voices.find((v) => /^en/i.test(v.lang) && v.localService) ??
    voices.find((v) => /^en/i.test(v.lang)) ??
    null
  );
}
// Voices load asynchronously on some browsers; touching getVoices() early starts that.
if (typeof window !== 'undefined') window.speechSynthesis?.getVoices();

/** Speaks a short phrase with the phone's text-to-speech (if sounds are on). */
export function say(text: string, force = false) {
  if ((!force && !soundEnabled()) || !('speechSynthesis' in window)) return;
  try {
    const u = new SpeechSynthesisUtterance(text);
    const v = pickVoice();
    if (v) {
      u.voice = v;
      u.lang = v.lang;
    } else {
      u.lang = 'fil-PH';
    }
    u.rate = 0.95;
    u.volume = 1;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  } catch {
    // ignore
  }
}

/** New request alert for the owner: chime, then "Cash in po!" or "Pa-cash out po!". */
export function announceRequest(kind: 'cashin' | 'cashout', force = false) {
  if (!force && !soundEnabled()) return;
  playChime('cashin', force);
  setTimeout(() => say(kind === 'cashout' ? 'Pa cash out po!' : 'Cash in po!', force), 650);
}
