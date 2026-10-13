// src/utils/api.js

const BASE_URL = "/api"

// TOKEN CACHING (in memory)
let accessToken = null;
let refreshPromise = null;

// Helper to set the token for the current browser session only.
export function setAuthToken(token) {
  accessToken = token;
}

async function refreshAccessToken() {
  if (!refreshPromise) {
    refreshPromise = (async () => {
      const response = await fetch(`${BASE_URL}/auth/refresh`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      });

      if (!response.ok)
        throw new Error("Refresh token expired or invalid");

      const data = await response.json();

      if (!data.accessToken)
        throw new Error("Refresh response did not include an access token");

      setAuthToken(data.accessToken);
      return data.accessToken;
    })().finally(() => {
      refreshPromise = null;
    });
  }

  return refreshPromise;
}


// CORE fetchWithAuth (with network error handling and token refresh)
export async function fetchWithAuth(url, options = {}) {
  // Access tokens intentionally live only in memory. On a full reload, the
  // HttpOnly refresh cookie supplies a fresh one when needed.
  const requestToken = accessToken; // Capture the token at the time of the request

  const headers = {
    "Content-Type": "application/json",
    ...options.headers,
  };

  if (requestToken) {
    headers["Authorization"] = `Bearer ${requestToken}`;
  }

  let response;

  // 1. First try/catch for Network/CORS errors
  try {
    response = await fetch(url, { ...options, headers });
  } catch (error) {
    console.error("Network connection failed (CORS or Server Offline):", error);
    throw error; // Do NOT log out it's a network issue
  }

  // 2. If status is not 401, return response
  if (response.status !== 401)
    return response;

  // 3. We have a 401 – try to refresh the token
  try {
    // const refreshRes = await fetch(`${BASE_URL}/auth/refresh`, {
    //   method: "POST",
    //   credentials: "include",
    //   headers: { "Content-Type": "application/json" },
    // });

    // if (refreshRes.ok) {
    //   const data = await refreshRes.json();
    //   const newToken = data.accessToken;
    //   // Update the in-memory token before retrying the original request.
    //   setAuthToken(newToken);
    //   token = newToken;

    //   // Update headers and retry original request
    //   headers["Authorization"] = `Bearer ${token}`;
    //   return await fetch(url, { ...options, headers });
    // } else {
    //   throw new Error("Refresh token expired or invalid");
    // }
    let newToken = accessToken;
    if (!newToken || newToken === requestToken)
      newToken = await refreshAccessToken();

    const retryHeaders = {
      ...headers,
      "Authorization": `Bearer ${newToken}`,
    };

    return await fetch(url, { ...options, headers: retryHeaders });
  } catch (error) {
    // 4. Refresh failed – user is truly unauthenticated
    setAuthToken(null);
    throw error
  }
}

