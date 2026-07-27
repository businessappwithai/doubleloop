// src/modules/hierarchy/sort-key.ts — pure fractional-index allocator over the concepts.sort_key
// column (Database.md "concepts": `sort_key text COLLATE "C" NOT NULL CHECK (sort_key ~
// '^[0-9A-Za-z]{1,64}$')`; Implementation.md m10). `keyBetween(a, b)` returns a key that sorts
// strictly between `a` and `b` under plain byte comparison — exactly what `COLLATE "C"` gives
// Postgres, so no numeric decoding ever happens at read time. The alphabet "0-9A-Za-z" is listed
// in ASCII order on purpose: '0'(0x30) < '9'(0x39) < 'A'(0x41) < 'Z'(0x5A) < 'a'(0x61) < 'z'(0x7A),
// so alphabet-index order and byte order coincide and every comparison below can reason purely in
// terms of alphabet indices.
//
// Three shapes, two strategies:
//  - append (`b === null`, no upper bound — "add to the end"): bump the key's last character
//    toward 'z', leaving headroom for the *next* append, and only grow the string by one
//    character once the last position is already 'z'. This keeps N sequential appends at
//    roughly O(log N) characters instead of O(N) — see `bumpLast`.
//  - first key / prepend / insert-between (`a`, `b`, or both `null`): all three reduce to one
//    routine, `rawBetween`, by treating a missing lower bound as `""` (the empty string is
//    always "exhausted" from position 0, which is exactly what "no lower bound" means under
//    lexicographic comparison) and a missing upper bound as the single-character MID key (any
//    key at all is a valid answer when nothing bounds either side).
//
// The one case no key can satisfy: nothing sorts strictly below the alphabet's own minimum
// character ('0'), so a request for a key between `a` and a `b` that — after stripping redundant
// trailing minimum characters — equals or precedes `a` is genuinely unsatisfiable. `rawBetween`
// throws `ValidationError('hierarchy.sortKeySpaceExhausted')` rather than colliding or silently
// returning an out-of-range key; see its own comment for why the stripping step is both necessary
// and safe.
import { ValidationError } from "../../core/errors";

export const SORT_KEY_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ALPHABET_LAST_INDEX = SORT_KEY_ALPHABET.length - 1; // 61, the index of 'z'
const MID_CHAR = SORT_KEY_ALPHABET[Math.floor(SORT_KEY_ALPHABET.length / 2)]!; // 'V'
export const MAX_SORT_KEY_LENGTH = 64;
const VALID_KEY_PATTERN = /^[0-9A-Za-z]+$/;

function indexOf(char: string): number {
  const index = SORT_KEY_ALPHABET.indexOf(char);
  if (index === -1) {
    throw new ValidationError("hierarchy.invalidSortKeyChar", { details: { char } });
  }
  return index;
}

function assertValidKey(label: string, key: string): void {
  if (key.length < 1 || key.length > MAX_SORT_KEY_LENGTH || !VALID_KEY_PATTERN.test(key)) {
    throw new ValidationError("hierarchy.invalidSortKey", { details: { label, key } });
  }
}

/**
 * Bumps `key`'s last character roughly halfway toward the alphabet ceiling, so the next append
 * still has room before it needs to extend. Extends by one `MID_CHAR` character only once the
 * last character is already 'z' — the "exhaustion handled by lengthening" case for append.
 */
function bumpLast(key: string): string {
  const lastIndex = indexOf(key[key.length - 1]!);
  if (lastIndex >= ALPHABET_LAST_INDEX) {
    return key + MID_CHAR;
  }
  const step = Math.max(1, Math.ceil((ALPHABET_LAST_INDEX - lastIndex) / 2));
  const bumped = Math.min(lastIndex + step, ALPHABET_LAST_INDEX);
  return key.slice(0, -1) + SORT_KEY_ALPHABET[bumped]!;
}

function appendKey(lower: string): string {
  if (lower.length === 0) {
    return MID_CHAR;
  }
  const bumped = bumpLast(lower);
  if (bumped.length > MAX_SORT_KEY_LENGTH) {
    throw new ValidationError("hierarchy.sortKeySpaceExhausted", { details: { lower } });
  }
  return bumped;
}

/**
 * Core midpoint routine for "first key", "prepend" and "insert between" — all of which are
 * `rawBetween` with `a` defaulted to `""` (no lower bound). Walks `a` and `b` position by
 * position, carrying forward whichever side is still real (tied) at each position, until a
 * position has room for a strict midpoint character; that position's result is returned
 * immediately.
 *
 * `b`'s trailing minimum-alphabet characters are stripped first. They are redundant (a shorter
 * string is already less than a longer one sharing its prefix, so "X0" carries no information
 * "X" doesn't already) and, left in place, are exactly the case with no solution: if the walk
 * ever has to match `b` all the way to its own last character while still tied, there is no
 * legal next character (nothing sorts below '0'), even though a solution may exist against a
 * *shorter* — but equally valid — reading of the same upper bound. Stripping is always safe: the
 * stripped bound is `<=` the original, so anything found below it is still below the original.
 */
function rawBetween(a: string, b: string): string {
  const strippedB = b.replace(/0+$/, "");
  if (strippedB.length === 0 || strippedB <= a) {
    throw new ValidationError("hierarchy.sortKeySpaceExhausted", { details: { a, b } });
  }

  let prefix = "";
  let i = 0;
  for (;;) {
    const loIdx = i < a.length ? indexOf(a[i]!) : -1;
    const hiIdx = i < strippedB.length ? indexOf(strippedB[i]!) : SORT_KEY_ALPHABET.length;
    if (hiIdx - loIdx >= 2) {
      const mid = loIdx + Math.floor((hiIdx - loIdx) / 2);
      return prefix + SORT_KEY_ALPHABET[mid]!;
    }
    if (prefix.length + 1 > MAX_SORT_KEY_LENGTH) {
      throw new ValidationError("hierarchy.sortKeySpaceExhausted", { details: { a, b } });
    }
    prefix += SORT_KEY_ALPHABET[loIdx >= 0 ? loIdx : hiIdx]!;
    i += 1;
  }
}

/**
 * Returns a `sort_key` that sorts strictly between `a` and `b`. `null` means "no bound": both
 * `null` is the first key ever allocated in a sibling group; `b === null` appends past the last
 * sibling; `a === null` inserts before the first. Throws `ValidationError('hierarchy.invalidKeyOrder')`
 * if both are given and `a >= b`, and `ValidationError('hierarchy.sortKeySpaceExhausted')` in the
 * rare case no valid key exists between them (see {@link rawBetween}).
 */
export function keyBetween(a: string | null, b: string | null): string {
  if (a !== null) {
    assertValidKey("a", a);
  }
  if (b !== null) {
    assertValidKey("b", b);
  }
  if (a !== null && b !== null && a >= b) {
    throw new ValidationError("hierarchy.invalidKeyOrder", { details: { a, b } });
  }
  if (a === null && b === null) {
    return MID_CHAR;
  }
  if (b === null) {
    return appendKey(a!);
  }
  return rawBetween(a ?? "", b);
}
