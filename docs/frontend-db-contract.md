# Frontend ↔ DB Contract — Sessions, Events & Image Sync

Audience: the web frontend dev (Zhao Yu) + backend (Eugene).
Purpose: exactly what the frontend must write to the DB so that (a) the C# bridge
and the web start the session in a coordinated, reliable way, and (b) EEG data
can be attributed to the image that was on screen, via timestamps.

> You never touch the DB directly — everything goes through Eugene's backend API.
> The tables below are the *shape of the data* your API calls ultimately produce,
> so you know what each endpoint must put where.

---

## 1. The tables you (indirectly) write

### `sessions` — one row per recording, created by the bridge
The **bridge** creates this row (`sync_status='unclaimed'`) the moment the headset
connects. You never INSERT it — you only UPDATE it through endpoints.

Relevant columns:

| column                | who writes it        | meaning                                            |
|-----------------------|----------------------|----------------------------------------------------|
| `session_id` (uuid)   | bridge               | PK; you get it from the pairing/claim response      |
| `pairing_code` (text) | bridge               | 6-char code the technician reads off the bridge     |
| `device_id` (text)    | bridge               | headset MAC                                         |
| `sync_status` (text)  | **shared lifecycle** | `unclaimed → claimed → recording → completed`        |
| `client_id`           | frontend (on claim)  | which client is being assessed                      |
| `conducted_by`        | frontend (on claim)  | technician user_id (from JWT)                        |
| `clinic_id`           | frontend (on claim)  | from JWT                                            |
| `paired_at`           | frontend (on claim)  | when pairing happened                               |
| `start_time`          | **frontend**         | experiment window start (first image era)           |
| `end_time`            | **frontend**         | experiment window end                               |
| `bridge_recording_at` | **bridge** (new)     | bridge's confirmation that EEG is flowing — see §3  |

### `images` — the stimulus catalogue (must exist BEFORE events reference them)
`(image_id uuid PK, filename, category, valence_score, arousal_score)`.
`events.image_id` is a FK to this table, so **every image you can show must already
have a row here.** Decide with the team who seeds it (likely a one-time import of
the stimulus set). You reference images by their `image_id`.

### `events` — THE marker timeline (this is the heart of image↔data sync)
`(event_id uuid PK, session_id, image_id, shown_at timestamptz, hidden_at timestamptz, clinic_id)`

You write **one event per image presentation**:
- Image appears on screen → create the event with `shown_at`.
- Image hidden / next image → set `hidden_at` on that event.

`events` has Row-Level Security keyed on `clinic_id`, so the event's `clinic_id`
must match the session's clinic (the backend sets this from your JWT — just be aware
it's required).

---

## 2. EEG/data tables you READ at results time (you never write these)

The bridge writes three streams, all carrying `session_id` + `time` (timestamptz on
the DB clock):

- `eeg_raw_samples` — full 250 Hz raw ADC counts `(session_id, time, fp1, fp2, t3, t4)`.
- `eeg_readings`   — ~2/s summarised per-channel last/peak-to-peak.
- `band_powers`    — ~1/s: `attention, relaxation, mental_workload, signal_quality`,
  plus per-channel α/β/δ/θ/γ (fp1/fp2/t3/t4 × 5).

You attribute these to an image by joining on time (see §4). `eeg_readings` and
`band_powers` also have a `current_image_id` cache column the backend *may* backfill
post-session — but the `events` join is the source of truth.

---

## 3. Coordinated start — the request/confirm handshake

Goal: the web and the bridge start together reliably, without anyone timing a button.
**The web must not show the first image until the bridge confirms it is recording.**

```
unclaimed ──(frontend claims via pairing code)──► claimed
claimed   ──(frontend POST /sessions/:id/start)──► recording   ← your "Start" command
recording ──(bridge poll sees it → starts EEG)───► bridge sets bridge_recording_at   ← confirmation
recording ──(frontend POST /sessions/:id/end)────► completed   ← bridge auto-stops
```

Frontend sequence:
1. Technician enters pairing code → `PATCH /api/sessions/pair` → status `claimed`.
2. Technician clicks **Start** → `POST /api/sessions/:id/start`
   (backend: `sync_status='recording'`, `start_time=now()`).
3. **Poll** `GET /api/sessions/:id` until `bridge_recording_at` is non-null
   (bridge has confirmed EEG is flowing — usually ~1 s).
   - If still null after ~5 s → show an error ("headset not recording, check the
     bridge PC"); do **not** start showing images.
4. Only now begin the stimulus protocol (start writing `events`).
5. Technician clicks **End** → `POST /api/sessions/:id/end`
   (backend: `sync_status='completed'`, `end_time=now()`). The bridge detects this
   and stops/flushes itself.

The bridge polls the session row (~1 s while claimed/recording) and reacts — you
never call the bridge directly. The technician still has a manual Start/Stop on the
bridge GUI as a fallback if the DB is unreachable.

---

## 4. Clock sync — the make-or-break detail (READ THIS)

`events.shown_at` (your machine) and the EEG `time` (bridge machine) must live on the
**same clock**, or every per-image window is skewed. The bridge already anchors to DB
`now()`. You must too. Pick one:

- **Server-stamped (simplest, recommended):** when you POST an image-shown event, let
  the backend stamp `shown_at = now()` at the DB. One network hop of skew (tens of ms),
  absorbed by the edge-trim below.
- **Client-stamped at paint:** fetch a one-time offset to server time, then stamp
  `shown_at` at *actual paint* (`onLoad` / `requestAnimationFrame`), not when the
  request was sent.

**Do NOT** write `shown_at` from a raw unsynced `Date.now()` — that silently skews the
join. In analysis we trim the first ~300–500 ms after `shown_at` (neural latency +
residual skew), so small offsets are fine; an un-synced clock is not.

---

## 5. How data attributes to an image (the read-time join)

This is *why* your timestamps matter. Per-image aggregates come from a time-range join:

```sql
SELECT e.image_id,
       avg(b.attention)  AS avg_attention,
       avg(b.relaxation) AS avg_relaxation
FROM events e
JOIN band_powers b
  ON b.session_id = e.session_id
 AND b.time >= e.shown_at + interval '300 ms'   -- trim neural latency / skew
 AND b.time <  e.hidden_at
WHERE e.session_id = $1
GROUP BY e.image_id;
```

Same pattern works against `eeg_raw_samples` / `eeg_readings`. If `shown_at`/`hidden_at`
are accurate and on the DB clock, attribution is exact.

---

## 6. Endpoints Eugene needs to add for this

| endpoint                         | effect                                                |
|----------------------------------|-------------------------------------------------------|
| `POST /api/sessions/:id/start`   | `claimed → recording`, set `start_time=now()`         |
| `POST /api/sessions/:id/end`     | `→ completed`, set `end_time=now()`                   |
| `POST /api/sessions/:id/events`  | INSERT event `(image_id, shown_at)`; set clinic_id    |
| `PATCH /api/sessions/:id/events/:eventId` | set `hidden_at`                              |
| `GET  /api/sessions/:id`         | include `sync_status` + `bridge_recording_at`         |
| `GET  /api/sessions/:id/results` | run the §5 join, return per-image aggregates          |

Plus schema: `ALTER TABLE sessions ADD COLUMN bridge_recording_at timestamptz;`
and (optional but recommended) a CHECK constraint pinning `sync_status` to the
`unclaimed/claimed/recording/completed` vocabulary.
