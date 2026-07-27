// tests/collab-presence-bar.test.tsx — module m19 (Yjs collaboration client). Covers PresenceBar
// rendering with 0, 1, 5 and 12 peers (Implementation.md m19 acceptance: "overflow count
// asserted"), the accessible label per peer and for the group, and the anonymous-name fallback.
import { describe, test, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { PresenceBar } from "../src/collab/PresenceBar";
import { colorForActor, type PresencePeer } from "../src/collab/awareness";

function makePeer(clientId: number, name: string, overrides: Partial<PresencePeer> = {}): PresencePeer {
  const actorId = `actor-${clientId}`;
  return {
    clientId,
    actorId,
    name,
    color: colorForActor(actorId),
    lastSeen: 0,
    ...overrides,
  };
}

describe("PresenceBar — empty state", () => {
  test("renders nothing for zero peers", () => {
    const { container } = render(<PresenceBar peers={[]} />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole("group")).not.toBeInTheDocument();
  });
});

describe("PresenceBar — peer counts", () => {
  test("renders a single peer with a singular group label and no overflow", () => {
    const peers = [makePeer(1, "Ada Lovelace")];
    render(<PresenceBar peers={peers} />);

    expect(screen.getByRole("group", { name: "1 person editing this document" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Ada Lovelace" })).toBeInTheDocument();
    expect(screen.queryByText(/^\+\d+$/)).not.toBeInTheDocument();
  });

  test("renders five peers with a plural group label and no overflow", () => {
    const peers = Array.from({ length: 5 }, (_, i) => makePeer(i + 1, `Peer ${i + 1}`));
    render(<PresenceBar peers={peers} />);

    expect(screen.getByRole("group", { name: "5 people editing this document" })).toBeInTheDocument();
    for (const peer of peers) {
      expect(screen.getByRole("img", { name: peer.name })).toBeInTheDocument();
    }
    expect(screen.queryByText(/^\+\d+$/)).not.toBeInTheDocument();
  });

  test("renders twelve peers as five visible avatars plus a '+7' overflow badge", () => {
    const peers = Array.from({ length: 12 }, (_, i) => makePeer(i + 1, `Peer ${i + 1}`));
    render(<PresenceBar peers={peers} />);

    expect(screen.getByRole("group", { name: "12 people editing this document" })).toBeInTheDocument();
    expect(screen.getAllByRole("img")).toHaveLength(5);
    for (const peer of peers.slice(0, 5)) {
      expect(screen.getByRole("img", { name: peer.name })).toBeInTheDocument();
    }
    for (const peer of peers.slice(5)) {
      expect(screen.queryByRole("img", { name: peer.name })).not.toBeInTheDocument();
    }
    expect(screen.getByText("+7")).toBeInTheDocument();
    expect(screen.getByLabelText("7 more")).toBeInTheDocument();
  });
});

describe("PresenceBar — accessible naming", () => {
  test("falls back to 'Anonymous' for a peer with an empty name", () => {
    render(<PresenceBar peers={[makePeer(1, "")]} />);
    expect(screen.getByRole("img", { name: "Anonymous" })).toBeInTheDocument();
  });

  test("falls back to 'Anonymous' for a peer whose name is only whitespace", () => {
    render(<PresenceBar peers={[makePeer(1, "   ")]} />);
    expect(screen.getByRole("img", { name: "Anonymous" })).toBeInTheDocument();
  });
});

describe("PresenceBar — per-peer color dot", () => {
  test("gives each visible avatar a status dot, colored distinctly per peer", () => {
    const peers = [makePeer(1, "Ada"), makePeer(2, "Bob")];
    render(<PresenceBar peers={peers} />);

    const dotColors = peers.map((peer) => {
      const avatar = screen.getByRole("img", { name: peer.name });
      const dot = avatar.querySelector<HTMLElement>('[style*="background-color"]');
      expect(dot).not.toBeNull();
      return dot?.style.backgroundColor;
    });

    expect(dotColors[0]).toBeTruthy();
    expect(dotColors[1]).toBeTruthy();
    expect(dotColors[0]).not.toBe(dotColors[1]);
  });

  test("renders exactly one status dot per visible avatar", () => {
    const peers = Array.from({ length: 5 }, (_, i) => makePeer(i + 1, `Peer ${i + 1}`));
    const { container } = render(<PresenceBar peers={peers} />);
    expect(container.querySelectorAll('[style*="background-color"]')).toHaveLength(5);
  });
});
