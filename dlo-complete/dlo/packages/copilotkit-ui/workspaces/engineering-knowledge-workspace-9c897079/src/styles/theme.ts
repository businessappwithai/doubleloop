// src/styles/theme.ts — theme preference resolution and the provider that drives it.
// `resolveTheme`/`applyTheme` are plain, DOM-agnostic-except-for-the-root-element functions so
// they're trivially unit testable. `ThemeProvider` is the "theme provider" src/routes/__root.tsx
// mounts: it owns the user's `light | dark | system` preference, tracks the OS preference via
// `matchMedia`, and stamps the resolved theme onto `document.documentElement` — the mechanism
// `@astryxdesign/theme-neutral`'s stylesheet (loaded in __root.tsx) expects, per its own docs:
// "For RSC / SSR, set data-theme on <html>". No Astryx <Theme> component is needed: the theme's
// CSS is loaded as a static stylesheet, not constructed from a runtime theme object.
import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

const DARK_MEDIA_QUERY = "(prefers-color-scheme: dark)";

/** Resolves a user preference to a concrete light/dark theme given the current OS preference. */
export function resolveTheme(preference: ThemePreference, systemPrefersDark: boolean): ResolvedTheme {
  if (preference === "system") {
    return systemPrefersDark ? "dark" : "light";
  }
  return preference;
}

/** Stamps `data-theme` on `root`, driving `color-scheme` (and every `light-dark()` token). */
export function applyTheme(root: HTMLElement, theme: ResolvedTheme): void {
  root.setAttribute("data-theme", theme);
}

export interface ThemeContextValue {
  readonly preference: ThemePreference;
  readonly resolved: ResolvedTheme;
  readonly setPreference: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function getSystemPrefersDark(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia(DARK_MEDIA_QUERY).matches;
}

export interface ThemeProviderProps {
  readonly children: ReactNode;
  /** Overrides the starting preference. Defaults to 'system'. */
  readonly defaultPreference?: ThemePreference;
}

export function ThemeProvider({ children, defaultPreference }: ThemeProviderProps): ReactElement {
  const [preference, setPreference] = useState<ThemePreference>(defaultPreference ?? "system");
  const [systemPrefersDark, setSystemPrefersDark] = useState(getSystemPrefersDark);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const mediaQueryList = window.matchMedia(DARK_MEDIA_QUERY);
    const onChange = (event: MediaQueryListEvent) => {
      setSystemPrefersDark(event.matches);
    };
    setSystemPrefersDark(mediaQueryList.matches);
    mediaQueryList.addEventListener("change", onChange);
    return () => {
      mediaQueryList.removeEventListener("change", onChange);
    };
  }, []);

  const resolved = resolveTheme(preference, systemPrefersDark);

  useEffect(() => {
    applyTheme(document.documentElement, resolved);
  }, [resolved]);

  const value = useMemo<ThemeContextValue>(
    () => ({ preference, resolved, setPreference }),
    [preference, resolved],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/** Reads the current theme preference and setter. Throws outside a `ThemeProvider`. */
export function useThemePreference(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useThemePreference must be used within a ThemeProvider");
  }
  return context;
}
