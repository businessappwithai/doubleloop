// src/components/shell/ThemeToggle.tsx — a single control that cycles the workspace's theme
// preference light -> dark -> system -> light. Reads/writes through `useThemePreference`
// (src/styles/theme.tsx) rather than owning any theme state itself, so every host (ToolbarShell,
// or any future settings panel) sees one source of truth for the resolved theme.
import type { ReactElement } from "react";
import { Button } from "@astryxdesign/core";
import { useThemePreference, type ThemePreference } from "../../styles/theme";

const NEXT_PREFERENCE: Record<ThemePreference, ThemePreference> = {
  light: "dark",
  dark: "system",
  system: "light",
};

const PREFERENCE_LABEL: Record<ThemePreference, string> = {
  light: "Light",
  dark: "Dark",
  system: "System",
};

/** Cycles the theme preference light -> dark -> system -> light on each click. */
export function ThemeToggle(): ReactElement {
  const { preference, setPreference } = useThemePreference();
  const next = NEXT_PREFERENCE[preference];

  return (
    <Button
      label={`Theme: ${PREFERENCE_LABEL[preference]}`}
      tooltip={`Switch to ${PREFERENCE_LABEL[next]} theme`}
      variant="ghost"
      size="sm"
      onClick={() => setPreference(next)}
    >
      {PREFERENCE_LABEL[preference]}
    </Button>
  );
}
