/**
 * Session codes and presenter tokens.
 *
 * Join codes are typed by humans off a projector, so the alphabet excludes
 * every character pair people misread: 0/O, 1/I/L, 5/S, 8/B, 2/Z. What's left
 * is 26 unambiguous characters. At 6 characters that's 26^6 ≈ 309 million
 * combinations — collisions are vanishingly unlikely, and we use a conditional
 * write anyway so a collision is impossible rather than merely improbable.
 */

/** Unambiguous alphabet — no O/0, I/1/L, S/5, B/8, Z/2. */
export const CODE_ALPHABET = "ACDEFGHJKMNPQRTUVWXY34679";

export const CODE_LENGTH = 6;

/** Session lifecycle. Phase 2 enforces the full state machine. */
export type SessionState = "lobby" | "active" | "closed";

/** Who a connection belongs to. */
export type Role = "audience" | "presenter";

/**
 * Generate a join code.
 *
 * `randomBytes` is injected so tests are deterministic and this module stays
 * free of any Node-specific import (it also runs in a browser bundle).
 */
export function generateSessionCode(
  randomBytes: (n: number) => Uint8Array,
  length: number = CODE_LENGTH
): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return out;
}

/**
 * Generate a presenter token — the bearer secret that authorizes control of a
 * session until real auth lands in Phase 4. 32 bytes of hex is 256 bits of
 * entropy, which is not guessable.
 */
export function generatePresenterToken(
  randomBytes: (n: number) => Uint8Array
): string {
  return Array.from(randomBytes(32))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Normalize user input: strip whitespace/hyphens, uppercase. */
export function normalizeSessionCode(input: string): string {
  return input.replace(/[\s-]/g, "").toUpperCase();
}

/** Does this look like a well-formed code? Cheap check before hitting the DB. */
export function isValidSessionCode(code: string): boolean {
  if (code.length !== CODE_LENGTH) return false;
  for (const ch of code) {
    if (!CODE_ALPHABET.includes(ch)) return false;
  }
  return true;
}

/**
 * Constant-time string comparison for the presenter token.
 *
 * A plain `===` short-circuits on the first differing character, which leaks
 * how much of a guess was correct. Irrelevant at our scale, but it costs
 * nothing to do right and this is the pattern to keep once auth matters.
 */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
