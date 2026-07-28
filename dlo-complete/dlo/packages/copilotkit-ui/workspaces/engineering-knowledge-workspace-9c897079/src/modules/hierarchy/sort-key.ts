// src/modules/hierarchy/sort-key.ts — pure fractional-index allocator over the concepts.sort_key
// column (Database.md "concepts": `sort_key text COLLATE "C" NOT NULL CHECK (sort_key ~
// '^[0-9A-Za-z]{1,64}$')`; Implementation.md m10). `keyBetween(a, b)` returns a key that sorts
// strictly between `a` and `b` under plain byte comparison — exactly what `COLLATE "C"` gives
// Postgres, so no numeric decoding ever happens at read time. The alphabet "0-9A-Za-z" is listed
// in ASCII order on purpose: '0'(0x30) < '9'(0x39) < 'A'(0x41) < 'Z'(0x5A) < 'a'(0x61) < 'z'(0x7A),
// so alphabet-index order and byte order coincide and every comparison below can reason purely in
// terms of alphabet indices.
//
// Four shapes, three strategies:
//  - append (`b === null`, no upper bound — "add to the end"): bump the key's last character
//    toward 'z', leaving headroom for the *next* append, and only grow the string by one
//    character once the last position is already 'z'. This keeps N sequential appends at
//    roughly O(log N) characters instead of O(N) — see `bumpLast`/`appendKey`.
//  - prepend (`a === null`, `b` non-null — "add to the front"): the mirror of append, but NOT a
//    mirror-image implementation of `bumpLast`, because byte-ordered strings are asymmetric.
//    Extending a string by appending a character always sorts it *later* (a proper prefix is
//    always less than any extension of itself) — that asymmetry is exactly what lets `bumpLast`
//    grow forever by appending once it hits 'z'. Going the other direction, appending can never
//    produce something *earlier*, so shrinking the key's leading character until it hits '0' the
//    way `bumpLast` shrinks toward 'z' would hit the alphabet floor after only ~6 halvings
//    (`log2(62)`) and `rawBetween` would report `sortKeySpaceExhausted` far too soon for a
//    realistic "drag to the very top of the list, repeatedly" workload. `bumpFirst`/`prependKey`
//    solve this the way real fractional-indexing schemes do: once the leading character can no
//    longer be lowered in place, the leading `'0'` is echoed unchanged (an unmodified prefix
//    never changes what a comparison decides) and the same bump is retried one position deeper —
//    the same "grow precision instead of colliding" idea `rawBetween`'s own loop uses when two
//    bounds tie. That keeps N sequential prepends at roughly O(log N) characters too, matching
//    append's own long-run behaviour.
//  - first key / insert-between (`a` and `b` both non-null, or both `null`): `rawBetween` — a
//    missing lower bound reduces to `""` and a missing upper bound to the single-character MID
//    key (any key at all is a valid answer when nothing bounds either side).
//
// The one case no key can satisfy: nothing sorts strictly below the alphabet's own minimum
// character ('0'), so a request for a key between `a` and a `b` that — after stripping redundant
// trailing minimum characters — equals or precedes `a` is genuinely unsatisfiable (and, for
// `bumpFirst`, a key that is *already* every '0' character has nowhere left to recurse into).
// Both throw `ValidationError('hierarchy.sortKeySpaceExhausted')` rather than colliding or
// silently returning an out-of-range key; see `rawBetween`'s own comment for why its stripping
// step is both necessary and safe.
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
 * Bumps `key`'s leading character roughly halfway toward the alphabet floor, so the next prepend
 * still has room before it needs to recurse deeper — the mirror of {@link bumpLast}. When `key`
 * has more than one character, the untouched remainder is kept as-is (it already provides some
 * headroom of its own); when `key` is a single character, {@link MID_CHAR} is appended as fresh
 * headroom for whichever position the *next* prepend needs to touch. When the leading character
 * is already `'0'` (no room to lower it in place), that `'0'` is echoed unchanged — a leading
 * character that does not change cannot change what a comparison decides — and the same bump is
 * retried against the rest of `key`; a single `'0'` with nothing left to recurse into is the
 * genuine floor and throws.
 */
function bumpFirst(key: string): string {
  const firstIndex = indexOf(key[0]!);
  if (firstIndex <= 0) {
    if (key.length <= 1) {
      throw new ValidationError("hierarchy.sortKeySpaceExhausted", { details: { key } });
    }
    return key[0] + bumpFirst(key.slice(1));
  }
  const step = Math.max(1, Math.ceil(firstIndex / 2));
  const bumped = Math.max(firstIndex - step, 0);
  const rest = key.length > 1 ? key.slice(1) : MID_CHAR;
  return SORT_KEY_ALPHABET[bumped] + rest;
}

function prependKey(upper: string): string {
  const bumped = bumpFirst(upper);
  if (bumped.length > MAX_SORT_KEY_LENGTH) {
    throw new ValidationError("hierarchy.sortKeySpaceExhausted", { details: { upper } });
  }
  return bumped;
}

/**
 * Core midpoint routine for "insert between" (both bounds non-null). Walks `a` and `b` position
 * by position, carrying forward whichever side is still real (tied) at each position, until a
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
  if (a === null) {
    return prependKey(b);
  }
  return rawBetween(a, b);
}
