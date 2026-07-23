import { beforeEach, describe, expect, test, vi } from "vitest"

async function freshApi() {
  vi.resetModules()
  return import("./api.js")
}

beforeEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("setAuthToken", () => {
  test("stores the token in module memory", async () => {
    const api = await freshApi()
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      ok: true
    })

    vi.stubGlobal("fetch", fetchMock)

    api.setAuthToken("tok-123")
    await api.fetchWithAuth("/api/whatever")

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][1].headers.Authorization)
      .toBe("Bearer tok-123")
  })

  test("clears the token from module memory when set to null", async () => {
    const api = await freshApi()
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      ok: true
    })

    vi.stubGlobal("fetch", fetchMock)

    api.setAuthToken("tok-123")
    api.setAuthToken(null)

    await api.fetchWithAuth("/api/whatever")

    expect(fetchMock.mock.calls[0][1].headers.Authorization)
      .toBeUndefined()
  })

  test("does not persist the token across fresh module loads", async () => {
    const firstApi = await freshApi()

    firstApi.setAuthToken("tok-123")

    const secondApi = await freshApi()
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      ok: true
    })

    vi.stubGlobal("fetch", fetchMock)

    await secondApi.fetchWithAuth("/api/whatever")

    expect(fetchMock.mock.calls[0][1].headers.Authorization)
      .toBeUndefined()
  })
})

