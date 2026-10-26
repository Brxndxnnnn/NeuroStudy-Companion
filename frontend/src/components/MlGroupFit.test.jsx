import { beforeEach, describe, expect, test, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"

const api = vi.hoisted(() => ({
  getPhase1Eligibility: vi.fn(),
  getMlGroupFit: vi.fn(),
}))
vi.mock("@/utils/api", () => api)

import MlGroupFit, { placementText } from "./MlGroupFit"

const ok = (body, status = 200) => ({ ok: status < 400, status, json: async () => body })

const GROUP = {
  group_id: "g1",
  name: "Pilot",
  current_model: { model_version: 7, members: [{ client_id: "c1", client_name: "Rashid" }] },
}

const MEMBERS = [
  { client_id: "c1", client_name: "Rashid", distance: 0.8, error: 1.1 },
  { client_id: "c2", client_name: "Tom", distance: 1.4, error: 1.3 },
]

const FIT = {
  client_id: "c9", client_name: "New Hire", model_version: 7, session_start: "2026-10-20T00:00:00Z",
  personality: {
    available: true, distance: 1.0, members: MEMBERS,
    placement: { within_range: true, members_further: 1, n_members: 2 },
    domains: ["E", "A", "C", "N", "O"].map((d) => ({ domain: d, client: 3, group_mean: 3.2, group_sd: 0.3, z: -0.7 })),
  },
  eeg_profile: {
    available: true, distance: 2.6, members: [], placement: null,
    features: [{ channel: "FP1", band: "alpha", client: 12, group_mean: 20, group_sd: 3, z: -2.7 }],
  },
  response: {
    available: true, error: 2.0, n_epochs: 120, members: MEMBERS,
    mae: { valence: 2.1, arousal: 1.9 }, r2: { valence: -0.5, arousal: -0.4 },
    placement: { within_range: false, members_further: 0, n_members: 2 },
  },
}

beforeEach(() => vi.clearAllMocks())

describe("placementText", () => {
  const words = { closer: "closer to the group", further: "further from the group" }
  test("within the range names how many members are further out", () => {
    expect(placementText({ within_range: true, members_further: 2, n_members: 3 }, words))
      .toBe("Within the group's range: closer to the group than 2 of 3 members.")
  })
  test("outside the range", () => {
    expect(placementText({ within_range: false, members_further: 0, n_members: 3 }, words))
      .toBe("Outside the group's range: further from the group than every member.")
  })
})

describe("MlGroupFit", () => {
  test("offers only clients the model was not trained on, and shows all three results", async () => {
    api.getPhase1Eligibility.mockResolvedValue(ok({ clients: [
      { client_id: "c1", client_name: "Rashid" },
      { client_id: "c9", client_name: "New Hire" },
    ] }))
    api.getMlGroupFit.mockResolvedValue(ok(FIT))
    render(<MlGroupFit group={GROUP} />)

    const select = await screen.findByLabelText("Client to compare")
    expect(screen.queryByRole("option", { name: "Rashid" })).toBeNull()
    fireEvent.change(select, { target: { value: "c9" } })
    fireEvent.click(screen.getByRole("button", { name: "Compare" }))

    expect(await screen.findByText(/Within the group's range: closer to the group than 1 of 2 members/)).toBeInTheDocument()
    expect(screen.getByText("Negative emotionality")).toBeInTheDocument()
    expect(screen.getByText(/Not placed in a range: that needs at least 3 members/)).toBeInTheDocument()
    expect(screen.getByText("FP1 · alpha")).toBeInTheDocument()
    expect(screen.getByText(/Outside the group's range: a larger error than every member/)).toBeInTheDocument()
    expect(api.getMlGroupFit).toHaveBeenCalledWith("g1", "c9")
  })

  test("shows the service's refusal", async () => {
    api.getPhase1Eligibility.mockResolvedValue(ok({ clients: [{ client_id: "c9", client_name: "New Hire" }] }))
    api.getMlGroupFit.mockResolvedValue(ok({ detail: "This group has no trained model yet. Train it first." }, 404))
    render(<MlGroupFit group={GROUP} />)

    fireEvent.change(await screen.findByLabelText("Client to compare"), { target: { value: "c9" } })
    fireEvent.click(screen.getByRole("button", { name: "Compare" }))
    expect(await screen.findByText(/no trained model yet/)).toBeInTheDocument()
  })
})
