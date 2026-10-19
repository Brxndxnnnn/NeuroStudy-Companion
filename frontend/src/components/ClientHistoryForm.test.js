import { describe, it, expect } from "vitest";
import { emptyHistory, historyFromApi, historyToPayload } from "./ClientHistoryForm";

describe("client history form mapping", () => {
  it("omits unanswered complaints and symptoms so the backend names them", () => {
    const h = emptyHistory();
    h.complaints.pain = { severity: "little_affected", comment: "knee" };
    h.symptoms.motivation = { rating: "6", notes: "" };
    const body = historyToPayload(h);
    expect(body.complaints).toEqual([{ complaint: "pain", severity: "little_affected", comment: "knee" }]);
    expect(body.symptoms).toEqual([{ symptom: "motivation", rating: 6, notes: "" }]);
  });

  it("round-trips an API history into form state and back", () => {
    const api = {
      intake_date: "2026-10-13T00:00:00.000Z",
      medical_history: "m", cognitive_behavioural_profile: "c", language_communication: "l",
      social_observations: "s", treatment_goals: "t", school_education: "e", occupation: "-", hobbies: "h",
      complaints: [{ complaint: "headache", severity: "not_affected", comment: null }],
      symptoms: [{ symptom: "social_skills", rating: 4, notes: "shy" }],
    };
    const form = historyFromApi(api);
    expect(form.intake_date).toBe("2026-10-13");
    expect(form.symptoms.social_skills).toEqual({ rating: "4", notes: "shy" });
    const body = historyToPayload(form);
    expect(body.complaints[0]).toEqual({ complaint: "headache", severity: "not_affected", comment: "" });
    expect(body.symptoms[0].rating).toBe(4);
  });
});
