# Bridge Packaging & Auto-Update — Plan

**Status (19 Jul):** bridge side IMPLEMENTED on `feature/bridge-velopack` — config
store + DPAPI, activation client/dialog (vs mock), Velopack + `pack.ps1`, local-feed
delta test passing. See §8: items 5–9 remain gated on Eugene/infra. Supersedes the
parked zip approach on local branch `feature/bridge-packaging` (its clinic README +
"no real .env ships" guard were salvaged into `packaging/`).

**Goal:** ship the C# WPF bridge to clinic machines as a real installer, and have
it **auto-update**: on launch, if a newer version exists, prompt the user to update.

---

## 1. Locked decisions (18 Jul)

| Decision | Choice | Notes |
|---|---|---|
| Tooling | **Velopack** | Open-source (MIT), free incl. auto-update + delta updates. Successor to Squirrel.Windows, same author. Supports .NET Framework 4.8. Does installer **and** update in one tool. |
| Update feed host | **Static HTTPS path on droplet nginx** | e.g. `https://<domain>/bridge-updates/`. One nginx `location` block; rides along with the SSL/domain work. |
| Code signing | **Unsigned for now** | Drop-in later: Velopack signs installer + update packages natively once we have an Authenticode cert. May change within days. |
| Provisioning (19 Jul) | **First-run activation code** | No manual `.env` at clinics. First run → bridge shows an activation dialog → `POST /bridge/activate` → backend validates the code and returns clinic identity + DB creds + license key → bridge persists them locally. **Eugene builds the backend side** (endpoint + tables + code issuance). Industry-standard enrollment pattern; supersedes "installer seeds a template `.env`". |
| Secret storage (19 Jul) | **DPAPI, machine scope** | Secret values (DB password, license key) stored DPAPI-encrypted (`ProtectedData`, `DataProtectionScope.LocalMachine`) in the stable config, not plaintext. |

**Architecture rule, restated:** the bridge never touches the backend during session
flow; the **single exception is one-time enrollment** (activation). After activation
the bridge is exactly as today — direct DB writes, no backend dependency, works with
the backend unreachable.

**On signing (clarified):** SSL/TLS (domain cert) and Authenticode (code-signing cert)
are different products for different purposes. The domain SSL cert **cannot** sign the
exe, and nothing else in our stack suppresses the SmartScreen "unknown publisher"
warning. Unsigned = staff click "More info → Run anyway" **once at install**, not per
launch. Removing it requires an Authenticode cert (~$100–400/yr or Azure Trusted
Signing) — a later, additive step, no rework.

---

## 2. How Velopack works (mechanics)

1. **Build** the app in Release (net48/x64) as today.
2. **`vpk pack`** (Velopack CLI) takes the build output and produces a release set:
   a `Setup.exe` installer, a full package, and — on later versions — **delta**
   packages (only the changed bytes, so updates aren't a fresh 21 MB `SenzeBandCore.dll`
   download every time).
3. **Publish** those files to the nginx feed folder (`vpk` can upload, or we copy).
4. **In-app**: on startup the bridge calls Velopack's `UpdateManager` against the feed
   URL. If a newer release exists → prompt the user → download in background → apply on
   next restart. ~10 lines of C#, wrapped so a feed being unreachable never blocks
   normal use (offline clinic still runs).

Install location: Velopack installs per-user under `%LocalAppData%`, into a
**versioned** folder with a `current` pointer it swaps on update. **This is the key
design consequence — see §3.**

---

## 3. Config survival across updates (important design point)

Because Velopack swaps the whole app folder on each update, **config must NOT live
in the app directory** — an update would wipe it and the clinic would lose its license
key + DB credentials every time.

**Plan:** a stable, update-surviving config store that **activation writes** (no human
edits a file at the clinic):
- Location: `%ProgramData%\NeuuroBridge\` (machine-wide), created at first run.
- Secret values (DB password, license key) DPAPI-encrypted, machine scope; non-secrets
  (host, port, db name, clinic id) plain.
- `EnvConfig` reads the stable store **first**, then falls back to the existing `.env`
  walk (cwd/exe-dir and upward) — dev workflow unchanged, repo `.env` still wins on a
  dev box with no activated store.
- The config is created by the **activation flow (§4)**, not by the installer and not
  by hand. A "reset activation" affordance clears it (machine replaced / creds rotated).

## 4. First-run activation (enrollment)

Flow, on every launch: config store present → normal startup. Absent → activation
dialog (small WPF window):

1. User enters the activation code (issued by us/admin per clinic).
2. Bridge → `POST https://clinics.axonview.sg/api/clinics/activate` — the **only**
   backend call the bridge ever makes (shape = Eugene's endpoint, 19 Jul, plus our
   audit extras which the server may ignore):
   ```json
   { "activation_code": "2CFE-9BC1-A844-A5B3",
     "machine_name": "CLINIC-PC-01", "bridge_version": "1.0.0" }
   ```
