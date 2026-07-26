// src/components/shell/ToolbarShell.tsx — the main column's toolbar row: a leading slot (back
// button, breadcrumb), a title/content slot, and a trailing actions slot (theme toggle, primary
// actions). Purely structural chrome — later modules decide what each slot renders.
import type { ReactElement, ReactNode } from "react";
import * as stylex from "@stylexjs/stylex";
import { Stack } from "@astryxdesign/core";
import { shellColorVars, shellSpacingVars } from "../../styles/tokens.stylex";

const styles = stylex.create({
  toolbar: {
    height: shellSpacingVars["--eng-toolbar-height"],
    flexShrink: 0,
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderBottomColor: shellColorVars["--eng-chrome-border"],
  },
});

export interface ToolbarShellProps {
  /** Content rendered at the toolbar's leading edge (e.g. a back action). */
  readonly leading?: ReactNode;
  /** Content rendered after `leading` (e.g. a document title). */
  readonly children?: ReactNode;
  /** Content rendered at the toolbar's trailing edge (e.g. `ThemeToggle`). */
  readonly actions?: ReactNode;
}

/** The main column's toolbar row: leading, content, and trailing action slots. */
export function ToolbarShell({ leading, children, actions }: ToolbarShellProps): ReactElement {
  return (
    <Stack
      direction="horizontal"
      vAlign="center"
      justify="between"
      gap={3}
      paddingInline={3}
      xstyle={styles.toolbar}
    >
      <Stack direction="horizontal" vAlign="center" gap={2}>
        {leading}
        {children}
      </Stack>
      <Stack direction="horizontal" vAlign="center" gap={1}>
        {actions}
      </Stack>
    </Stack>
  );
}
