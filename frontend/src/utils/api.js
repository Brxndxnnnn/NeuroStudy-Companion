// src/utils/api.js

const BASE_URL = "/api"

// TOKEN CACHING (in memory)
let accessToken = null;

// Helper to set token in memory + localStorage
export function setAuthToken(token) {
  accessToken = token;
  if (token) {
    localStorage.setItem("token", token);
  } else {
    localStorage.removeItem("token");
  }
}

// Load token from localStorage on module initialization
if (typeof window !== "undefined") {
  const stored = localStorage.getItem("token");
  if (stored) accessToken = stored;
}


// CORE fetchWithAuth (with network error handling and token refresh)
export async function fetchWithAuth(url, options = {}) {
  // Use cached token if available, otherwise read from localStorage
  let token = accessToken || localStorage.getItem("token");

  const headers = {
    "Content-Type": "application/json",
    ...options.headers,
  };

  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
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
  if (response.status !== 401) {
    return response;
  }

  // 3. We have a 401 – try to refresh the token
  try {
    const refreshRes = await fetch(`${BASE_URL}/auth/refresh`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
    });

    if (refreshRes.ok) {
      const data = await refreshRes.json();
      const newToken = data.accessToken;
      // Update both memory and localStorage
      setAuthToken(newToken);
      token = newToken;

      // Update headers and retry original request
      headers["Authorization"] = `Bearer ${token}`;
      return await fetch(url, { ...options, headers });
    } else {
      throw new Error("Refresh token expired or invalid");
    }
  } catch (error) {
    // 4. Refresh failed – user is truly unauthenticated
    setAuthToken(null); // clears both
    localStorage.removeItem("userRole");
    window.location.href = "/login";
    return Promise.reject(error);
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
  localStorage.removeItem("userRole");
  window.location.href = "/login";
}

export async function getCurrentUser() {
  const res = await fetchWithAuth(`${BASE_URL}/auth/me`);
  return res;
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
export async function getQuestionnaireQuestions(questionnaireId, language = "en") {
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
export async function getSessions() {
  const res = await fetchWithAuth(`${BASE_URL}/sessions`);
  return res;
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
export async function startSession(sessionId) {
  const res = await fetchWithAuth(`${BASE_URL}/sessions/${sessionId}/start`, {
    method: "PATCH",
  });
  return res;
}
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




// ML PHASE 1 (Insights tab)
// The ML service sits behind nginx at /ml/ (not /api), so this bypasses BASE_URL.
// Returns a readiness snapshot: whether a valence/arousal model is trained yet and
// how much OASIS-labelled EEG has accumulated toward training one.
export async function getPhase1Status() {
  const res = await fetchWithAuth(`/ml/phase1/status`);
  return res;
}
// Current trained model + version history (metrics for the model card).
export async function getPhase1Model() {
  const res = await fetchWithAuth(`/ml/phase1/model`);
  return res;
}
// Completed sessions + their prediction status (session picker).
export async function getPhase1Sessions() {
  const res = await fetchWithAuth(`/ml/phase1/sessions`);
  return res;
}
// One session's predicted valence/arousal trajectory.
// A session can hold predictions from both the population model and its client's
// personal model; the response carries ONE model's rows (personal by default) plus
// `available_models` for the switch. Pass modelVersion to pick the other.
export async function getPhase1Predictions(sessionId, modelVersion) {
  const q = modelVersion != null ? `?model_version=${modelVersion}` : "";
  const res = await fetchWithAuth(`/ml/phase1/predictions/${sessionId}${q}`);
  return res;
}
// One client's completed sessions + their personal model, for the training picker.
export async function getPhase1ClientSessions(clientId) {
  const res = await fetchWithAuth(`/ml/phase1/clients/${clientId}/sessions`);
  return res;
}
// Train a model. Goes through the BACKEND (not /ml/) because training writes —
// ml_service has no auth of its own, so /api/ml/train is the authenticated door.
export async function trainPhase1Model({ clientId, sessionIds } = {}) {
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
export async function hideEvent(eventId) {
  const res = await fetchWithAuth(`${BASE_URL}/events/${eventId}/hide`, {
    method: "PATCH",
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
