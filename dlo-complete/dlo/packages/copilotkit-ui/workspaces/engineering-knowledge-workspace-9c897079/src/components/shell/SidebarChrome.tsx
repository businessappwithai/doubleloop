// src/components/shell/SidebarChrome.tsx — the sidebar rail's chrome: a header with the
// workspace title and a filter field, a scrollable content region, and an optional footer slot.
// Pure presentation: no bundle/concept data source exists yet (that lands with m9/m10's
// BundleModule and HierarchyModule), so the filter is uncontrolled and the scroll region renders
// whatever `children` the caller supplies — or a real (non-fabricated) empty state otherwise.
import { useId, useState, type ReactElement, type ReactNode } from "react";
import * as stylex from "@stylexjs/stylex";
import { Field, Icon, Item, Stack, StackItem, Text } from "@astryxdesign/core";
import { shellColorVars } from "../../styles/tokens.stylex";

const styles = stylex.create({
  header: {
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderBottomColor: shellColorVars["--eng-chrome-border"],
  },
  footer: {
    borderTopWidth: "1px",
    borderTopStyle: "solid",
    borderTopColor: shellColorVars["--eng-chrome-border"],
  },
  filterInput: {
    width: "100%",
    border: "none",
    outline: "none",
    background: "transparent",
    fontSize: "inherit",
    fontFamily: "inherit",
    color: "inherit",
  },
});

export interface SidebarChromeProps {
  /** Title rendered in the sidebar header (workspace or bundle name). */
  readonly title: string;
  /** Called with the current filter text on every keystroke. */
  readonly onFilterChange?: (value: string) => void;
  readonly filterPlaceholder?: string;
  /** Content rendered in the scrollable region below the header. */
  readonly children?: ReactNode;
  /** Content rendered in a bordered footer slot below the scroll region. */
  readonly footer?: ReactNode;
  readonly emptyStateLabel?: string;
  readonly emptyStateDescription?: string;
}

/** The sidebar rail's chrome: header + filter, scrollable body, optional footer. */
export function SidebarChrome({
  title,
  onFilterChange,
  filterPlaceholder = "Filter…",
  children,
  footer,
  emptyStateLabel = "Nothing here yet",
  emptyStateDescription = "Content will appear here once it exists.",
}: SidebarChromeProps): ReactElement {
  const filterInputId = useId();
  const [filterValue, setFilterValue] = useState("");

  function handleFilterChange(value: string): void {
    setFilterValue(value);
    onFilterChange?.(value);
  }

  return (
    <Stack direction="vertical" gap={0}>
      <Stack direction="vertical" gap={2} padding={3} xstyle={styles.header}>
        <Text type="label" weight="semibold" as="h2">
          {title}
        </Text>
        <Field label="Filter" isLabelHidden inputID={filterInputId} width="100%">
          <Stack direction="horizontal" vAlign="center" gap={1}>
            <Icon icon="search" size="sm" color="secondary" />
            <input
              id={filterInputId}
              type="search"
              value={filterValue}
              placeholder={filterPlaceholder}
              onChange={(event) => handleFilterChange(event.target.value)}
              {...stylex.props(styles.filterInput)}
            />
          </Stack>
        </Field>
      </Stack>
      <StackItem size="fill" isScrollable>
        <Stack direction="vertical" gap={1} padding={2}>
          {children ?? <Item label={emptyStateLabel} description={emptyStateDescription} />}
        </Stack>
      </StackItem>
      {footer ? (
        <Stack direction="vertical" padding={2} xstyle={styles.footer}>
          {footer}
        </Stack>
      ) : null}
    </Stack>
  );
}
