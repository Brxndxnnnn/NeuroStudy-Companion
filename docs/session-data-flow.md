# Session Data Flow — NeuroStudy Companion

> **Design decision:** the **bridge owns the session row**. The bridge is
> **write-only** — it generates the IDs, streams EEG, and stops on command. It
> never reads from the DB, never waits, never polls.

Legend: 🟦 = DB **write**, 🟩 = DB **read**.

---

## Actors

- **Technician** — runs the session in the clinic.
- **Bridge** — C# Windows app (Brandon). **Write-only.** Generates IDs, streams
  EEG, stops on command. Writes EEG **directly** to the DB.
- **Frontend** — React app (Zhao Yu). No direct DB access; everything goes
  through the backend.
- **Backend** — Express API (Eugene). The only path between frontend and DB.
- **DB** — TimescaleDB (`sessions`, `events`, `eeg_readings`, `band_powers`, ...).

---

## Phase 0 — Technician prepares (frontend)

1. Technician logs into the frontend.
   - 🟩 `POST /api/auth/login` → JWT.
2. Technician selects the client to be assessed.
   - 🟩 `GET /api/clients`.

*No session exists yet. Bridge not involved.*

---

## Phase 1 — Bridge startup (creates the session, starts streaming)

3. Technician starts the C# bridge.
4. Bridge: SDK init → BLE scan → connect → authenticate → wait for good signal.
5. Bridge **anchors its clock to DB time** once (`SELECT now()` → store offset;
   apply to every EEG timestamp so its samples live on the same clock as the
   frontend's events).
6. Bridge generates `session_id` + 6-char `pairing_code`.
7. Bridge **creates the session row** — *unclaimed*:
   - 🟦 `INSERT INTO sessions (session_id, device_id, pairing_code, sample_rate,
     sync_status='unclaimed')`.
   - `client_id`, `conducted_by`, `start_time` left **NULL** (requires the
     migration tweak — see bottom).
8. Bridge **starts streaming immediately** — no waiting for pairing:
   - 🟦 `eeg_readings` — batched ~2/s (buffer ~500 ms, multi-row INSERT).
     `current_image_id` NULL.
   - 🟦 `band_powers` — ~1/s on each `EegProcessor.OnBandPowers` fire.
9. Bridge prints the pairing code on the console.

```
Technician ─starts─> Bridge ─BLE─> SenzeBand
                       ├─ anchor clock to DB now()
                       ├─ generate session_id + pairing_code
                       ├─ 🟦 INSERT sessions (status='unclaimed')
                       └─ 🟦 stream eeg_readings + band_powers ──► DB   (fire-and-forget)
```

*Pre-pairing EEG is harmless — it falls outside every event window and is
ignored at read time (or serves as baseline).*

---

## Phase 2 — Frontend claims the session

10. Technician reads the pairing code off the console, types it into the frontend.
11. Frontend claims the unclaimed session for this client + technician:
    - 🟦 `POST /api/sessions/claim { pairing_code, client_id }`
    - Backend finds the session by `pairing_code`, fills `client_id`,
      `conducted_by` (from JWT), `start_time = now()`, `sync_status='recording'`.
    - **Eugene's TS2.6.**
12. **The bridge is never told.** It is already streaming. Claiming only attaches
    metadata to the row it is already writing into.

```
Technician ─types code─> Frontend ─🟦 POST /sessions/claim─> Backend ─🟦 UPDATE sessions(client_id, conducted_by, status='recording')─> DB

Bridge: keeps streaming, oblivious.   ← no read, no poll
```

---

## Phase 3 — Session runs (parallel, decoupled writers)

13. Frontend runs the stimulus protocol (image 5–10 s, blank 3 s). On each
    transition it logs a marker:
    - Image appears → 🟦 `POST /api/sessions/:id/events { image_id, shown_at }`
      (frontend stamps `shown_at` at actual paint time).
    - Image hides → 🟦 backend sets `hidden_at`. → row in **`events`**.
14. Bridge continues its two write streams unchanged.

Three independent writers, none blocking the others:

```
        ┌─ Bridge ──🟦 eeg_readings   (~2/s, batched)
DB ◄────┼─ Bridge ──🟦 band_powers    (~1/s)
        └─ Frontend ─🟦 events         (per image on/off)   ← markers
```

*Optional:* technician live signal-quality indicator → frontend 🟩 polls
`band_powers.signal_quality` (nice-to-have, ties to TS1.3; not required).

---

## Phase 4 — Session ends

15. Technician ends the session on the frontend.
    - 🟦 `PATCH /api/sessions/:id { end_time: now(), sync_status='complete' }`.
16. Technician stops the bridge **locally** (console command / closes app /
    removes band).
    - Bridge flushes its final batch → 🟦 last `eeg_readings`/`band_powers` rows →
      sends BLE stop → exits.
    - **No coordination with the DB needed** — the human ends both sides.
17. *(Optional, backend)* Backfill job replays `events` onto the EEG tables to
    populate `current_image_id`, so per-image queries skip the time-range join.

---

## Phase 5 — Results populate (frontend pulls)

18. Frontend opens the results screen:
    - 🟩 `GET /api/sessions/:id/results`.
    - Backend runs the **events ↔ band_powers join**, returns per-image
      aggregates (e.g. *happy → avg attention 0.62, relaxation 0.41*).
    - **Eugene TS2.7–2.9** + **Zhao Yu results view** (not built yet).
19. Frontend renders per-image charts. **Done.**

```
Frontend ─🟩 GET /sessions/:id/results─> Backend ─🟩 JOIN events × band_powers─> DB
   ▲                                                                            │
   └──────────────── per-image aggregates ◄─────────────────────────────────────┘
```

---

## One-glance timeline

| #  | Actor    | Action                                      | DB op                                   |
|----|----------|---------------------------------------------|-----------------------------------------|
| 1  | Frontend | Login, pick client                          | 🟩 auth, clients                        |
| 2  | Bridge   | Start, BLE connect, anchor clock, gen IDs   | —                                       |
| 3  | Bridge   | Create session row (unclaimed)              | 🟦 `sessions` (status=unclaimed)        |
| 4  | Bridge   | **Start streaming immediately**             | 🟦 `eeg_readings`, `band_powers`        |
| 5  | Frontend | Technician enters pairing code → claim      | 🟦 `sessions` (client, technician, recording) |
| 6  | Frontend | Log each image shown/hidden                 | 🟦 `events`                             |
| 7  | Frontend | End session                                 | 🟦 `sessions` (end_time, complete)      |
| 8  | Bridge   | Technician stops it locally; flush          | 🟦 final batch                          |
| 9  | Backend  | (opt) backfill image ids                    | 🟦 `current_image_id`                   |
| 10 | Frontend | Pull results                                | 🟩 `GET /sessions/:id/results`          |

**Bridge column = all 🟦 writes. Zero 🟩 reads.** That is the whole point — the
bridge component stays dead simple.

---

## The clock-sync detail (make-or-break)

The frontend's `shown_at` and the bridge's EEG `time` come from **different
machines**. If their clocks disagree, every per-image window is misaligned.

1. **Single clock reference** — bridge anchors to DB time once at startup
   (`SELECT now()` → offset → apply to all EEG timestamps). Everyone ends up on
   the DB timeline.
2. **`shown_at` = actual render**, not request time — frontend stamps it at
   paint (`onLoad` / `requestAnimationFrame`), not when the API call was sent.
3. **Trim the edges** — drop the first ~300–500 ms after `shown_at` in analysis
   (neural response latency + absorbs residual skew). Cheap with 5–10 s windows.

---

## The one schema change this requires

For the bridge to create an unclaimed session, these columns must be nullable
until the frontend claims it:

```sql
ALTER TABLE sessions ALTER COLUMN client_id    DROP NOT NULL;
ALTER TABLE sessions ALTER COLUMN conducted_by DROP NOT NULL;
```

An "unclaimed" session legitimately has no client/technician yet — that is what
`sync_status='unclaimed'` represents. They get filled the moment the frontend
claims it. This is **Eugene's** table, so it is a contract point to raise with
him, not a unilateral change.

> **Implementation note (current).** Until that migration is agreed, the bridge
> does **not** depend on the columns being nullable. It satisfies the existing
> `NOT NULL` constraints with two **placeholder rows** it upserts idempotently:
> a placeholder client (`11111111-…`, *"⟨Unclaimed⟩ — pending pairing"*) and a
> system user (`22222222-…`, *"Neuuro Bridge (system)"*, non-login). The session
> references these until the frontend's claim **overwrites** `client_id` /
> `conducted_by` with the real values. So claiming works identically whether or
> not the nullable migration lands — the migration just lets us drop the
> placeholder rows later. See `neuuro_bridge/NeuuroBridge/DbUploader.cs`.

---

## Open contract points for the team

1. **Migration:** make `sessions.client_id` and `conducted_by` nullable (above).
2. **Claim endpoint** (`POST /api/sessions/claim`) — Eugene (TS2.6).
3. **Events endpoint** (`POST /api/sessions/:id/events`) — Eugene + Zhao Yu;
   frontend owns stimulus timing, bridge never touches image state.
4. **Results endpoint** (`GET /api/sessions/:id/results`) — Eugene (TS2.7–2.9).
5. **Results view** — Zhao Yu (TS3).
