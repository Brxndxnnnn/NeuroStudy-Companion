"""
scripts/phase1_cli.py

Operator CLI for ML Phase 1 — the manual counterpart to the background workers.

    python -m scripts.phase1_cli --train             # fit + register a model now
    python -m scripts.phase1_cli --predict-once       # run one inference tick now
    python -m scripts.phase1_cli --predict-backfill   # requeue ALL sessions, then tick

Training is otherwise on a weekly cron; inference otherwise polls automatically.
This is here for bring-up and for forcing a retrain / recompute on demand.
"""

import argparse
import sys

# The reports print unicode glyphs; Windows' cp1252 console cannot encode them.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

from app.database import engine
from app.phase1 import train
from app.workers import prediction_jobs


def main() -> int:
    ap = argparse.ArgumentParser(description="ML Phase 1 operator CLI.")
    ap.add_argument("--train", action="store_true",
                    help="Fit + register a model on all labelled data, make it current.")
    ap.add_argument("--predict-once", action="store_true",
                    help="Run one inference tick over completed sessions lacking predictions.")
    ap.add_argument("--predict-backfill", action="store_true",
                    help="Requeue EVERY completed session for inference, then run ticks.")
    args = ap.parse_args()

    if not (args.train or args.predict_once or args.predict_backfill):
        ap.print_help()
        return 0

    if args.train:
        with engine.begin() as conn:
            summary = train.train_and_save(conn)
        if summary:
            print(f"Trained model v{summary['model_version']} ({summary['algo']}) on "
                  f"{summary['n_epochs']} epochs / {summary['n_distinct_images']} images.")
            print(f"  CV R²  valence {summary['cv']['r2']['valence']}  "
                  f"arousal {summary['cv']['r2']['arousal']}")
        else:
            print("Training skipped — not enough data (need >= 2 distinct images).")

    if args.predict_backfill:
        with engine.begin() as conn:
            n = prediction_jobs.requeue(conn)
        print(f"Requeued {n} completed session(s) for inference.")

    if args.predict_once or args.predict_backfill:
        # Drain a few ticks so a backfill of many sessions actually completes.
        total = 0
        for _ in range(50):
            done = prediction_jobs.tick()
            total += done
            if done == 0:
                break
        print(f"Inference processed {total} session(s).")

    return 0


if __name__ == "__main__":
    sys.exit(main())
