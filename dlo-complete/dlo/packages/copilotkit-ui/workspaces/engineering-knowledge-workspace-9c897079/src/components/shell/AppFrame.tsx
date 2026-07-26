// src/components/shell/AppFrame.tsx — the three-pane application frame (Architecture.md "UI
// modules" AppShell: "Astryx frame: header, sidebar slot, content slot"). The inspector pane is
// entirely absent from the DOM — not merely visually hidden — when its slot isn't supplied, so a
// route without an inspector (most of them, at least until m20/m21) doesn't reserve layout space
// it never uses. Pane widths come from the shell tokens in tokens.stylex.ts, not hard-coded
// numbers, so a later design pass can retune them in one place.
import type { ReactElement, ReactNode } from "react";
import * as stylex from "@stylexjs/stylex";
import { Stack } from "@astryxdesign/core";
import { shellColorVars, shellSpacingVars } from "../../styles/tokens.stylex";

const styles = stylex.create({
  frame: {
    width: "100%",
    minHeight: "100dvh",
  },
  sidebar: {
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: shellSpacingVars["--eng-rail-width"],
    minWidth: 0,
    borderInlineEndWidth: "1px",
    borderInlineEndStyle: "solid",
    borderInlineEndColor: shellColorVars["--eng-chrome-border"],
  },
  main: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: "auto",
    minWidth: 0,
  },
  inspector: {
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: shellSpacingVars["--eng-inspector-width"],
    minWidth: 0,
    borderInlineStartWidth: "1px",
    borderInlineStartStyle: "solid",
    borderInlineStartColor: shellColorVars["--eng-chrome-border"],
  },
});

export interface AppFrameProps {
  /** Sidebar rail content — navigation tree, filters, workspace switcher. */
  readonly sidebar: ReactNode;
  /** Optional inspector pane content. Omit (or pass a falsy value) to collapse the pane. */
  readonly inspector?: ReactNode;
  /** Main column content. */
  readonly children: ReactNode;
}

/**
 * The workspace's three-pane frame: a sidebar rail, a main column, and an optional inspector
 * pane. Mounted once at the document root (`src/routes/__root.tsx`) so every route renders
 * inside it.
 */
export function AppFrame({ sidebar, inspector, children }: AppFrameProps): ReactElement {
  return (
    <Stack direction="horizontal" gap={0} xstyle={styles.frame}>
      <Stack as="nav" aria-label="Sidebar" direction="vertical" gap={0} xstyle={styles.sidebar}>
        {sidebar}
      </Stack>
      <Stack as="main" direction="vertical" gap={0} xstyle={styles.main}>
        {children}
      </Stack>
      {inspector ? (
        <Stack as="aside" aria-label="Inspector" direction="vertical" gap={0} xstyle={styles.inspector}>
          {inspector}
        </Stack>
      ) : null}
    </Stack>
  );
}
