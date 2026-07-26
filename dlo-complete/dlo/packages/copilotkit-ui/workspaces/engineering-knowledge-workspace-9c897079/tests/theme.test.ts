// tests/theme.test.ts — module m16 (Astryx UI shell). Exhaustive coverage of resolveTheme and
// applyTheme (both preference/system combinations, and re-stamping), plus the ThemeProvider /
// useThemePreference React contract: default preference, preference changes, reacting to a
// simulated OS theme change while the preference is "system", and the outside-provider failure
// mode. matchMedia is faked per-test via vi.spyOn so "system" resolution is deterministic in
// both directions — the global stub in vitest.setup.ts always reports light.
import { createElement, type ReactElement, type ReactNode } from "react";
import { describe, test, expect, vi } from "vitest";
import { act, render, renderHook, screen } from "@testing-library/react";
import {
  applyTheme,
  resolveTheme,
  ThemeProvider,
  useThemePreference,
  type ResolvedTheme,
  type ThemePreference,
} from "../src/styles/theme";

describe("resolveTheme", () => {
  const CASES: ReadonlyArray<{
    preference: ThemePreference;
    systemPrefersDark: boolean;
    expected: ResolvedTheme;
  }> = [
    { preference: "light", systemPrefersDark: false, expected: "light" },
    { preference: "light", systemPrefersDark: true, expected: "light" },
    { preference: "dark", systemPrefersDark: false, expected: "dark" },
    { preference: "dark", systemPrefersDark: true, expected: "dark" },
    { preference: "system", systemPrefersDark: false, expected: "light" },
    { preference: "system", systemPrefersDark: true, expected: "dark" },
  ];

  test.each(CASES)(
    "resolves $preference with systemPrefersDark=$systemPrefersDark to $expected",
    ({ preference, systemPrefersDark, expected }) => {
      expect(resolveTheme(preference, systemPrefersDark)).toBe(expected);
    },
  );
});

describe("applyTheme", () => {
  test("stamps data-theme=light on the given root element", () => {
    const root = document.createElement("html");
    applyTheme(root, "light");
    expect(root.getAttribute("data-theme")).toBe("light");
  });

  test("stamps data-theme=dark on the given root element", () => {
    const root = document.createElement("html");
    applyTheme(root, "dark");
    expect(root.getAttribute("data-theme")).toBe("dark");
  });

  test("re-stamping overwrites the previous value", () => {
    const root = document.createElement("html");
    applyTheme(root, "light");
    expect(root.getAttribute("data-theme")).toBe("light");

    applyTheme(root, "dark");
    expect(root.getAttribute("data-theme")).toBe("dark");

    applyTheme(root, "light");
    expect(root.getAttribute("data-theme")).toBe("light");
  });
});

interface MatchMediaMock {
  readonly mql: MediaQueryList;
  dispatchChange(matches: boolean): void;
}

function mockMatchMedia(initialMatches: boolean): MatchMediaMock {
  let matches = initialMatches;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();

  const mql = {
    get matches() {
      return matches;
    },
    media: "(prefers-color-scheme: dark)",
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.delete(listener);
    },
    dispatchEvent: () => false,
  } as unknown as MediaQueryList;

  vi.spyOn(window, "matchMedia").mockReturnValue(mql);

  return {
    mql,
    dispatchChange(nextMatches: boolean) {
      matches = nextMatches;
      const event = { matches: nextMatches, media: mql.media } as unknown as MediaQueryListEvent;
      for (const listener of listeners) {
        listener(event);
      }
    },
  };
}

function wrapper(defaultPreference?: ThemePreference) {
  return function Wrapper({ children }: { children: ReactNode }): ReactElement {
    const props = defaultPreference ? { children, defaultPreference } : { children };
    return createElement(ThemeProvider, props);
  };
}

describe("ThemeProvider / useThemePreference", () => {
  test("defaults to 'system' when no defaultPreference is given", () => {
    mockMatchMedia(false);
    const { result } = renderHook(() => useThemePreference(), { wrapper: wrapper() });
    expect(result.current.preference).toBe("system");
    expect(result.current.resolved).toBe("light");
  });

  test("honors an explicit defaultPreference", () => {
    mockMatchMedia(false);
    const { result } = renderHook(() => useThemePreference(), { wrapper: wrapper("dark") });
    expect(result.current.preference).toBe("dark");
    expect(result.current.resolved).toBe("dark");
  });

  test("resolves 'system' against the current OS preference at mount", () => {
    mockMatchMedia(true);
    const { result } = renderHook(() => useThemePreference(), { wrapper: wrapper("system") });
    expect(result.current.resolved).toBe("dark");
  });

  test("setPreference updates both preference and resolved", () => {
    mockMatchMedia(false);
    const { result } = renderHook(() => useThemePreference(), { wrapper: wrapper("light") });

    act(() => {
      result.current.setPreference("dark");
    });

    expect(result.current.preference).toBe("dark");
    expect(result.current.resolved).toBe("dark");
  });

  test("stamps document.documentElement with the resolved theme", () => {
    mockMatchMedia(false);
    const { result } = renderHook(() => useThemePreference(), { wrapper: wrapper("light") });
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");

    act(() => {
      result.current.setPreference("dark");
    });
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  test("reacts to a simulated OS theme change while preference is 'system'", () => {
    const matchMedia = mockMatchMedia(false);
    const { result } = renderHook(() => useThemePreference(), { wrapper: wrapper("system") });
    expect(result.current.resolved).toBe("light");

    act(() => {
      matchMedia.dispatchChange(true);
    });
    expect(result.current.resolved).toBe("dark");

    act(() => {
      matchMedia.dispatchChange(false);
    });
    expect(result.current.resolved).toBe("light");
  });

  test("ignores OS theme changes while preference is an explicit light/dark", () => {
    const matchMedia = mockMatchMedia(false);
    const { result } = renderHook(() => useThemePreference(), { wrapper: wrapper("light") });

    act(() => {
      matchMedia.dispatchChange(true);
    });

    expect(result.current.preference).toBe("light");
    expect(result.current.resolved).toBe("light");
  });

  test("useThemePreference throws outside a ThemeProvider", () => {
    // React logs the render-phase error via console.error before rethrowing it; suppress that
    // expected log for this test only (vitest.setup.ts otherwise turns it into a test failure).
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => renderHook(() => useThemePreference())).toThrow(
      "useThemePreference must be used within a ThemeProvider",
    );
  });

  test("renders children", () => {
    mockMatchMedia(false);
    render(createElement(ThemeProvider, null, createElement("p", null, "child content")));
    expect(screen.getByText("child content")).toBeInTheDocument();
  });
});
