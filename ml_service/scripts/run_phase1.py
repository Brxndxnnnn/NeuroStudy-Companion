"""
scripts/run_phase1.py

End-to-end ML Phase 1 run against whatever is currently in the DB.

    python -m scripts.run_phase1                    # all completed sessions
    python -m scripts.run_phase1 --session <uuid>   # just one
    python -m scripts.run_phase1 --show-leakage     # also run the leaky split

⚠ Until the real OASIS images are uploaded and load_oasis_labels.py has run, the
images in the DB carry NULL valence/arousal, so this will extract zero epochs and
say so. That is the expected outcome today — the pipeline is built and testable
ahead of the data, and the synthetic tests in app/tests/test_phase1_harness.py
prove the CV harness works without needing any of it.
"""

import argparse
import sys

# The reports print unicode warning glyphs (⚠, ²). Windows' default console
# encoding is cp1252, which cannot encode them and raises UnicodeEncodeError
# mid-report. Force UTF-8 on the output streams so the script runs the same on
# Brandon's Windows box as on the Linux droplet.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

from app.database import engine
from app.phase1 import evaluate
from app.phase1.config import DEFAULT
from app.phase1.dataset import build_dataset


def main() -> int:
    ap = argparse.ArgumentParser(description="Run ML Phase 1.")
    ap.add_argument("--session", action="append", dest="sessions",
                    help="Session UUID (repeatable). Default: all completed.")
    ap.add_argument("--show-leakage", action="store_true",
                    help="Also run the random split, to show the size of the "
                         "illusion it would have produced.")
    ap.add_argument("--folds", type=int, default=5)
    args = ap.parse_args()

    with engine.connect() as conn:
        X, y, groups, sessions, _ = build_dataset(conn, args.sessions, DEFAULT)

    if X.shape[0] == 0:
        print("\nNo labelled epochs.")
        print("Most likely: the images in the DB carry no OASIS labels yet.")
        print("  1. Eugene uploads the OASIS images WITH images.oasis_theme set")
        print("  2. python -m scripts.load_oasis_labels --check")
        print("  3. python -m scripts.load_oasis_labels")
        return 1

    n_images = len(set(groups))
    if n_images < 2:
        print(f"\nOnly {n_images} distinct image(s) — nothing to generalise to.")
        return 1

    print("\n" + "=" * 72)
    print("GROUPED BY IMAGE — the only numbers fit to report")
    print("=" * 72)
    for res in evaluate.evaluate_all(X, y, groups, sessions, n_splits=args.folds):
        print(res.report())
        if not res.beats_null():
            print("    ⚠ does not beat predict-the-mean — no usable signal here")

    if args.show_leakage:
        honest, leaky = evaluate.demonstrate_leakage(X, y, groups, sessions)
        print("\n" + "=" * 72)
        print("WHY THE GROUPING MATTERS — same model, same data, two splits")
        print("=" * 72)
        print(honest.report())
        print(leaky.report())
        gap = {t: leaky.r2[t] - honest.r2[t] for t in evaluate.TARGETS}
        print(f"\n  Inflation from a random split: "
              f"valence {gap['valence']:+.3f} R², arousal {gap['arousal']:+.3f} R².")
        print("  That gap is pure memorisation of near-duplicate epochs — the score "
              "a random split would have let us publish.")

    return 0


if __name__ == "__main__":
    sys.exit(main())
