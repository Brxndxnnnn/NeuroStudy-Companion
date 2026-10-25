import { beforeEach, describe, expect, test, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

const getSessionQuestionnaires = vi.fn()
const getSessionQuestionnairesPdf = vi.fn()
const toast = vi.hoisted(() => ({ loading: vi.fn(() => "t"), success: vi.fn(), error: vi.fn() }))

vi.mock("@/utils/api", () => ({
  getSessionQuestionnaires: (...a) => getSessionQuestionnaires(...a),
  getSessionQuestionnairesPdf: (...a) => getSessionQuestionnairesPdf(...a),
}))
vi.mock("react-hot-toast", () => ({ toast }))

import QuestionnaireResults from "./QuestionnaireResults"

const WHO5 = {
  questionnaire_id: "who5-id",
  code: "who5",
  name: "WHO-5 Well-being Index",
  scale_min: 0,
  scale_max: 5,
  options: [{ value: 3, label: { en: "More than half of the time", ms: "x" } }],
  answered_items: 2,
  expected_items: 5,
  scores: { total: { raw_score: 6, percentage_score: 24 }, domains: [], facets: [] },
  answers: [
    { question_id: "q1", question_no: 1, statement: { en: "I have felt cheerful" }, answer_value: 3, item_score: 3, is_reverse_scored: false },
    { question_id: "q2", question_no: 2, statement: { en: "I have felt calm" }, answer_value: 3, item_score: 3, is_reverse_scored: true },
  ],
}

const ok = (body) => ({ ok: true, status: 200, json: async () => body, blob: async () => new Blob(["%PDF-"]) })

beforeEach(() => {
  vi.clearAllMocks()
  global.URL.createObjectURL = vi.fn(() => "blob:x")
  global.URL.revokeObjectURL = vi.fn()
})

describe("QuestionnaireResults", () => {
  test("shows each question with its answer label once expanded", async () => {
    getSessionQuestionnaires.mockResolvedValue(ok([WHO5]))
    render(<QuestionnaireResults sessionId="s1" />)

    const toggle = await screen.findByRole("button", { name: "Show responses (2)" })
    expect(screen.queryByText("I have felt cheerful")).not.toBeInTheDocument()

    fireEvent.click(toggle)
    expect(screen.getByText("I have felt cheerful")).toBeInTheDocument()
    expect(screen.getAllByText("3 — More than half of the time")).toHaveLength(2)
    expect(screen.getByText("(R)")).toBeInTheDocument()
  })

  test("exports the PDF", async () => {
    getSessionQuestionnaires.mockResolvedValue(ok([WHO5]))
    getSessionQuestionnairesPdf.mockResolvedValue(ok(null))
    render(<QuestionnaireResults sessionId="s1" />)

    fireEvent.click(await screen.findByRole("button", { name: "Export as PDF" }))
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    expect(getSessionQuestionnairesPdf).toHaveBeenCalledWith("s1")
  })

  test("hides the export button when nothing has been answered", async () => {
    getSessionQuestionnaires.mockResolvedValue(ok([{ ...WHO5, answers: [], answered_items: 0, scores: null }]))
    render(<QuestionnaireResults sessionId="s1" />)

    await screen.findByText("WHO-5 Well-being Index")
    expect(screen.queryByRole("button", { name: "Export as PDF" })).not.toBeInTheDocument()
  })
})
