"""
scripts/feature_jobs_cli.py

Manual control over the feature worker. The worker normally runs by itself inside
the ML service (app/main.py lifespan) — this is for backfills and for looking at
what it is doing.

    python -m scripts.feature_jobs_cli --status        # what state is everything in
    python -m scripts.feature_jobs_cli --once          # run one poll cycle now
    python -m scripts.feature_jobs_cli --backfill      # requeue EVERY completed session
    python -m scripts.feature_jobs_cli --requeue <id>  # requeue one session

--backfill is the one that matters right now: as of 15 Jul only ONE session
(1087fe73…) has elliptic rows, and it was computed with a 1s window rather than the
agreed 2s. Requeueing everything recomputes the lot. It is safe to re-run because
the compute function is required to be idempotent — it deletes a session's rows
before writing them.
"""

import argparse
import sys

from sqlalchemy import text

from app.database import engine
from app.workers import feature_jobs


def show_status() -> None:
    with engine.connect() as conn:
        rows = conn.execute(text("""
            SELECT COALESCE(features_status, 'not computed') AS status,
                   count(*) AS sessions
            FROM   sessions
            WHERE  sync_status = 'completed'
            GROUP  BY 1
            ORDER  BY 1
        """)).all()

        print("Completed sessions by feature status:")
        if not rows:
            print("  (no completed sessions)")
        for status, n in rows:
            print(f"  {status:<14} {n}")

        failed = conn.execute(text("""
            SELECT session_id, features_error
            FROM   sessions
            WHERE  features_status = 'failed'
            ORDER  BY features_started_at DESC NULLS LAST
            LIMIT  10
        """)).all()
        if failed:
            print("\nFailures:")
            for sid, err in failed:
                print(f"  {sid}  {err}")


def main() -> int:
    ap = argparse.ArgumentParser(description="Feature worker control.")
    ap.add_argument("--status", action="store_true")
    ap.add_argument("--once", action="store_true", help="Run one poll cycle now.")
    ap.add_argument("--backfill", action="store_true",
                    help="Requeue EVERY completed session, including ones already computed.")
    ap.add_argument("--requeue", action="append", dest="session_ids", metavar="SESSION_ID")
    args = ap.parse_args()

    if not any([args.status, args.once, args.backfill, args.session_ids]):
        ap.print_help()
        return 1

    if args.backfill or args.session_ids:
        with engine.begin() as conn:
            n = feature_jobs.requeue(conn, args.session_ids)
        target = "session(s)" if args.session_ids else "completed session(s) (full backfill)"
        print(f"Requeued {n} {target}. The worker will pick them up on its next tick.")

    if args.once:
        fn = feature_jobs.load_compute_fn()
        if fn is None:
            print("No compute function — see the warning above. Nothing to run.")
            return 1
        done = feature_jobs.tick(compute_fn=fn)
        print(f"Processed {done} session(s).")

    if args.status:
        show_status()

    return 0


if __name__ == "__main__":
    sys.exit(main())
