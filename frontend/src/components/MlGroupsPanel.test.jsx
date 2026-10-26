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
  test("training shows progress, polls, then shows the outcome and who was left out", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const RUNNING = { ...GROUP, train_status: "running", train_started_at: new Date().toISOString(), train_stale: false }
      const DONE = {
        ...GROUP, current_model: MODEL, train_status: "done", train_finished_at: new Date().toISOString(),
        train_result: {
          trained: true, message: "Trained on 3 member(s)' latest sessions.",
          skipped: [{ client_name: "Test Client", reason: "no complete BFI-2 questionnaire" }],
        },
      }
      api.getMlGroups
        .mockResolvedValueOnce(ok({ groups: [GROUP], models_available: true }))
        .mockResolvedValueOnce(ok({ groups: [RUNNING], models_available: true }))
        .mockResolvedValue(ok({ groups: [DONE], models_available: true }))
      api.trainMlGroup.mockResolvedValue(ok({ status: "running" }, 202))
      const onTrained = vi.fn()
      render(<MlGroupsPanel onTrained={onTrained} />)

      expect(await screen.findByText("Pilot")).toBeInTheDocument()
      expect(screen.getByText("Not trained")).toBeInTheDocument()

      fireEvent.click(screen.getByRole("button", { name: "Train" }))

      // Still training: the page says so instead of reporting a failure.
      expect(await screen.findByText(/Training… started at/)).toBeInTheDocument()
      expect(screen.getByText(/carries on in the background/)).toBeInTheDocument()
      expect(onTrained).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(4500)

      expect(await screen.findByText(/Test Client \(no complete BFI-2 questionnaire\)/)).toBeInTheDocument()
      await waitFor(() => expect(onTrained).toHaveBeenCalledTimes(1))
      expect(screen.getByText("Trained · v7")).toBeInTheDocument()
      expect(screen.getByText("Without BFI")).toBeInTheDocument()
      expect(screen.getByText("no meaningful difference")).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  test("a failed run says so with the reason", async () => {
    api.getMlGroups.mockResolvedValue(ok({ groups: [{
      ...GROUP, train_status: "failed", train_finished_at: "2026-10-26T09:00:00Z", train_error: "RuntimeError: database went away",
    }], models_available: true }))
    render(<MlGroupsPanel />)
    expect(await screen.findByText(/Training failed at/)).toBeInTheDocument()
    expect(screen.getByText("RuntimeError: database went away")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Train" })).not.toBeDisabled()
  })

  test("a run that never finished offers Train again", async () => {
    api.getMlGroups.mockResolvedValue(ok({ groups: [{
      ...GROUP, train_status: "running", train_started_at: "2026-10-26T07:00:00Z", train_stale: true,
    }], models_available: true }))
    render(<MlGroupsPanel />)
    expect(await screen.findByText(/has not finished. The ML service may have restarted/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Train" })).not.toBeDisabled()
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
