"""
scripts/phase1_cli.py

Operator CLI for ML Phase 1 — the manual counterpart to the background workers.

    python -m scripts.phase1_cli --train --group <group_id>   # fit one group's model now
    python -m scripts.phase1_cli --predict-once       # run one inference tick now
    python -m scripts.phase1_cli --predict-backfill   # requeue ALL sessions, then tick

Training is otherwise started per group from the Insights tab; inference otherwise
polls automatically. This is here for bring-up and for forcing a retrain /
recompute on demand.
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
                    help="Fit + register one group's model on each member's latest "
                         "labelled session, make it the group's current one. Requires --group.")
    ap.add_argument("--group", metavar="GROUP_ID",
                    help="The group whose model --train fits.")
    ap.add_argument("--predict-once", action="store_true",
                    help="Run one inference tick over completed sessions lacking predictions.")
    ap.add_argument("--predict-backfill", action="store_true",
                    help="Requeue EVERY completed session for inference, then run ticks.")
    args = ap.parse_args()

    if not (args.train or args.predict_once or args.predict_backfill):
        ap.print_help()
        return 0

    if args.train and not args.group:
        ap.error("--train requires --group <group_id>: every model belongs to one group.")

    if args.train:
        with engine.begin() as conn:
            summary = train.train_group_and_save(conn, args.group)
        for m in summary.get("skipped", []):
            print(f"  left out: {m['client_name']} ({m['reason']})")
        if summary.get("trained"):
            print(f"Trained group model v{summary['model_version']} ({summary['algo']}) on "
                  f"{summary['n_clients']} people / {summary['n_epochs']} epochs / "
                  f"{summary['n_distinct_images']} images — now the group's current model.")
            for label, key in (("with BFI", "cv"), ("without BFI", "cv_no_bfi"), ("predict-the-mean", "null")):
                r2 = summary[key]["r2"]
                print(f"  CV R² {label:<17} valence {r2['valence']:+.3f}  arousal {r2['arousal']:+.3f}")
        else:
            print("Training skipped — " + summary["message"])

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
