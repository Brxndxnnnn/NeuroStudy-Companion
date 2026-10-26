import { beforeEach, describe, expect, test, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

const api = vi.hoisted(() => ({
  getMlGroups: vi.fn(),
  getPhase1Eligibility: vi.fn(),
  createMlGroup: vi.fn(),
  updateMlGroup: vi.fn(),
  deleteMlGroup: vi.fn(),
  trainMlGroup: vi.fn(),
  getMlGroupFit: vi.fn(),
}))
vi.mock("@/utils/api", () => api)

import MlGroupsPanel, { bfiEffect } from "./MlGroupsPanel"

const ok = (body, status = 200) => ({ ok: status < 400, status, json: async () => body })

const MODEL = {
  model_version: 7, n_clients: 3, n_epochs: 700, n_distinct_images: 24, trained_at: "2026-10-25T00:00:00Z",
  cv_r2_valence: -0.27, cv_r2_arousal: -0.17, cv_mae_valence: 1.3, cv_mae_arousal: 0.99,
  cv_r2_valence_no_bfi: -0.26, cv_r2_arousal_no_bfi: -0.18, cv_mae_valence_no_bfi: 1.29, cv_mae_arousal_no_bfi: 0.99,
  null_r2_valence: -0.16, null_r2_arousal: -0.12,
  members: [{ client_name: "Rashid", start_time: "2026-08-13T00:00:00Z" }],
}
const GROUP = { group_id: "g1", name: "Pilot", members: [{ client_id: "c1", client_name: "Rashid" }], current_model: null }

beforeEach(() => vi.clearAllMocks())

describe("bfiEffect", () => {
  test("calls a sub-0.02 change no meaningful difference", () => {
    expect(bfiEffect(MODEL)).toEqual({ text: "-0.01 valence, +0.01 arousal", summary: "no meaningful difference" })
  })
  test("is null without both scores", () => {
    expect(bfiEffect({ cv_r2_valence: 0.1 })).toBeNull()
  })
})

describe("MlGroupsPanel", () => {
  test("lists groups and shows who was left out after training", async () => {
    api.getMlGroups
      .mockResolvedValueOnce(ok({ groups: [GROUP], models_available: true }))
      .mockResolvedValueOnce(ok({ groups: [{ ...GROUP, current_model: MODEL }], models_available: true }))
    api.trainMlGroup.mockResolvedValue(ok({
      trained: true, message: "Trained on 3 member(s)' latest sessions.",
      skipped: [{ client_name: "Test Client", reason: "no complete BFI-2 questionnaire" }],
    }))
    const onTrained = vi.fn()
    render(<MlGroupsPanel onTrained={onTrained} />)

    expect(await screen.findByText("Pilot")).toBeInTheDocument()
    expect(screen.getByText("Not trained")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Train" }))

    expect(await screen.findByText(/Test Client \(no complete BFI-2 questionnaire\)/)).toBeInTheDocument()
    await waitFor(() => expect(onTrained).toHaveBeenCalled())
    expect(screen.getByText("Trained · v7")).toBeInTheDocument()
    expect(screen.getByText("Without BFI")).toBeInTheDocument()
    expect(screen.getByText("no meaningful difference")).toBeInTheDocument()
  })

  test("the editor flags clients who cannot train and creates the group", async () => {
    api.getMlGroups.mockResolvedValue(ok({ groups: [], models_available: true }))
    api.getPhase1Eligibility.mockResolvedValue(ok({
      min_session_labelled_images: 10,
      clients: [
        { client_id: "c1", client_name: "Rashid", latest_session_id: "s1", latest_session_at: "2026-08-13T00:00:00Z", n_labelled_images: 24, has_bfi: true },
        { client_id: "c2", client_name: "Eugene", latest_session_id: null, latest_session_at: null, n_labelled_images: 0, has_bfi: true },
      ],
    }))
    api.createMlGroup.mockResolvedValue(ok({ group_id: "g2" }, 201))
    render(<MlGroupsPanel />)

    fireEvent.click(await screen.findByRole("button", { name: "New group" }))
    expect(await screen.findByText(/Won't train: no session with EEG and 10\+ labelled images/)).toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText("e.g. Pilot cohort"), { target: { value: " Cohort A " } })
    fireEvent.click(screen.getByLabelText("Include Rashid"))
    fireEvent.click(screen.getByRole("button", { name: "Create group (1)" }))

    await waitFor(() => expect(api.createMlGroup).toHaveBeenCalledWith({ name: "Cohort A", clientIds: ["c1"] }))
  })
})
