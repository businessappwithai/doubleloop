// tests/hierarchy-sort-key.test.ts — module m10 (hierarchy module). Exercises the pure
// fractional-index allocator in `src/modules/hierarchy/sort-key.ts`: first key, append, prepend,
// insert-between, repeated subdivision, the strict byte-ordering invariant over 100 sequential
// insertions (Implementation.md m10 acceptance), invalid key order, invalid characters, and both
// shapes of space exhaustion.
import { describe, test, expect } from "vitest";
import { ValidationError } from "../src/core/errors";
import { keyBetween, MAX_SORT_KEY_LENGTH, SORT_KEY_ALPHABET } from "../src/modules/hierarchy/sort-key";

describe("keyBetween — first key", () => {
  test("returns the alphabet midpoint when both bounds are null", () => {
    const key = keyBetween(null, null);
    expect(key).toBe("V");
    expect(key.length).toBe(1);
  });
});

describe("keyBetween — append (b === null)", () => {
  test("appends past a single-character key", () => {
    const first = keyBetween(null, null);
    const second = keyBetween(first, null);
    expect(second > first).toBe(true);
  });

  test("100 sequential appends stay strictly increasing in byte order", () => {
    let previous = keyBetween(null, null);
    const keys = [previous];
    for (let i = 0; i < 100; i += 1) {
      const next = keyBetween(previous, null);
      expect(next > previous).toBe(true);
      keys.push(next);
      previous = next;
    }
    const sorted = [...keys].sort();
    expect(keys).toEqual(sorted);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("extends the key by one character once the last position is already 'z'", () => {
    const lastChar = SORT_KEY_ALPHABET[SORT_KEY_ALPHABET.length - 1]!;
    const nearMax = `abc${lastChar}`;
    const appended = keyBetween(nearMax, null);
    expect(appended.length).toBe(nearMax.length + 1);
    expect(appended.startsWith(nearMax)).toBe(true);
    expect(appended > nearMax).toBe(true);
  });

  test("throws ValidationError('hierarchy.sortKeySpaceExhausted') when appending would exceed the max length", () => {
    const lastChar = SORT_KEY_ALPHABET[SORT_KEY_ALPHABET.length - 1]!;
    const maxed = lastChar.repeat(MAX_SORT_KEY_LENGTH);
    try {
      keyBetween(maxed, null);
      throw new Error("expected keyBetween to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).message).toBe("hierarchy.sortKeySpaceExhausted");
    }
  });
});

describe("keyBetween — prepend (a === null)", () => {
  test("prepends before a single-character key", () => {
    const existing = keyBetween(null, null);
    const before = keyBetween(null, existing);
    expect(before < existing).toBe(true);
  });

  test("100 sequential prepends stay strictly decreasing in byte order", () => {
    let upper = keyBetween(null, null);
    const keys = [upper];
    for (let i = 0; i < 100; i += 1) {
      const next = keyBetween(null, upper);
      expect(next < upper).toBe(true);
      keys.push(next);
      upper = next;
    }
    const sorted = [...keys].sort();
    expect([...keys].reverse()).toEqual(sorted);
  });
});

describe("keyBetween — insert between adjacent keys and repeated subdivision", () => {
  test("returns a key strictly between two adjacent single-character keys", () => {
    const a = "A";
    const b = "B";
    const mid = keyBetween(a, b);
    expect(mid > a).toBe(true);
    expect(mid < b).toBe(true);
  });

  test("repeated subdivision between the same two bounds keeps producing valid strictly-ordered keys", () => {
    let lower = "A";
    const upper = "B";
    const produced: string[] = [];
    for (let i = 0; i < 40; i += 1) {
      const mid = keyBetween(lower, upper);
      expect(mid > lower).toBe(true);
      expect(mid < upper).toBe(true);
      produced.push(mid);
      lower = mid;
    }
    const sorted = [...produced].sort();
    expect(produced).toEqual(sorted);
    expect(new Set(produced).size).toBe(produced.length);
  });

  test("subdividing between two keys that share a prefix extends the returned key", () => {
    const a = "M0";
    const b = "M1";
    const mid = keyBetween(a, b);
    expect(mid > a).toBe(true);
    expect(mid < b).toBe(true);
  });

  test("strips redundant trailing minimum-alphabet characters from the upper bound", () => {
    const a = "A";
    const b = "B0000";
    const mid = keyBetween(a, b);
    expect(mid > a).toBe(true);
    expect(mid < b).toBe(true);
  });
});

describe("keyBetween — validation failures", () => {
  test("throws ValidationError('hierarchy.invalidKeyOrder') when a >= b", () => {
    try {
      keyBetween("B", "A");
      throw new Error("expected keyBetween to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).message).toBe("hierarchy.invalidKeyOrder");
      expect((err as ValidationError).details).toEqual({ a: "B", b: "A" });
    }
  });

  test("throws ValidationError('hierarchy.invalidKeyOrder') when a === b", () => {
    expect(() => keyBetween("M", "M")).toThrow(ValidationError);
  });

  test("throws ValidationError('hierarchy.invalidSortKey') for an empty string bound", () => {
    expect(() => keyBetween("", null)).toThrow(ValidationError);
  });

  test("throws ValidationError('hierarchy.invalidSortKey') for a bound containing an invalid character", () => {
    try {
      keyBetween("A!", null);
      throw new Error("expected keyBetween to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).message).toBe("hierarchy.invalidSortKey");
    }
  });

  test("throws ValidationError('hierarchy.invalidSortKey') for a bound over the max length", () => {
    expect(() => keyBetween("A".repeat(MAX_SORT_KEY_LENGTH + 1), null)).toThrow(ValidationError);
  });

  test("throws ValidationError('hierarchy.sortKeySpaceExhausted') when nothing sorts between two adjacent keys at the alphabet minimum", () => {
    const zero = SORT_KEY_ALPHABET[0]!;
    const a = zero;
    const b = zero + zero;
    try {
      keyBetween(a, b);
      throw new Error("expected keyBetween to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).message).toBe("hierarchy.sortKeySpaceExhausted");
    }
  });
});

describe("SORT_KEY_ALPHABET", () => {
  test("is 62 characters, ASCII-ordered '0-9A-Za-z'", () => {
    expect(SORT_KEY_ALPHABET).toBe("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz");
    expect(SORT_KEY_ALPHABET.length).toBe(62);
    const sorted = [...SORT_KEY_ALPHABET].sort().join("");
    expect(SORT_KEY_ALPHABET).toBe(sorted);
  });
});
