// tests/shell-document-header.test.tsx — module m16 (Astryx UI shell). Covers every
// TrustLevel/Lifecycle badge rendering, an empty breadcrumb, and a six-level breadcrumb
// (Implementation.md m16 acceptance criteria).
import { describe, test, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { DocumentHeader, type DocumentHeaderBreadcrumbEntry } from "../src/components/shell/DocumentHeader";
import type { Lifecycle, TrustLevel } from "../src/core/types";

describe("DocumentHeader — title", () => {
  test("renders the title as a heading", () => {
    render(<DocumentHeader title="Deployment Runbook" trust="unverified" lifecycle="draft" breadcrumb={[]} />);
    expect(screen.getByRole("heading", { name: "Deployment Runbook" })).toBeInTheDocument();
  });
});

describe("DocumentHeader — trust badge", () => {
  const CASES: ReadonlyArray<{ trust: TrustLevel; label: string }> = [
    { trust: "unverified", label: "Unverified" },
    { trust: "machine-confirmed", label: "Machine-confirmed" },
    { trust: "human-reviewed", label: "Human-reviewed" },
  ];

  test.each(CASES)("renders the $trust badge as '$label'", ({ trust, label }) => {
    render(<DocumentHeader title="Doc" trust={trust} lifecycle="draft" breadcrumb={[]} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });
});

describe("DocumentHeader — lifecycle badge", () => {
  const CASES: ReadonlyArray<{ lifecycle: Lifecycle; label: string }> = [
    { lifecycle: "draft", label: "Draft" },
    { lifecycle: "active", label: "Active" },
    { lifecycle: "deprecated", label: "Deprecated" },
    { lifecycle: "archived", label: "Archived" },
  ];

  test.each(CASES)("renders the $lifecycle badge as '$label'", ({ lifecycle, label }) => {
    render(<DocumentHeader title="Doc" trust="unverified" lifecycle={lifecycle} breadcrumb={[]} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });
});

describe("DocumentHeader — breadcrumb", () => {
  test("renders no breadcrumb landmark when the breadcrumb is empty", () => {
    render(<DocumentHeader title="Doc" trust="unverified" lifecycle="draft" breadcrumb={[]} />);
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Doc" })).toBeInTheDocument();
  });

  test("renders a six-level breadcrumb with the last entry marked current", () => {
    const breadcrumb: readonly DocumentHeaderBreadcrumbEntry[] = [
      { id: "1", label: "Bundle", href: "/bundles/1" },
      { id: "2", label: "Runbooks", href: "/bundles/1/runbooks" },
      { id: "3", label: "Deployment", href: "/bundles/1/runbooks/deployment" },
      { id: "4", label: "Production", href: "/bundles/1/runbooks/deployment/production" },
      { id: "5", label: "Rollback", href: "/bundles/1/runbooks/deployment/production/rollback" },
      { id: "6", label: "Current Step" },
    ];

    render(<DocumentHeader title="Doc" trust="unverified" lifecycle="draft" breadcrumb={breadcrumb} />);

    const nav = screen.getByRole("navigation", { name: "Breadcrumb" });
    for (const entry of breadcrumb) {
      expect(within(nav).getByText(entry.label)).toBeInTheDocument();
    }

    const current = within(nav).getByText("Current Step");
    expect(current).toHaveAttribute("aria-current", "page");

    const bundleLink = within(nav).getByRole("link", { name: "Bundle" });
    expect(bundleLink).toHaveAttribute("href", "/bundles/1");

    // Only the current (last) item should carry aria-current.
    expect(nav.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
  });
});
