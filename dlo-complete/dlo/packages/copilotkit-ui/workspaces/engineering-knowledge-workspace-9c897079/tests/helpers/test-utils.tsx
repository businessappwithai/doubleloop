// tests/helpers/test-utils.tsx — shared test utilities every later module's component and
// async tests build on (Architecture.md "Testing Strategy"). `renderWithShell` is the one
// place app-wide providers (theme, Relay environment, …) get wired into rendered components
// as later modules introduce them, so component tests never hand-roll their own provider tree.
// `fixedClock` and `flushMicrotasks` give async/time-dependent code (CRDT sync, debounced
// saves, optimistic Relay updates) a deterministic clock instead of real wall-clock time.
import type { ReactElement, ReactNode } from "react";
import { render, type RenderOptions, type RenderResult } from "@testing-library/react";
import { vi } from "vitest";

function Shell({ children }: { children: ReactNode }): ReactElement {
  return <>{children}</>;
}

/** Renders `ui` inside the app's shared provider shell, mirroring how components render in the app. */
export function renderWithShell(
  ui: ReactElement,
  options?: Omit<RenderOptions, "wrapper">,
): RenderResult {
  return render(ui, { wrapper: Shell, ...options });
}

export interface FixedClock {
  /** The ISO-8601 instant the clock was installed at. */
  readonly iso: string;
  /** Current fake-timer time in epoch milliseconds. */
  now(): number;
  /** Advances the fake timers (and any timers/promises they drive) by `ms` milliseconds. */
  advance(ms: number): void;
  /** Restores real timers. Safe to call more than once. */
  restore(): void;
}

/**
 * Installs Vitest fake timers pinned to `isoTimestamp`, so time-dependent code under test
 * advances only when the test tells it to. Throws on an unparsable timestamp rather than
 * silently installing a clock at the Unix epoch.
 */
export function fixedClock(isoTimestamp: string): FixedClock {
  const epochMs = Date.parse(isoTimestamp);
  if (Number.isNaN(epochMs)) {
    throw new Error(`fixedClock: invalid ISO timestamp "${isoTimestamp}"`);
  }

  vi.useFakeTimers();
  vi.setSystemTime(epochMs);

  return {
    iso: isoTimestamp,
    now: () => Date.now(),
    advance: (ms: number) => {
      vi.advanceTimersByTime(ms);
    },
    restore: () => {
      vi.useRealTimers();
    },
  };
}

/** Awaits one microtask-queue drain, so pending `Promise.then` callbacks settle before assertions. */
export async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => {
    queueMicrotask(resolve);
  });
}