3. Backend validates (exists, not used, not expired, not revoked), marks it used,
   responds (⚠ = missing from Eugene's current shape, requested 19 Jul):
   ```json
   { "status": "success",
     "data": {
       "activation_id": "b3d11201-…",
       "clinic_id": "a0000000-…",
       "clinic_name": "…",                      ⚠ nice-to-have (shown in the dialog)
       "database": { "host": "clinics.axonview.sg", "port": 5432, "name": "neurostudy",
                     "username": "clinic_…", "password": "…", "ssl_mode": "VerifyFull" },
       "license_key": "…"                       ⚠ REQUIRED — SenzeBand auth needs it
     } }
   ```
   Errors: 404 unknown / 409 already used / 410 expired-or-revoked (to be confirmed
   with Eugene) — dialog shows a plain-language message and lets the user retry.
   ⚠ The endpoint must be callable **without** a Bearer token: the code IS the
   credential (the bridge has nothing else pre-activation). Rate-limit it instead.
4. Bridge writes the DPAPI-protected config store, then continues to normal startup.

**Backend side (Eugene owns):** endpoint + `activation_codes` table
(`code` (or hash), `clinic_id`, `created_at`, `expires_at`, `used_at`, `revoked_at`,
`machine_name`, `created_by`) + clinic→DB-user mapping + a way to issue codes.
Codes single-use, expiring, revocable. Per-clinic DB users so revocation is per-clinic.

**Bridge side (ours):** dialog, HTTP client, config store read/write. Buildable now
against a mock endpoint (or the dev backend) — the contract above is the interface.

## 5. SSL cutover touchpoint (bundle with Eugene's work)

Separate from packaging but needed for the bridge to actually **function** at a clinic:
`EnvConfig.BuildConnectionString()` emits no `Ssl Mode`. When Eugene exposes Postgres
over SSL, add a `POSTGRES_SSLMODE` key (default `Require` in prod) so the connection
string can request TLS. Small change, do it as part of the cutover.

---

## 6. What we need from Eugene / infra

1. **DB reachability over SSL** — the existing blocker. Prod Postgres is loopback-only;
   a clinic can't reach it. Needs Rashid's domain → Eugene exposes Postgres w/ an SSL
   cert. (Bridge side: add `POSTGRES_SSLMODE`.)
2. ~~A static HTTPS path for the update feed~~ — **DONE BY US (19 Jul):** the droplet
   nginx is ours (`nginx/nginx.conf`), so `/bridge-updates/` now serves
   `/var/bridge-updates` (host path outside the repo; mounted in `compose.prod.yaml`;
   uploaded via `packaging/publish.ps1`). Goes live on the next droplet deploy —
   nothing needed from Eugene.
3. **Activation backend (Eugene confirmed 19 Jul he's building this)** — the
   `/api/clinics/activate` endpoint, `activation_codes` + clinic→DB-user tables, and
   code issuance, per the contract in §4. Reachable over HTTPS from clinics (same
   domain work as 1–2).
4. **Per-clinic DB grants (found by live probe, 19 Jul):** Postgres is UP on
   `clinics.axonview.sg:5432` (VerifyFull works, creds valid ✅). Grants verified:
   sessions SELECT+INSERT ✅, all four EEG/band data tables INSERT ✅, clinics/roles/
   clients/users correctly locked ✅. **Missing: UPDATE on `sessions`** — the bridge
   stamps `bridge_recording_at` at recording start and flips `sync_status='completed'`
   at Stop. Ask: `GRANT UPDATE (bridge_recording_at, sync_status) ON sessions TO
   <clinic role>` (column-level; full-row UPDATE not needed). Also run migration 010
   (placeholder seed) on the clinics DB — the bridge no longer needs INSERT there.

---

## 7. Open decisions (not blocking the plan)

| Decision | Default | Alternative |
|---|---|---|
| Code signing | unsigned now | Authenticode cert when rollout nears |
| Feed layout | one channel (`stable`) | separate `beta`/`stable` channels |
| Update prompt UX | ask user, they choose when | silent auto-apply on next launch |
| Version source | csproj `<Version>` → passed to `vpk` | git tag |

Resolved 19 Jul: config location = `%ProgramData%\NeuuroBridge\` (machine-wide),
written by activation, secrets DPAPI-protected (§3–4).

---

## 8. Phasing — buildable NOW vs gated on Eugene/infra

**Buildable now (no external dependency; all testable locally):**

1. **Config store** — `EnvConfig` reads `%ProgramData%\NeuuroBridge\` first, DPAPI
   for secrets, dev `.env` fallback intact. (Do first: everything depends on it.)
2. **Activation client** — WPF dialog + HTTP call + config-store write, developed
   against a mock of the §4 contract (or the dev backend once Eugene's endpoint
   exists there). Includes `POSTGRES_SSLMODE` support in the connection string.
3. **Velopack integration** — SDK, `VelopackApp` startup hook, csproj `<Version>`,
   build/pack script, local-feed v1→v2 update test.
4. Salvage clinic README + no-secrets packaging guard from parked
   `feature/bridge-packaging` (a32611a).

End state of 1–3: a real installer that installs → prompts for activation (mock) →
stores DPAPI config → runs → auto-updates from a local folder feed. Demo-able.

**Gated (in dependency order):**

5. **Activation backend** — Eugene (§6.3). Once on dev: swap mock for real endpoint,
   end-to-end activation test locally.
6. **Feed hosting** — nginx path from Eugene (§6.2); publish flow to droplet.
7. **SSL cutover** — Rashid's domain + Eugene exposing Postgres (§6.1); until then an
   installed bridge at a clinic has no reachable DB, activation or not.
8. **Signing** — when a cert exists.
9. **On-device test** — full install → activate → session → update loop, real hardware.
