import { describe, test, expect, beforeEach, vi } from "vitest";

// api.js caches the token in module-level memory AND reads localStorage at
// import time, so each test gets a fully fresh module instance (isolated
// in-memory state) via vi.resetModules() + dynamic import, same as a real
// page load would see whatever's in localStorage at that moment.
async function freshApi() {
  vi.resetModules();
  return await import("./api.js");
}

function mockLocation() {
  delete window.location;
  window.location = { href: "" };
}

beforeEach(() => {
  localStorage.clear();
  mockLocation();
  vi.restoreAllMocks();
});

describe("setAuthToken", () => {
  test("stores the token in localStorage", async () => {
    const api = await freshApi();
    api.setAuthToken("tok-123");
    expect(localStorage.getItem("token")).toBe("tok-123");
  });

  test("removes the token from localStorage when set to null", async () => {
    const api = await freshApi();
    localStorage.setItem("token", "old-tok");
    api.setAuthToken(null);
    expect(localStorage.getItem("token")).toBeNull();
  });
});

describe("fetchWithAuth", () => {
  test("attaches the Bearer token from localStorage when present", async () => {
    localStorage.setItem("token", "stored-tok");
    const api = await freshApi();
    const fetchMock = vi.fn().mockResolvedValue({ status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    await api.fetchWithAuth("/api/whatever");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, options] = fetchMock.mock.calls[0];
    expect(options.headers.Authorization).toBe("Bearer stored-tok");
  });

  test("returns the response as-is when status is not 401", async () => {
    const api = await freshApi();
    const okResponse = { status: 200, ok: true };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse));

    const res = await api.fetchWithAuth("/api/whatever");
    expect(res).toBe(okResponse);
  });

  test("on 401, refreshes the token and retries the original request", async () => {
    localStorage.setItem("token", "expired-tok");
    const api = await freshApi();
    const retriedResponse = { status: 200, ok: true };

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ status: 401 }) // original request
      .mockResolvedValueOnce({ ok: true, json: async () => ({ accessToken: "new-tok" }) }) // refresh
      .mockResolvedValueOnce(retriedResponse); // retried original request
    vi.stubGlobal("fetch", fetchMock);

    const res = await api.fetchWithAuth("/api/whatever");

    expect(res).toBe(retriedResponse);
    expect(localStorage.getItem("token")).toBe("new-tok");
    // Retried request must carry the NEW token, not the expired one.
    const retriedCallOptions = fetchMock.mock.calls[2][1];
    expect(retriedCallOptions.headers.Authorization).toBe("Bearer new-tok");
  });

  test("on 401 with a failed refresh, clears auth and redirects to /login", async () => {
    localStorage.setItem("token", "expired-tok");
    localStorage.setItem("userRole", "technician");
    const api = await freshApi();

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ status: 401 }) // original request
      .mockResolvedValueOnce({ ok: false }); // refresh fails
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.fetchWithAuth("/api/whatever")).rejects.toThrow();

    expect(localStorage.getItem("token")).toBeNull();
    expect(localStorage.getItem("userRole")).toBeNull();
    expect(window.location.href).toBe("/login");
  });
});

describe("login", () => {
  test("posts credentials to /api/auth/login", async () => {
    const api = await freshApi();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    await api.login("a@b.com", "hunter2");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/login",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ email: "a@b.com", password: "hunter2", override: true }),
      })
    );
  });
});
