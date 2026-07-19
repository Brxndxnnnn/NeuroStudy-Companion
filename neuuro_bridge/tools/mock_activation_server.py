"""Dev mock of the backend activation endpoint (docs/bridge-packaging-plan.md §4).

Lets the bridge's first-run activation flow be exercised end-to-end before Eugene's
real /bridge/activate exists. Returns the local dev-compose Postgres credentials, so
an "activated" bridge on a dev box writes to the same DB as always.

    python neuuro_bridge/tools/mock_activation_server.py  # listens on :8765

Point the bridge at it via .env or env var:  ACTIVATION_URL=http://localhost:8765/bridge/activate

Codes: TEST-CODE-0001 -> 200, USED-CODE -> 409, EXPIRED-CODE -> 410, anything else -> 404.
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
    def do_POST(self):
        if self.path != "/bridge/activate":
            return self._send(404, {"detail": "not found"})
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0)) or 0) or b"{}")
        code = (body.get("code") or "").strip().upper()
        print(f"activation attempt: code={code!r} machine={body.get('machine_name')!r} "
              f"bridge_version={body.get('bridge_version')!r}")

        if code == "USED-CODE":
            return self._send(409, {"detail": "code already used"})
        if code == "EXPIRED-CODE":
            return self._send(410, {"detail": "code expired or revoked"})
        if code != "TEST-CODE-0001":
            return self._send(404, {"detail": "unknown code"})

        return self._send(200, {
            "clinic_id": 1,
            "clinic_name": "Dev Clinic (mock)",
            "postgres": {
                "host": "localhost",
                "port": 5433,
                "database": "neurostudy",
                "user": "neurostudy_user",
                "password": "neurostudy_pass",
                "sslmode": "disable",  # dev compose Postgres has no TLS
            },
            "license_key": _dev_license_key(),
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
    print(f"mock activation server on http://localhost:{PORT}/bridge/activate "
          f"(valid code: TEST-CODE-0001)")
    HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
