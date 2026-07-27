// src/styles/tokens.stylex.ts — the workspace's own spacing, radius, elevation and semantic
// colour tokens, defined with StyleX `defineVars` and layered on top of the
// `@astryxdesign/theme-neutral` cascade (loaded as a stylesheet in src/routes/__root.tsx).
// These cover shell-level layout concerns Astryx's own component props don't reach (fixed
// pane widths, chrome dividers) — everything at the component level keeps using Astryx's own
// tokens. Colour values use `light-dark()` so dark mode is a token override resolved by the
// browser's active `color-scheme` (driven by `data-theme` on <html>, see src/styles/theme.tsx),
// never a second stylesheet.
import * as stylex from "@stylexjs/stylex";

export const shellSpacingVars = stylex.defineVars({
  "--eng-rail-width": "260px",
  "--eng-inspector-width": "320px",
  "--eng-toolbar-height": "52px",
});

export const shellRadiusVars = stylex.defineVars({
  "--eng-radius-panel": "12px",
  "--eng-radius-chrome": "8px",
});

export const shellElevationVars = stylex.defineVars({
  "--eng-elevation-chrome": "light-dark(0 1px 0 rgba(10, 19, 23, 0.08), 0 1px 0 rgba(0, 0, 0, 0.4))",
  "--eng-elevation-panel":
    "light-dark(0 1px 3px rgba(10, 19, 23, 0.12), 0 1px 3px rgba(0, 0, 0, 0.5))",
});

export const shellColorVars = stylex.defineVars({
  "--eng-chrome-border": "light-dark(#E4E7EB, #2C2D30)",
  "--eng-scrim-background": "light-dark(rgba(10, 19, 23, 0.04), rgba(255, 255, 255, 0.03))",
});
