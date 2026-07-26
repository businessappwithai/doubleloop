// tests/shell-app-frame.test.tsx — module m16 (Astryx UI shell). Covers AppFrame's three panes
// and inspector collapse (the acceptance criteria), plus SidebarChrome and ToolbarShell — the
// other two structural shell components this module owns that have no dedicated test file of
// their own (Implementation.md m16 names only four test files; these two are folded in here
// since CLAUDE.md §5 requires every exported component to be covered).
import { describe, test, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppFrame } from "../src/components/shell/AppFrame";
import { SidebarChrome } from "../src/components/shell/SidebarChrome";
import { ToolbarShell } from "../src/components/shell/ToolbarShell";

describe("AppFrame", () => {
  test("renders all three panes when sidebar, main content, and inspector are supplied", () => {
    render(
      <AppFrame sidebar={<div>sidebar content</div>} inspector={<div>inspector content</div>}>
        <div>main content</div>
      </AppFrame>,
    );

    const sidebar = screen.getByRole("navigation", { name: "Sidebar" });
    expect(sidebar).toHaveTextContent("sidebar content");

    const main = screen.getByRole("main");
    expect(main).toHaveTextContent("main content");

    const inspector = screen.getByRole("complementary", { name: "Inspector" });
    expect(inspector).toHaveTextContent("inspector content");
  });

  test("collapses the inspector pane entirely when the slot is omitted", () => {
    render(
      <AppFrame sidebar={<div>sidebar content</div>}>
        <div>main content</div>
      </AppFrame>,
    );

    expect(screen.getByRole("navigation", { name: "Sidebar" })).toBeInTheDocument();
    expect(screen.getByRole("main")).toBeInTheDocument();
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  });

  test("collapses the inspector pane when explicitly falsy", () => {
    render(
      <AppFrame sidebar={<div>sidebar content</div>} inspector={null}>
        <div>main content</div>
      </AppFrame>,
    );

    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  });
});

describe("SidebarChrome", () => {
  test("renders the given title", () => {
    render(<SidebarChrome title="Engineering Knowledge Workspace" />);
    expect(screen.getByRole("heading", { name: "Engineering Knowledge Workspace" })).toBeInTheDocument();
  });

  test("renders an empty state when no children are supplied", () => {
    render(<SidebarChrome title="Bundles" />);
    expect(screen.getByText("Nothing here yet")).toBeInTheDocument();
    expect(screen.getByText("Content will appear here once it exists.")).toBeInTheDocument();
  });

  test("supports a custom empty state label and description", () => {
    render(
      <SidebarChrome
        title="Bundles"
        emptyStateLabel="No bundles"
        emptyStateDescription="Create one to get started."
      />,
    );
    expect(screen.getByText("No bundles")).toBeInTheDocument();
    expect(screen.getByText("Create one to get started.")).toBeInTheDocument();
  });

  test("renders children in the scroll region instead of the empty state", () => {
    render(
      <SidebarChrome title="Bundles">
        <div>a real bundle row</div>
      </SidebarChrome>,
    );
    expect(screen.getByText("a real bundle row")).toBeInTheDocument();
    expect(screen.queryByText("Nothing here yet")).not.toBeInTheDocument();
  });

  test("calls onFilterChange with the current value on every keystroke", async () => {
    const user = userEvent.setup();
    const onFilterChange = vi.fn();
    render(<SidebarChrome title="Bundles" onFilterChange={onFilterChange} />);

    const filterInput = screen.getByPlaceholderText("Filter…");
    await user.type(filterInput, "abc");

    expect(onFilterChange).toHaveBeenCalledTimes(3);
    expect(onFilterChange).toHaveBeenNthCalledWith(1, "a");
    expect(onFilterChange).toHaveBeenNthCalledWith(2, "ab");
    expect(onFilterChange).toHaveBeenNthCalledWith(3, "abc");
    expect(filterInput).toHaveValue("abc");
  });

  test("uses a custom filter placeholder", () => {
    render(<SidebarChrome title="Bundles" filterPlaceholder="Search bundles…" />);
    expect(screen.getByPlaceholderText("Search bundles…")).toBeInTheDocument();
  });

  test("renders the footer slot when supplied, and omits it otherwise", () => {
    const { rerender } = render(<SidebarChrome title="Bundles" />);
    expect(screen.queryByText("footer content")).not.toBeInTheDocument();

    rerender(<SidebarChrome title="Bundles" footer={<div>footer content</div>} />);
    expect(screen.getByText("footer content")).toBeInTheDocument();
  });
});

describe("ToolbarShell", () => {
  test("renders leading, content, and action slots together", () => {
    render(
      <ToolbarShell leading={<span>back</span>} actions={<button type="button">save</button>}>
        <span>Concept title</span>
      </ToolbarShell>,
    );

    expect(screen.getByText("back")).toBeInTheDocument();
    expect(screen.getByText("Concept title")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "save" })).toBeInTheDocument();
  });

  test("renders without crashing when every slot is omitted", () => {
    const { container } = render(<ToolbarShell />);
    expect(container).toBeInTheDocument();
  });
});
