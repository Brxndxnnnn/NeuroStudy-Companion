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

  const CLIENTS = [
    { client_id: "c1", client_name: "rashid", latest_session_id: "s1", latest_session_at: "2026-08-13T00:00:00Z", n_labelled_images: 24, has_bfi: true },
    { client_id: "c2", client_name: "Eugene", latest_session_id: null, latest_session_at: null, n_labelled_images: 0, has_bfi: true },
    { client_id: "c3", client_name: "Brandon Chu", latest_session_id: "s3", latest_session_at: "2026-10-20T00:00:00Z", n_labelled_images: 20, has_bfi: true },
  ]
  const clientRows = () => screen.getAllByRole("checkbox", { name: /^Include / }).map((b) => b.getAttribute("aria-label"))

  test("the editor sorts, searches, filters, and selects in bulk", async () => {
    api.getMlGroups.mockResolvedValue(ok({ groups: [], models_available: true }))
    api.getPhase1Eligibility.mockResolvedValue(ok({ min_session_labelled_images: 10, clients: CLIENTS }))
    render(<MlGroupsPanel />)
    fireEvent.click(await screen.findByRole("button", { name: "New group" }))
    await screen.findByLabelText("Include rashid")

    // A to Z by default, whatever the case; clicking the header reverses it.
    expect(clientRows()).toEqual(["Include Brandon Chu", "Include Eugene", "Include rashid"])
    fireEvent.click(screen.getByRole("button", { name: /^Client/ }))
    expect(clientRows()).toEqual(["Include rashid", "Include Eugene", "Include Brandon Chu"])
    fireEvent.click(screen.getByRole("button", { name: /^Images/ }))
    expect(clientRows()).toEqual(["Include Brandon Chu", "Include rashid", "Include Eugene"])

    fireEvent.change(screen.getByLabelText("Search clients"), { target: { value: "RASH" } })
    expect(clientRows()).toEqual(["Include rashid"])
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }))

    fireEvent.click(screen.getByLabelText("Only clients ready to train"))
    expect(clientRows()).not.toContain("Include Eugene")
    fireEvent.click(screen.getByRole("button", { name: "Select all shown (2)" }))
    expect(screen.getByRole("button", { name: "Create group (2)" })).toBeInTheDocument()
    expect(screen.getByText(/2 selected · 2 will train/)).toBeInTheDocument()

    // Clicking a row ticks it; a chip removes it again.
    fireEvent.click(screen.getByLabelText("Only clients ready to train"))
    fireEvent.click(screen.getByText("Eugene"))
    expect(screen.getByText(/3 selected · 2 will train/)).toBeInTheDocument()
    expect(screen.getByText(/1 won't until they have a usable session and BFI-2/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Remove Eugene" }))
    expect(screen.getByLabelText("Include Eugene")).not.toBeChecked()

    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }))
    expect(screen.getByRole("button", { name: "Create group (0)" })).toBeDisabled()
  })

  test("cancelling with unsaved changes asks first", async () => {
    api.getMlGroups.mockResolvedValue(ok({ groups: [], models_available: true }))
    api.getPhase1Eligibility.mockResolvedValue(ok({ min_session_labelled_images: 10, clients: CLIENTS }))
    render(<MlGroupsPanel />)
    fireEvent.click(await screen.findByRole("button", { name: "New group" }))
    fireEvent.click(await screen.findByLabelText("Include rashid"))

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(screen.getByText("Discard your changes to this group?")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }))
    expect(screen.getByLabelText("Include rashid")).toBeChecked()

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    fireEvent.click(screen.getByRole("button", { name: "Discard" }))
    expect(screen.queryByText("New group", { selector: "h3" })).toBeNull()
  })

  test("the group list searches groups and members, sorts, and folds long member lists", async () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ client_id: `m${i}`, client_name: `Person ${9 - i}` }))
    api.getMlGroups.mockResolvedValue(ok({ groups: [
      { ...GROUP, group_id: "g1", name: "Zeta", created_at: "2026-10-26T00:00:00Z" },
      { ...GROUP, group_id: "g2", name: "Alpha", created_at: "2026-10-01T00:00:00Z", members: many },
    ], models_available: true }))
    render(<MlGroupsPanel />)
    await screen.findByText("Zeta")
    const titles = () => screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)

    expect(titles()).toEqual(["Zeta", "Alpha"])
    fireEvent.change(screen.getByLabelText("Sort groups"), { target: { value: "name" } })
    expect(titles()).toEqual(["Alpha", "Zeta"])

    expect(screen.getByText(/9 members: Person 1, Person 2, .*Person 6 \+3 more/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Show all" }))
    expect(screen.getByText(/Person 9/)).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText("Search groups or members"), { target: { value: "rashid" } })
    expect(titles()).toEqual(["Zeta"])
    fireEvent.change(screen.getByLabelText("Search groups or members"), { target: { value: "nobody" } })
    expect(screen.getByText("No groups or members match “nobody”.")).toBeInTheDocument()
  })

  test("members' own scores sort by error", async () => {
    const members = [
      { client_id: "c1", client_name: "Ann", start_time: "2026-10-01T00:00:00Z", cv_mae_valence: 1.2, cv_mae_arousal: 0.9 },
      { client_id: "c2", client_name: "Ben", start_time: "2026-10-02T00:00:00Z", cv_mae_valence: 2.4, cv_mae_arousal: 0.5 },
    ]
    api.getMlGroups.mockResolvedValue(ok({ groups: [
      { ...GROUP, current_model: { ...MODEL, members }, members },
    ], models_available: true }))
    render(<MlGroupsPanel />)
    fireEvent.click(await screen.findByRole("button", { name: "Show model details" }))
    const order = () => screen.getAllByRole("row").map((r) => r.textContent).filter((t) => /^(Ann|Ben)/.test(t)).map((t) => t.slice(0, 3))

    expect(order()).toEqual(["Ann", "Ben"])
    fireEvent.click(screen.getByRole("button", { name: /^Valence error/ }))
    fireEvent.click(screen.getByRole("button", { name: /^Valence error/ }))
    expect(order()).toEqual(["Ben", "Ann"])
  })
})

