import { describe, expect, test } from "vitest"
import { matchesSearch, timeAgo } from "./listTools"

describe("matchesSearch", () => {
  test("ignores case, accents and surrounding spaces", () => {
    expect(matchesSearch("Zoë Tan", " zoe ")).toBe(true)
    expect(matchesSearch("Brandon Chu", "CHU")).toBe(true)
    expect(matchesSearch("Brandon Chu", "tom")).toBe(false)
    expect(matchesSearch(null, "")).toBe(true)
  })
})

describe("timeAgo", () => {
  const now = new Date("2026-10-26T12:00:00Z").getTime()
  test("reads in the largest whole unit", () => {
    expect(timeAgo("2026-10-26T11:59:40Z", now)).toBe("just now")
    expect(timeAgo("2026-10-26T11:59:00Z", now)).toBe("1 minute ago")
    expect(timeAgo("2026-10-26T10:00:00Z", now)).toBe("2 hours ago")
    expect(timeAgo("2026-10-21T12:00:00Z", now)).toBe("5 days ago")
    expect(timeAgo(null, now)).toBe("")
  })
})
