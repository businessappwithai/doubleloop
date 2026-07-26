// src/components/shell/DocumentHeader.tsx — a Concept's header: an ancestor breadcrumb, the
// title, and TrustLevel/Lifecycle badges (Architecture.md "core" §1, src/core/types.ts). Pure
// presentation over the domain unions — no data fetching, no Relay fragment. The concept page
// (m21) supplies real field values; this component only owns the label/variant mapping.
import type { ReactElement } from "react";
import * as stylex from "@stylexjs/stylex";
import { Badge, type BadgeVariant, BreadcrumbItem, Breadcrumbs, Stack, Text } from "@astryxdesign/core";
import type { Lifecycle, TrustLevel } from "../../core/types";

const styles = stylex.create({
  header: {
    width: "100%",
  },
});

export interface DocumentHeaderBreadcrumbEntry {
  readonly id: string;
  readonly label: string;
  readonly href?: string;
}

export interface DocumentHeaderProps {
  readonly title: string;
  readonly trust: TrustLevel;
  readonly lifecycle: Lifecycle;
  /** Ancestor path from the bundle root to this concept's parent. Empty for a root concept. */
  readonly breadcrumb: readonly DocumentHeaderBreadcrumbEntry[];
}

const TRUST_BADGE_VARIANT: Record<TrustLevel, BadgeVariant> = {
  unverified: "neutral",
  "machine-confirmed": "info",
  "human-reviewed": "success",
};

const TRUST_LABEL: Record<TrustLevel, string> = {
  unverified: "Unverified",
  "machine-confirmed": "Machine-confirmed",
  "human-reviewed": "Human-reviewed",
};

const LIFECYCLE_BADGE_VARIANT: Record<Lifecycle, BadgeVariant> = {
  draft: "neutral",
  active: "success",
  deprecated: "warning",
  archived: "error",
};

const LIFECYCLE_LABEL: Record<Lifecycle, string> = {
  draft: "Draft",
  active: "Active",
  deprecated: "Deprecated",
  archived: "Archived",
};

/** A Concept's header: breadcrumb, title, trust badge, and lifecycle badge. */
export function DocumentHeader({ title, trust, lifecycle, breadcrumb }: DocumentHeaderProps): ReactElement {
  return (
    <Stack as="header" direction="vertical" gap={2} xstyle={styles.header}>
      {breadcrumb.length > 0 ? (
        <Breadcrumbs>
          {breadcrumb.map((entry, index) => (
            <BreadcrumbItem
              key={entry.id}
              isCurrent={index === breadcrumb.length - 1}
              {...(entry.href ? { href: entry.href } : {})}
            >
              {entry.label}
            </BreadcrumbItem>
          ))}
        </Breadcrumbs>
      ) : null}
      <Stack direction="horizontal" vAlign="center" gap={2}>
        <Text type="display-3" as="h1">
          {title}
        </Text>
        <Badge variant={TRUST_BADGE_VARIANT[trust]} label={TRUST_LABEL[trust]} />
        <Badge variant={LIFECYCLE_BADGE_VARIANT[lifecycle]} label={LIFECYCLE_LABEL[lifecycle]} />
      </Stack>
    </Stack>
  );
}