describe("fetchWithAuth", () => {
  test("attaches the in-memory Bearer token when present", async () => {
    const api = await freshApi()
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      ok: true
    })

    vi.stubGlobal("fetch", fetchMock)
    api.setAuthToken("memory-token")

    await api.fetchWithAuth("/api/whatever")

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/whatever",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer memory-token",
          "Content-Type": "application/json"
        })
      })
    )
  })

  test("does not attach Authorization when no token is present", async () => {
    const api = await freshApi()
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      ok: true
    })

    vi.stubGlobal("fetch", fetchMock)

    await api.fetchWithAuth("/api/whatever")

    expect(fetchMock.mock.calls[0][1].headers.Authorization)
      .toBeUndefined()
  })

  test("preserves caller-supplied headers", async () => {
    const api = await freshApi()
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      ok: true
    })

    vi.stubGlobal("fetch", fetchMock)

    await api.fetchWithAuth("/api/whatever", {
      headers: {
        "X-Test-Header": "test-value"
      }
    })

    expect(fetchMock.mock.calls[0][1].headers)
      .toEqual(expect.objectContaining({
        "Content-Type": "application/json",
        "X-Test-Header": "test-value"
      }))
  })

  test("returns the original response when status is not 401", async () => {
    const api = await freshApi()
    const response = {
      status: 403,
      ok: false
    }

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(response)
    )

    await expect(
      api.fetchWithAuth("/api/whatever")
    ).resolves.toBe(response)
  })

  test("rethrows network errors without attempting refresh", async () => {
    const api = await freshApi()
    const networkError = new TypeError("Failed to fetch")
    const fetchMock = vi.fn().mockRejectedValue(networkError)
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => { })

    vi.stubGlobal("fetch", fetchMock)

    await expect(
      api.fetchWithAuth("/api/whatever")
    ).rejects.toBe(networkError)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(consoleError).toHaveBeenCalled()
  })

  test("on 401 refreshes the token and retries the request", async () => {
    const api = await freshApi()
    const retriedResponse = {
      status: 200,
      ok: true
    }

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        status: 401,
        ok: false
      })
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        json: vi.fn().mockResolvedValue({
          accessToken: "new-token"
        })
      })
      .mockResolvedValueOnce(retriedResponse)

    vi.stubGlobal("fetch", fetchMock)
    api.setAuthToken("expired-token")

    const response = await api.fetchWithAuth("/api/whatever", {
      method: "GET"
    })

    expect(response).toBe(retriedResponse)
    expect(fetchMock).toHaveBeenCalledTimes(3)

    expect(fetchMock.mock.calls[1]).toEqual([
      "/api/auth/refresh",
      {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json"
        }
      }
    ])

    expect(fetchMock.mock.calls[2][1])
      .toEqual(expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer new-token"
        })
      }))
  })

  test("stores the refreshed token for later requests", async () => {
    const api = await freshApi()

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        status: 401,
        ok: false
      })
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        json: vi.fn().mockResolvedValue({
          accessToken: "new-token"
        })
      })
      .mockResolvedValueOnce({
        status: 200,
        ok: true
      })
      .mockResolvedValueOnce({
        status: 200,
        ok: true
      })

    vi.stubGlobal("fetch", fetchMock)

    await api.fetchWithAuth("/api/first")
    await api.fetchWithAuth("/api/second")

    expect(fetchMock.mock.calls[3][1].headers.Authorization)
      .toBe("Bearer new-token")
  })

  test("on failed refresh clears the in-memory token and rejects", async () => {
    const api = await freshApi()

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        status: 401,
        ok: false
      })
      .mockResolvedValueOnce({
        status: 401,
        ok: false
      })
      .mockResolvedValueOnce({
        status: 200,
        ok: true
      })

    vi.stubGlobal("fetch", fetchMock)
    api.setAuthToken("expired-token")

    await expect(
      api.fetchWithAuth("/api/whatever")
    ).rejects.toThrow("Refresh token expired or invalid")

    await api.fetchWithAuth("/api/after-failure")

    expect(fetchMock.mock.calls[2][1].headers.Authorization)
      .toBeUndefined()
  })

  test("on refresh network failure clears the token and rejects", async () => {
    const api = await freshApi()
    const refreshError = new TypeError("Refresh network failure")

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        status: 401,
        ok: false
      })
      .mockRejectedValueOnce(refreshError)
      .mockResolvedValueOnce({
        status: 200,
        ok: true
      })

    vi.stubGlobal("fetch", fetchMock)
    api.setAuthToken("expired-token")

    await expect(
      api.fetchWithAuth("/api/whatever")
    ).rejects.toBe(refreshError)

    await api.fetchWithAuth("/api/after-failure")

    expect(fetchMock.mock.calls[2][1].headers.Authorization)
      .toBeUndefined()
  })

  test("concurrent 401 responses share one refresh request", async () => {
    const api = await freshApi();

    let resolveRefresh;

    const pendingRefresh = new Promise(resolve => {
      resolveRefresh = resolve;
    });

    const retriedResponseA = {
      status: 200,
      ok: true,
      request: "a",
    };

    const retriedResponseB = {
      status: 200,
      ok: true,
      request: "b",
    };

    const fetchMock = vi.fn((url, options = {}) => {
      if (url === "/api/auth/refresh")
        return pendingRefresh;

      if (options.headers?.Authorization === "Bearer new-token")
        return Promise.resolve(
          url === "/api/a"
            ? retriedResponseA
            : retriedResponseB
        );

      return Promise.resolve({
        status: 401,
        ok: false,
      });
    });

    vi.stubGlobal("fetch", fetchMock);
    api.setAuthToken("expired-token");

    const requestA = api.fetchWithAuth("/api/a");
    const requestB = api.fetchWithAuth("/api/b");

    await vi.waitFor(() => {
      const refreshCalls = fetchMock.mock.calls.filter(
        ([url]) => url === "/api/auth/refresh"
      );

      expect(refreshCalls).toHaveLength(1);
    });

    resolveRefresh({
      status: 200,
      ok: true,
      json: vi.fn().mockResolvedValue({
        accessToken: "new-token",
      }),
    });

    await expect(
      Promise.all([requestA, requestB])
    ).resolves.toEqual([
      retriedResponseA,
      retriedResponseB,
    ]);

    const refreshCalls = fetchMock.mock.calls.filter(
      ([url]) => url === "/api/auth/refresh"
    );

    expect(refreshCalls).toHaveLength(1);

    const retryCalls = fetchMock.mock.calls.filter(
      ([url, options]) =>
        url !== "/api/auth/refresh" &&
        options.headers?.Authorization === "Bearer new-token"
    );

    expect(retryCalls).toHaveLength(2);
  })

  test("a delayed 401 reuses a token refreshed by another request", async () => {
    const api = await freshApi();

    let resolveDelayedRequest;

    const delayedResponse = new Promise(resolve => {
      resolveDelayedRequest = resolve;
    });

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        status: 401,
        ok: false,
      })
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        json: vi.fn().mockResolvedValue({
          accessToken: "new-token",
        }),
      })
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
      })
      .mockImplementationOnce(() => delayedResponse)
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
      });

    vi.stubGlobal("fetch", fetchMock);
    api.setAuthToken("expired-token");

    await api.fetchWithAuth("/api/first");

    // Simulate a request that was sent with the expired token but whose
    // 401 response arrived after another request completed the refresh.
    api.setAuthToken("expired-token");
    const delayed = api.fetchWithAuth("/api/delayed");

    api.setAuthToken("newer-token");

    resolveDelayedRequest({
      status: 401,
      ok: false,
    });

    await delayed;

    const refreshCalls = fetchMock.mock.calls.filter(
      ([url]) => url === "/api/auth/refresh"
    );

    expect(refreshCalls).toHaveLength(1);
    expect(fetchMock.mock.calls[4][1].headers.Authorization)
      .toBe("Bearer newer-token");
  })
})

