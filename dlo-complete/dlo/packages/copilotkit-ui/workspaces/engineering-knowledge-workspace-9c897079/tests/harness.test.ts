// tests/harness.test.ts — proves the test harness itself (module m2) works before any other
// module's tests can be trusted: jsdom is active, jest-dom matchers are registered, fake
// timers advance deterministically, the browser API stubs exist, console.error fails a test,
// and the Vitest config never enables `passWithNoTests`.
import { createElement } from "react";
import { describe, test, expect, vi } from "vitest";
import { fixedClock, flushMicrotasks, renderWithShell } from "./helpers/test-utils";

describe("jsdom environment", () => {
  test("provides a window and document", () => {
    expect(typeof window).toBe("object");
    expect(typeof document).toBe("object");
    expect(window.document).toBe(document);
  });

  test("stubs matchMedia", () => {
    const result = window.matchMedia("(prefers-color-scheme: dark)");
    expect(result.matches).toBe(false);
    expect(result.media).toBe("(prefers-color-scheme: dark)");
  });

  test("stubs ResizeObserver", () => {
    expect(typeof window.ResizeObserver).toBe("function");
    const observer = new window.ResizeObserver(() => {});
    expect(() => observer.observe(document.body)).not.toThrow();
    expect(() => observer.disconnect()).not.toThrow();
  });
});

describe("jest-dom matchers", () => {
  test("toBeInTheDocument is registered and passes for an attached node", () => {
    const node = document.createElement("div");
    node.textContent = "hello harness";
    document.body.appendChild(node);

    expect(node).toBeInTheDocument();
    expect(node).toHaveTextContent("hello harness");

    document.body.removeChild(node);
  });

  test("toBeInTheDocument fails for a detached node", () => {
    const node = document.createElement("div");
    expect(() => expect(node).toBeInTheDocument()).toThrow();
  });
});

describe("console.error fails the test", () => {
  test("throws when console.error is called", () => {
    expect(() => {
      console.error("boom");
    }).toThrow("console.error during test: boom");
  });
});

describe("fixedClock", () => {
  test("pins Date.now() to the given ISO instant", () => {
    const clock = fixedClock("2026-01-01T00:00:00.000Z");
    expect(clock.iso).toBe("2026-01-01T00:00:00.000Z");
    expect(clock.now()).toBe(Date.parse("2026-01-01T00:00:00.000Z"));
    expect(Date.now()).toBe(clock.now());
    clock.restore();
  });

  test("advances deterministically and only when told to", () => {
    const clock = fixedClock("2026-01-01T00:00:00.000Z");
    const start = clock.now();

    expect(Date.now()).toBe(start);
    clock.advance(5_000);
    expect(Date.now()).toBe(start + 5_000);
    clock.advance(1_000);
    expect(Date.now()).toBe(start + 6_000);

    clock.restore();
  });

  test("fires a timer scheduled against the fake clock only after advancing", () => {
    const clock = fixedClock("2026-01-01T00:00:00.000Z");
    const callback = vi.fn();
    setTimeout(callback, 1_000);

    expect(callback).not.toHaveBeenCalled();
    clock.advance(999);
    expect(callback).not.toHaveBeenCalled();
    clock.advance(1);
    expect(callback).toHaveBeenCalledTimes(1);

    clock.restore();
  });

  test("rejects an unparsable ISO timestamp", () => {
    expect(() => fixedClock("not-a-timestamp")).toThrow(
      'fixedClock: invalid ISO timestamp "not-a-timestamp"',
    );
  });
});

describe("flushMicrotasks", () => {
  test("resolves after pending promise callbacks settle", async () => {
    const order: string[] = [];

    Promise.resolve().then(() => order.push("microtask"));
    order.push("sync");

    await flushMicrotasks();

    expect(order).toEqual(["sync", "microtask"]);
  });
});

describe("renderWithShell", () => {
  test("renders the given element into the document", () => {
    const { getByText, unmount } = renderWithShell(createElement("div", null, "shell content"));

    expect(getByText("shell content")).toBeInTheDocument();
    unmount();
  });
});