// AUTH FUNCTIONS (use setAuthToken on login/logout)
export async function login(email, password, override = true) {
  const res = await fetch(`${BASE_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, override }),
  });
  return res;
}

export async function logout() {
  try {
    await fetchWithAuth(`${BASE_URL}/auth/logout`, { method: "POST" });
  } catch (e) {
    // ignore network errors on logout
  }
  setAuthToken(null);
}

export async function getCurrentUser() {
  const res = await fetchWithAuth(`${BASE_URL}/auth/me`);
  return res;
}

export async function getServerTime() {
  return fetch(`${BASE_URL}/time`, { method: "GET", cache: "no-store" });
}

// IMAGES
export async function getImageCategories() {
  const res = await fetchWithAuth(`${BASE_URL}/images/categories`);
  return res;
}
export async function getImages(params = {}) {
  const query = new URLSearchParams(params);
  const suffix = query.toString() ? `?${query}` : "";
  const res = await fetchWithAuth(`${BASE_URL}/images${suffix}`);
  return res;
}
export async function getImage(imageId) {
  const res = await fetchWithAuth(`${BASE_URL}/images/${imageId}`);
  return res;
}




// QUESTIONS
export async function getQuestions() {
  const res = await fetchWithAuth(`${BASE_URL}/questions`);
  return res;
}
export async function getQuestion(questionId) {
  const res = await fetchWithAuth(`${BASE_URL}/questions/${questionId}`);
  return res;
}




// QUESTIONNAIRES
export async function getQuestionnaires() {
  const res = await fetchWithAuth(`${BASE_URL}/questionnaires`);
  return res;
}
export async function getQuestionnaire(questionnaireId) {
  const res = await fetchWithAuth(`${BASE_URL}/questionnaires/${questionnaireId}`);
  return res;
}
// Returns every language's statement text in one payload (the backend defaults to
// all languages when none is requested). Language selection is handled client-side,
// so this deliberately takes no language argument — requesting specific languages
// would change the response shape and break the per-language lookup in LikertSurvey.
export async function getQuestionnaireQuestions(questionnaireId) {
  const res = await fetchWithAuth(
    `${BASE_URL}/questionnaires/${questionnaireId}/questions`
  );
  return res;
}
export async function submitQuestionnaireAnswers(sessionId, questionnaireId, answers) {
  const res = await fetchWithAuth(`${BASE_URL}/questionnaires/answer`, {
    method: "POST",
    body: JSON.stringify({
      session_id: sessionId,
      questionnaire_id: questionnaireId,
      answers,
    }),
  });
  return res;
}




// SESSIONS
export async function getSessions(params = {}) {
  const query = new URLSearchParams(
    Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== "")
  );
  const suffix = query.toString() ? `?${query}` : "";
  const res = await fetchWithAuth(`${BASE_URL}/sessions${suffix}`);
  return res;
}
export async function deleteSession(sessionId) {
  return fetchWithAuth(`${BASE_URL}/sessions/${sessionId}`, { method: "DELETE" });
}
export async function getSession(sessionId) {
  const res = await fetchWithAuth(`${BASE_URL}/sessions/${sessionId}`);
  return res;
}
export async function pairSession(pairingCode, clientId) {
  const res = await fetchWithAuth(`${BASE_URL}/sessions/pair`, {
    method: "PATCH",
    body: JSON.stringify({ pairing_code: pairingCode, client_id: clientId }),
  });
  return res;
}
// No startSession(): the bridge owns the recording-start transition (writes
// sync_status='recording' itself). The website only observes it via getSession polling.
export async function endSession(sessionId) {
  const res = await fetchWithAuth(`${BASE_URL}/sessions/${sessionId}/end`, {
    method: "PATCH",
  });
  return res;
}
export async function getSessionResultsRaw(sessionId, startSeconds, endSeconds) {
  const res = await fetchWithAuth(
    `${BASE_URL}/sessions/${sessionId}/results/raw?start_seconds=${startSeconds}&end_seconds=${endSeconds}`
  );
  return res;
}
export async function getSessionResultsFiltered(sessionId, startSeconds, endSeconds) {
  const res = await fetchWithAuth(
    `${BASE_URL}/sessions/${sessionId}/results/filtered?start_seconds=${startSeconds}&end_seconds=${endSeconds}`
  );
  return res;
}
// Per-event summary: one row per stimulus event (image or question) with its
// shown/hidden window, the image URL / question prompt, and band-power averages
// over the window. Drives the event markers + click-to-view on the results page.
export async function getSessionResultEvents(sessionId) {
  const res = await fetchWithAuth(`${BASE_URL}/sessions/${sessionId}/results`);
  return res;
}
// Band powers, mental-state indices and vitals — one row/second, so the whole
// session is cheap to pull. Omit the bounds to get the full session.
// Elliptic-filter band statistics (ml_service).
//
// SHAPE — verified against the deployed table, which does NOT match the
// elliptic_band_stats definition currently in db/migrations/005 (that one has a
// `band` text column; production does not). One row per (window x CHANNEL), i.e.
// 4 rows per window, with the bands as columns:
//
//   { session_id, time_start, time_end, window_size_s, step_s, window_number,
//     channel: "fp1"|"fp2"|"t3"|"t4",
//     delta_mean, delta_std, delta_peak,
//     theta_mean, theta_std, theta_peak,
//     alpha_mean, alpha_std, alpha_peak,
//     beta_mean,  beta_std,  beta_peak,
//     gamma_mean, gamma_std, gamma_peak }                  <- µV
//
// Three things this endpoint does NOT do, which the caller must handle:
//   - no ORDER BY, so row order is whatever the hypertable scan returned: SORT.
//   - no t_seconds (every sibling results endpoint provides one), so the caller
//     derives it from sessions.start_time — the same origin the others use.
//   - no start/end bounds: it returns the whole session.
//
// ⚠ `*_mean` is NOT an amplitude. The signal is bandpassed before the statistic
// is taken, and a bandpassed signal is zero-mean by construction — measured on
// the one session that has data, |mean|/std is 0.03 for alpha, 0.01 for beta and
// gamma. The amplitude is `*_std` (RMS about zero). Plot SD or peak; a chart of
// `mean` is a flat line at zero.
//
// ⚠ These are µV AMPLITUDE statistics. band_powers holds FFT POWER in µV².
// Different quantities — never plot them on one axis.
export async function getSessionEllipticBandStats(sessionId) {
  const res = await fetchWithAuth(
    `${BASE_URL}/sessions/${sessionId}/results/elliptic_band_stats`
  );
  return res;
}

export async function getSessionResultsBandPower(sessionId, startSeconds, endSeconds) {
  const qs = new URLSearchParams();
  if (startSeconds != null) qs.set("start_seconds", startSeconds);
  if (endSeconds != null) qs.set("end_seconds", endSeconds);
  const suffix = qs.toString() ? `?${qs}` : "";
  const res = await fetchWithAuth(
    `${BASE_URL}/sessions/${sessionId}/results/bandpower${suffix}`
  );
  return res;
}

// Our OWN FFT-computed band powers — the source of the "Frequency bands" chart,
// replacing the SenseBand SDK's band_powers (the SDK band numbers are the ones the
// prof told us not to trust). The ml_service computes these from the filtered EEG
// after a session completes. Same WIDE shape as getSessionResultsBandPower
// (t_seconds + fp1_delta … t4_gamma), so the chart transform is unchanged — but
// WITHOUT the SDK's mental-state / vitals columns, which still come from bandpower.
// Returns { sample_length, samples: [...] }. Already downsampled: no start/end needed.
export async function getSessionResultsFftBandPower(sessionId) {
  const res = await fetchWithAuth(
    `${BASE_URL}/sessions/${sessionId}/results/fft_bandpower`
  );
  return res;
}

// Clinical PDF report (ITP2 requirement #6). Response body is a PDF binary, not JSON — the caller
// should check res.ok then read res.blob(), not res.json(), unlike every other function here.
export async function getSessionReportPdf(sessionId) {
  const res = await fetchWithAuth(`${BASE_URL}/sessions/${sessionId}/report.pdf`);
  return res;
}




// ML PHASE 1 (Insights tab)
// All ML calls go through the authenticated backend (/api/ml/...), which enforces
// the JWT and per-clinic row-level security before proxying to ml_service. The ML
// service is not publicly reachable.
// Returns a readiness snapshot: how much OASIS-labelled EEG has accumulated toward
// training valence/arousal models.
export async function getPhase1Status() {
  const res = await fetchWithAuth(`${BASE_URL}/ml/phase1/status`);
  return res;
}
// Completed sessions + their prediction status (session picker).
export async function getPhase1Sessions() {
  const res = await fetchWithAuth(`${BASE_URL}/ml/phase1/sessions`);
  return res;
}
// One session's predicted valence/arousal trajectory.
// A session can hold predictions from more than one version of its client's
// personal model; the response carries ONE version's rows (the newest by default)
// plus `available_models` for the switch. Pass modelVersion to pick another.
export async function getPhase1Predictions(sessionId, modelVersion) {
  const q = modelVersion != null ? `?model_version=${modelVersion}` : "";
  const res = await fetchWithAuth(`${BASE_URL}/ml/phase1/predictions/${sessionId}${q}`);
  return res;
}
// One client's completed sessions + their personal model, for the training picker.
export async function getPhase1ClientSessions(clientId) {
  const res = await fetchWithAuth(`${BASE_URL}/ml/phase1/clients/${clientId}/sessions`);
  return res;
}
// Train one client's personal model (clientId is required). Like every ML call it
// goes through the authenticated backend (/api/ml/train), which is the only path
// exposed to ml_service.
export async function trainPhase1Model({ clientId, sessionIds }) {
  const res = await fetchWithAuth(`${BASE_URL}/ml/train`, {
    method: "POST",
    body: JSON.stringify({ client_id: clientId, session_ids: sessionIds }),
  });
  return res;
}


// EVENTS
export async function createEvent(sessionId, payload) {
  const res = await fetchWithAuth(`${BASE_URL}/events`, {
    method: "POST",
    body: JSON.stringify({ session_id: sessionId, ...payload }),
  });
  return res;
}
export async function hideEvent(eventId, occurredAt) {
  const res = await fetchWithAuth(`${BASE_URL}/events/${eventId}/hide`, {
    method: "PATCH",
    body: JSON.stringify({ occurred_at: occurredAt }),
  });
  return res;
}



// CLIENTS
export async function getClients() {
  const res = await fetchWithAuth(`${BASE_URL}/clients`);
  return res;
}
export async function createClient(clientData) {
  const res = await fetchWithAuth(`${BASE_URL}/clients`, {
    method: "POST",
    body: JSON.stringify(clientData),
  });
  return res;
}
export async function getClient(clientId) {
  const res = await fetchWithAuth(`${BASE_URL}/clients/${clientId}`);
  return res;
}

// CLIENT HISTORIES (versioned intake questionnaire; one draft + one active per client).
// GET /active and /draft 404 when none exists. PUT /draft replaces the whole draft.
export async function getClientActiveHistory(clientId) {
  return fetchWithAuth(`${BASE_URL}/clients/${clientId}/histories/active`);
}
export async function getClientHistories(clientId) {
  return fetchWithAuth(`${BASE_URL}/clients/${clientId}/histories`);
}
export async function saveClientHistoryDraft(clientId, history) {
  return fetchWithAuth(`${BASE_URL}/clients/${clientId}/histories/draft`, {
    method: "PUT",
    body: JSON.stringify(history),
  });
}
export async function publishClientHistoryDraft(clientId) {
  return fetchWithAuth(`${BASE_URL}/clients/${clientId}/histories/draft/publish`, {
    method: "POST",
  });
}

// SESSION COMMENTARIES (technician's post-session notes for the PDF report; one draft + one
// active per session). GET /active and /draft 404 when none exists.
export async function getSessionActiveCommentary(sessionId) {
  return fetchWithAuth(`${BASE_URL}/sessions/${sessionId}/commentaries/active`);
}
export async function getSessionCommentaryDraft(sessionId) {
  return fetchWithAuth(`${BASE_URL}/sessions/${sessionId}/commentaries/draft`);
}
export async function saveSessionCommentaryDraft(sessionId, commentary) {
  return fetchWithAuth(`${BASE_URL}/sessions/${sessionId}/commentaries/draft`, {
    method: "PUT",
    body: JSON.stringify(commentary),
  });
}
export async function publishSessionCommentaryDraft(sessionId) {
  return fetchWithAuth(`${BASE_URL}/sessions/${sessionId}/commentaries/draft/publish`, {
    method: "POST",
  });
}



// USERS (admin only)
export async function getUsers() {
  const res = await fetchWithAuth(`${BASE_URL}/users`);
  return res;
}
export async function getRoles() {
  const res = await fetchWithAuth(`${BASE_URL}/users/roles`);
  return res;
}
export async function createUser(userData) {
  const res = await fetchWithAuth(`${BASE_URL}/users`, {
    method: "POST",
    body: JSON.stringify(userData),
  });
  return res;
}
export async function updateUser(userId, updates) {
  const res = await fetchWithAuth(`${BASE_URL}/users/${userId}`, {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
  return res;
}
export async function deleteUser(userId) {
  const res = await fetchWithAuth(`${BASE_URL}/users/${userId}`, {
    method: "DELETE",
  });
  return res;
}



// CLINICS
export async function getClinics() {
  const res = await fetchWithAuth(`${BASE_URL}/clinics`);
  return res;
}
export async function createClinic(clinicData) {
  const res = await fetchWithAuth(`${BASE_URL}/clinics`, {
    method: "POST",
    body: JSON.stringify(clinicData),
  });
  return res;
}
export async function getClinic(clinicId) {
  const res = await fetchWithAuth(`${BASE_URL}/clinics/${clinicId}`);
  return res;
}
export async function getImageDisplayInterval() {
  return fetchWithAuth(`${BASE_URL}/site-settings`);
}
export async function updateImageDisplayInterval(imageDisplayIntervalSeconds) {
  return fetchWithAuth(`${BASE_URL}/site-settings`, {
    method: "PUT",
    body: JSON.stringify({ image_display_interval_seconds: imageDisplayIntervalSeconds }),
  });
}
export async function getClinicsDatabaseAccessOverview() {
  return fetchWithAuth(`${BASE_URL}/clinics/database-access`);
}
export async function revokeClinicDatabaseAccess(activationId) {
  return fetchWithAuth(`${BASE_URL}/clinics/activation-codes/${activationId}/revoke`, {
    method: "PATCH",
  });
}
export async function grantClinicDatabaseAccess(clinicId) {
  return fetchWithAuth(`${BASE_URL}/clinics/${clinicId}/database-access`, {
    method: "POST",
    body: JSON.stringify({ clinic_id: clinicId }),
  });
}

// CLINIC STIMULUS SETS
// Technicians are automatically scoped to their own clinic by the API.
export async function getClinicStimulusSets() {
  return fetchWithAuth(`${BASE_URL}/clinics/stimulus-sets`);
}

export async function getClinicStimulusSet(stimulusSetId) {
  return fetchWithAuth(`${BASE_URL}/clinics/stimulus-sets/${stimulusSetId}`);
}

export async function updateClinicStimulusSet(stimulusSetId, stimulusSet) {
  return fetchWithAuth(`${BASE_URL}/clinics/stimulus-sets/${stimulusSetId}`, {
    method: "PUT",
    body: JSON.stringify(stimulusSet),
  });
}
