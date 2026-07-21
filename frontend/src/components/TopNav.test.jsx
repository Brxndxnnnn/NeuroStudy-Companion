import { describe, test, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/history",
}));
vi.mock("@/utils/api", () => ({
  logout: vi.fn(),
}));

import TopNav from "./TopNav";

beforeEach(() => {
  localStorage.clear();
});

describe("TopNav role-based navigation", () => {
  test("admin role sees the Admin link", async () => {
    localStorage.setItem("userRole", "admin");
    render(<TopNav />);
    expect(await screen.findByRole("link", { name: "Admin" })).toBeInTheDocument();
  });

  test("superadmin role sees the Admin link", async () => {
    localStorage.setItem("userRole", "superadmin");
    render(<TopNav />);
    expect(await screen.findByRole("link", { name: "Admin" })).toBeInTheDocument();
  });

  test("technician role does NOT see the Admin link, sees clinician-only links instead", async () => {
    localStorage.setItem("userRole", "technician");
    render(<TopNav />);
    // Wait for the role-driven effect to settle before asserting absence.
    await screen.findByRole("link", { name: "Insights" });
    expect(screen.queryByRole("link", { name: "Admin" })).not.toBeInTheDocument();
  });

  test("no stored role defaults to clinician links, not admin", async () => {
    render(<TopNav />);
    await screen.findByRole("link", { name: "Insights" });
    expect(screen.queryByRole("link", { name: "Admin" })).not.toBeInTheDocument();
  });
});