describe("login", () => {
  test("posts credentials to /api/auth/login", async () => {
    const api = await freshApi()
    const response = {
      status: 200,
      ok: true
    }
    const fetchMock = vi.fn().mockResolvedValue(response)

    vi.stubGlobal("fetch", fetchMock)

    const result = await api.login("a@b.com", "hunter2")

    expect(result).toBe(response)
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/login",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          email: "a@b.com",
          password: "hunter2",
          override: true
        })
      }
    )
  })

  test("passes a custom override value", async () => {
    const api = await freshApi()
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      ok: true
    })

    vi.stubGlobal("fetch", fetchMock)

    await api.login("a@b.com", "hunter2", false)

    expect(fetchMock.mock.calls[0][1].body)
      .toBe(JSON.stringify({
        email: "a@b.com",
        password: "hunter2",
        override: false
      }))
  })
})

describe("logout", () => {
  test("calls the logout endpoint and clears the in-memory token", async () => {
    const api = await freshApi()

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        status: 200,
        ok: true
      })
      .mockResolvedValueOnce({
        status: 200,
        ok: true
      })

    vi.stubGlobal("fetch", fetchMock)
    api.setAuthToken("active-token")

    await api.logout()
    await api.fetchWithAuth("/api/after-logout")

    expect(fetchMock.mock.calls[0]).toEqual([
      "/api/auth/logout",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer active-token"
        })
      })
    ])

    expect(fetchMock.mock.calls[1][1].headers.Authorization)
      .toBeUndefined()
  })

  test("still clears the token when the logout request fails", async () => {
    const api = await freshApi()
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => { })

    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("Network failure"))
      .mockResolvedValueOnce({
        status: 200,
        ok: true
      })

    vi.stubGlobal("fetch", fetchMock)
    api.setAuthToken("active-token")

    await expect(api.logout()).resolves.toBeUndefined()
    await api.fetchWithAuth("/api/after-logout")

    expect(fetchMock.mock.calls[1][1].headers.Authorization)
      .toBeUndefined()

    consoleError.mockRestore()
  })
})

describe("getCurrentUser", () => {
  test("requests /api/auth/me through fetchWithAuth", async () => {
    const api = await freshApi()
    const response = {
      status: 200,
      ok: true
    }
    const fetchMock = vi.fn().mockResolvedValue(response)

    vi.stubGlobal("fetch", fetchMock)
    api.setAuthToken("active-token")

    const result = await api.getCurrentUser()

    expect(result).toBe(response)
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/me",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer active-token"
        })
      })
    )
  })
})