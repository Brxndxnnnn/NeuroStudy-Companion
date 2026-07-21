import { beforeEach, describe, expect, test, vi } from "vitest"
import { render, screen } from "@testing-library/react"

const mockUseAuth = vi.fn()

vi.mock("next/navigation", () => ({
  usePathname: () => "/history"
}))

vi.mock("@/context/AuthContext", () => ({
  useAuth: () => mockUseAuth()
}))

import TopNav from "./TopNav"

function renderTopNav(role = null) {
  mockUseAuth.mockReturnValue({
    user: role
      ? {
        role,
        display_name: "Test User"
      }
      : null,
    signOut: vi.fn()
  })

  return render(<TopNav />)
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("TopNav role-based navigation", () => {
  test("admin role sees the Admin link", () => {
    renderTopNav("admin")

    expect(
      screen.getByRole("link", { name: "Admin" })
    ).toBeInTheDocument()
  })

  test("superadmin role sees the Admin link", () => {
    renderTopNav("superadmin")

    expect(
      screen.getByRole("link", { name: "Admin" })
    ).toBeInTheDocument()
  })

  test("technician role does not see Admin and sees clinician links", () => {
    renderTopNav("technician")

    expect(
      screen.queryByRole("link", { name: "Admin" })
    ).not.toBeInTheDocument()

    expect(
      screen.getByRole("link", { name: "Insights" })
    ).toBeInTheDocument()

    expect(
      screen.getByRole("link", { name: "Stimulus set" })
    ).toBeInTheDocument()
  })

  test("no authenticated user defaults to clinician links", () => {
    renderTopNav()

    expect(
      screen.queryByRole("link", { name: "Admin" })
    ).not.toBeInTheDocument()

    expect(
      screen.getByRole("link", { name: "Insights" })
    ).toBeInTheDocument()
  })
})