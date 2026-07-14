"""
scripts/load_oasis_labels.py

Populate images.valence_score / arousal_score / valence_sd / arousal_sd from the
OASIS norms, joining on images.oasis_theme.

    python -m scripts.load_oasis_labels --check     # report only, touch nothing
    python -m scripts.load_oasis_labels --dry-run   # show what would change
    python -m scripts.load_oasis_labels             # write

WHY THIS EXISTS
---------------
The OASIS ratings live in a CSV; the EEG lives in the DB. The only thing joining
them is the image's OASIS Theme ("Acorns 1", "Snake 5"). An image uploaded
without its theme recorded in images.oasis_theme is PERMANENTLY unusable for
training: we already tried to recover the mapping for the 24 placeholder rows by
perceptually matching them against the 900 originals and could not (best cosine
0.3-0.7, where a true re-encoded match scores ~0.99).

So --check is the acceptance test for the image upload. Run it the moment the
OASIS images land: it will name every image that cannot be labelled, while the
upload is still fresh enough to fix.

The CSV (data/oasis/OASIS.csv) is the source of truth and is committed to the
repo, so training runs the same on any machine and does not depend on a file
sitting in someone's home directory.
"""

import argparse
import csv
import sys
from pathlib import Path

from sqlalchemy import text

from app.database import engine

# Repo-root-relative, so this works from a checkout on any machine.
DEFAULT_CSV = Path(__file__).resolve().parents[2] / "data" / "oasis" / "OASIS.csv"


def load_norms(csv_path: Path) -> dict:
    """
    Read OASIS.csv into {theme -> {valence_mean, valence_sd, arousal_mean, arousal_sd}}.

    Columns: "",Theme,Category,Source,Valence_mean,Valence_SD,Valence_N,
             Arousal_mean,Arousal_SD,Arousal_N
    Theme is the join key. Ratings are on OASIS's 1-7 scale.
    """
    if not csv_path.exists():
        raise SystemExit(f"OASIS CSV not found at {csv_path}")

    norms = {}
    with csv_path.open(newline="", encoding="utf-8-sig") as fh:
        for row in csv.DictReader(fh):
            theme = (row.get("Theme") or "").strip()
            if not theme:
                continue
            norms[theme] = {
                "valence_mean": float(row["Valence_mean"]),
                "valence_sd":   float(row["Valence_SD"]),
                "arousal_mean": float(row["Arousal_mean"]),
                "arousal_sd":   float(row["Arousal_SD"]),
            }
    return norms


def fetch_images(conn) -> list[dict]:
    rows = conn.execute(text("""
        SELECT image_id, filename, oasis_theme,
               valence_score, arousal_score, valence_sd, arousal_sd
        FROM   images
        ORDER  BY filename
    """)).mappings().all()
    return [dict(r) for r in rows]


def main() -> int:
    ap = argparse.ArgumentParser(description="Load OASIS norms into images.")
    ap.add_argument("--csv", type=Path, default=DEFAULT_CSV)
    ap.add_argument("--check", action="store_true",
                    help="Report label coverage and exit non-zero if any image "
                         "cannot be labelled. Use this to accept an image upload.")
    ap.add_argument("--dry-run", action="store_true",
                    help="Show what would be written, but write nothing.")
    args = ap.parse_args()

    norms = load_norms(args.csv)
    print(f"OASIS norms loaded: {len(norms)} themes from {args.csv}")

    with engine.begin() as conn:
        images = fetch_images(conn)
        if not images:
            print("images table is empty — nothing to do.")
            return 0

        no_theme = [i for i in images if not i["oasis_theme"]]
        unknown  = [i for i in images
                    if i["oasis_theme"] and i["oasis_theme"] not in norms]
        matched  = [i for i in images
                    if i["oasis_theme"] and i["oasis_theme"] in norms]

        print(f"images rows: {len(images)}")
        print(f"  matched to an OASIS theme : {len(matched)}")
        print(f"  no oasis_theme set        : {len(no_theme)}")
        print(f"  theme not found in CSV    : {len(unknown)}")

        if no_theme:
            print("\n  ⚠ UNLABELLABLE — no oasis_theme, cannot be joined to the norms.")
            print("    These images cannot be used for training. The theme must be "
                  "recorded at upload time; it cannot be recovered from the pixels.")
            for i in no_theme[:10]:
                print(f"      {i['filename']}")
            if len(no_theme) > 10:
                print(f"      … and {len(no_theme) - 10} more")

        if unknown:
            print("\n  ⚠ THEME NOT IN OASIS.csv — likely a typo or a renamed theme:")
            for i in unknown[:10]:
                print(f"      {i['filename']}  ->  {i['oasis_theme']!r}")
            if len(unknown) > 10:
                print(f"      … and {len(unknown) - 10} more")

        if args.check:
            ok = not no_theme and not unknown and bool(matched)
            print("\nRESULT:", "OK — every image is labellable." if ok
                  else "NOT READY — see the warnings above.")
            return 0 if ok else 1

        if not matched:
            print("\nNothing to write (no image carries a known oasis_theme).")
            return 1

        if args.dry_run:
            print("\n--dry-run: would write these (first 10):")
            for i in matched[:10]:
                n = norms[i["oasis_theme"]]
                print(f"  {i['oasis_theme']:<24} "
                      f"valence {n['valence_mean']:.2f} (sd {n['valence_sd']:.2f})  "
                      f"arousal {n['arousal_mean']:.2f} (sd {n['arousal_sd']:.2f})")
            print(f"\n{len(matched)} rows would be updated. Nothing written.")
            return 0

        # One statement per image, inside the single transaction engine.begin()
        # opened — either every label lands or none does. A half-labelled images
        # table would silently train on a mixture of real and missing labels.
        for i in matched:
            n = norms[i["oasis_theme"]]
            conn.execute(text("""
                UPDATE images
                SET    valence_score = :vm,
                       valence_sd    = :vsd,
                       arousal_score = :am,
                       arousal_sd    = :asd
                WHERE  image_id = :image_id
            """), {
                "vm":  n["valence_mean"],
                "vsd": n["valence_sd"],
                "am":  n["arousal_mean"],
                "asd": n["arousal_sd"],
                "image_id": i["image_id"],
            })

        print(f"\nWrote labels for {len(matched)} images.")
        if no_theme or unknown:
            print("⚠ Some images remain unlabelled — see the warnings above.")
        return 0


if __name__ == "__main__":
    sys.exit(main())
