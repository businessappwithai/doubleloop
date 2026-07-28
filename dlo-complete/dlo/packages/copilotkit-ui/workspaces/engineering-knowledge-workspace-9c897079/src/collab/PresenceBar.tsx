// src/collab/PresenceBar.tsx — an Astryx-composed stacked-avatar presence indicator over the
// room's remote peers (see awareness.ts's `PresencePeer`). Renders nothing for zero peers (per
// Architecture.md's PresenceBar acceptance); caps visible avatars and folds the rest into a
// single `AvatarGroupOverflow` "+N" badge. Each avatar's accessible name (`Avatar` renders
// `role="img"`/`aria-label` from `alt`) is the peer's display name, falling back to a placeholder
// for a peer with no name; `colorForActor`'s per-actor color renders as a small status dot so
// peers stay visually distinguishable even when two share initials.
import type { ReactElement } from "react";
import { Avatar, AvatarGroup, AvatarGroupOverflow } from "@astryxdesign/core";
import * as stylex from "@stylexjs/stylex";
import type { PresencePeer } from "./awareness";

const MAX_VISIBLE_PEERS = 5;
const ANONYMOUS_LABEL = "Anonymous";

const styles = stylex.create({
  colorDot: {
    display: "block",
    width: "8px",
    height: "8px",
    borderRadius: "9999px",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "light-dark(#FFFFFF, #1B1C1E)",
  },
});

export interface PresenceBarProps {
  readonly peers: readonly PresencePeer[];
}

/** A stacked-avatar presence indicator. Renders nothing when there are no peers. */
export function PresenceBar({ peers }: PresenceBarProps): ReactElement | null {
  if (peers.length === 0) {
    return null;
  }

  const visible = peers.slice(0, MAX_VISIBLE_PEERS);
  const overflowCount = peers.length - visible.length;

  return (
    <AvatarGroup
      size="sm"
      aria-label={`${peers.length} ${peers.length === 1 ? "person" : "people"} editing this document`}
    >
      {visible.map((peer) => {
        const displayName = peer.name.trim().length > 0 ? peer.name : ANONYMOUS_LABEL;
        return (
          <Avatar
            key={peer.clientId}
            name={displayName}
            alt={displayName}
            status={<span {...stylex.props(styles.colorDot)} style={{ backgroundColor: peer.color }} />}
          />
        );
      })}
      {overflowCount > 0 ? <AvatarGroupOverflow count={overflowCount} /> : null}
    </AvatarGroup>
  );
}
