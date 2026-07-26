// tests/shell-theme-toggle.test.tsx — module m16 (Astryx UI shell). Covers ThemeToggle cycling
// light -> dark -> system -> light via user-event, asserting the accessible name (and the
// resulting data-theme stamp) at every step (Implementation.md m16 acceptance criteria).
import { describe, test, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "../src/styles/theme";
import { ThemeToggle } from "../src/components/shell/ThemeToggle";

describe("ThemeToggle", () => {
  test("cycles light -> dark -> system -> light, asserting the accessible name at each step", async () => {
    const user = userEvent.setup();
    render(
      <ThemeProvider defaultPreference="light">
        <ThemeToggle />
      </ThemeProvider>,
    );

    expect(screen.getByRole("button", { name: "Theme: Light" })).toBeInTheDocument();
    expect(document.documentElement).toHaveAttribute("data-theme", "light");

    await user.click(screen.getByRole("button", { name: "Theme: Light" }));
    expect(screen.getByRole("button", { name: "Theme: Dark" })).toBeInTheDocument();
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");

    await user.click(screen.getByRole("button", { name: "Theme: Dark" }));
    expect(screen.getByRole("button", { name: "Theme: System" })).toBeInTheDocument();
    // The global matchMedia stub (vitest.setup.ts) reports prefers-color-scheme: dark as false.
    expect(document.documentElement).toHaveAttribute("data-theme", "light");

    await user.click(screen.getByRole("button", { name: "Theme: System" }));
    expect(screen.getByRole("button", { name: "Theme: Light" })).toBeInTheDocument();
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
  });

  test("starts from an explicit dark preference with the matching accessible name and visible text", () => {
    render(
      <ThemeProvider defaultPreference="dark">
        <ThemeToggle />
      </ThemeProvider>,
    );

    const button = screen.getByRole("button", { name: "Theme: Dark" });
    expect(button).toBeInTheDocument();
    expect(button).toHaveTextContent("Dark");
  });

  test("starts from an explicit system preference with the matching accessible name", () => {
    render(
      <ThemeProvider defaultPreference="system">
        <ThemeToggle />
      </ThemeProvider>,
    );

    expect(screen.getByRole("button", { name: "Theme: System" })).toBeInTheDocument();
  });
});
