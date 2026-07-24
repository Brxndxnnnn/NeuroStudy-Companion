"""Dev mock of the backend activation endpoint (docs/ARCHITECTURE.md §7).

Mirrors the real /api/clinics/activate (path, envelope, error contract) so the bridge's
first-run activation flow can be exercised offline. Returns the local dev-compose
Postgres credentials, so an "activated" bridge on a dev box writes to the same DB
as always.

    python neuuro_bridge/tools/mock_activation_server.py  # listens on :8765

Point the bridge at it via .env or env var:
    ACTIVATION_URL=http://localhost:8765/api/clinics/activate

Codes (server requires XXXX-XXXX-XXXX-XXXX, else 400):
  TEST-C0DE-0001-MOCK -> 200,  USED-C0DE-0000-MOCK -> 409,
  EXP1-RED0-0000-MOCK -> 410,  any other well-formed code -> 404.
"""
import json
import os
import re
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = 8765


def _dev_license_key() -> str:
    """Real key from the repo .env if present, so dev activation is fully functional."""
    here = os.path.dirname(os.path.abspath(__file__))
    for d in [here] + [os.path.abspath(os.path.join(here, *[".."] * n)) for n in range(1, 5)]:
        path = os.path.join(d, ".env")
        if os.path.isfile(path):
            with open(path, encoding="utf-8") as f:
                for line in f:
                    m = re.match(r"\s*NEUURO_LICENSE_KEY\s*=\s*(.+)\s*$", line)
                    if m:
                        return m.group(1).strip().strip("'\"")
    return "TEST-LICENSE-KEY"


class Handler(BaseHTTPRequestHandler):
    CODE_PATTERN = re.compile(r"^[A-Z0-9]{4}(?:-[A-Z0-9]{4}){3}$")  # same as the backend

    def do_POST(self):
        if self.path != "/api/clinics/activate":
            return self._send(404, {"detail": "not found"})
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0)) or 0) or b"{}")
        code = (body.get("activation_code") or "").strip().upper()
        print(f"activation attempt: code={code!r} machine={body.get('machine_name')!r} "
              f"bridge_version={body.get('bridge_version')!r}")

        if not self.CODE_PATTERN.match(code):
            return self._send(400, {"status": "error", "detail": "invalid activation code format"})
        if code == "USED-C0DE-0000-MOCK":
            return self._send(409, {"status": "error", "detail": "code already used"})
        if code == "EXP1-RED0-0000-MOCK":
            return self._send(410, {"status": "error", "detail": "code expired or revoked"})
        if code != "TEST-C0DE-0001-MOCK":
            return self._send(404, {"status": "error", "detail": "unknown code"})

        # Envelope mirrors Eugene's endpoint (incl. clinic_name + license_key, added 19 Jul).
        return self._send(200, {
            "status": "success",
            "data": {
                "activation_id": "b3d11201-6420-4ccb-a839-mock00000000",
                "clinic_id": "a0000000-0000-0000-0000-000000000001",
                "clinic_name": "Dev Clinic (mock)",
                "database": {
                    "host": "localhost",
                    "port": 5433,
                    "name": "neurostudy",
                    "username": "neurostudy_user",
                    "password": "neurostudy_pass",
                    "ssl_mode": "Disable",  # dev compose Postgres has no TLS; prod sends VerifyFull
                },
                "license_key": _dev_license_key(),
            },
        })

    def _send(self, status: int, payload: dict):
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *_):  # quiet the default per-request noise; we print our own line
        pass


if __name__ == "__main__":
    print(f"mock activation server on http://localhost:{PORT}/api/activate "
          f"(valid code: TEST-C0DE-0001-MOCK)")
    HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
