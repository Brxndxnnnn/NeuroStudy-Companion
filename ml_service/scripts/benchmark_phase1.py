"""
scripts/benchmark_phase1.py

Benchmark every registered Phase 1 algorithm the way it will actually be used: fitted
PER CLIENT, scored by image-grouped CV on that client's own data, then averaged
across clients. The algorithm with the best average is the one to make the default
(PHASE1_MODEL) — one algorithm for everyone, each client getting their own weights.

    python -m scripts.benchmark_phase1                     # every client with sessions
    python -m scripts.benchmark_phase1 --client <uuid>     # repeatable
    python -m scripts.benchmark_phase1 --folds 3
    python -m scripts.benchmark_phase1 --synthetic         # no DB: fake clients

READ-ONLY, like run_phase1.py: it SELECTs and cross-validates in memory. It writes no
artifact and no ml_models row, so it cannot change what any client is served. It
still READS whatever DB ml_service/.env points at — check the host it prints before
trusting that the numbers are from local data.

Fairness: every algorithm sees the same rows, the same per-session z-scoring and the
same folds (GroupKFold is deterministic for a given groups array). Hyperparameters
are fixed in phase1/models.py and are NOT tuned here — tuning on the folds you report
would make the winner's score optimistic.
"""

import argparse
import sys

# Same reason as run_phase1.py: Windows' cp1252 console cannot print ² or ⚠.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

import numpy as np

from app.phase1 import evaluate, models
from app.phase1.config import DEFAULT

T = evaluate.TARGETS


def _synthetic_clients(n_clients: int = 4, n_images: int = 24, epochs_per_image: int = 17):
    """
    Fake clients shaped like the real protocol (24 images, ~17 epochs each, a few
    sessions), each with a weak linear signal of their own. Only for checking the
    script end to end without a DB — the scores mean nothing about real EEG.
    """
    n_features = 50
    for c in range(n_clients):
        rng = np.random.default_rng(100 + c)
        w = rng.normal(size=(n_features, 2)) / np.sqrt(n_features)
        X, y, groups, sessions = [], [], [], []
        for i in range(n_images):
            image_signal = rng.normal(size=n_features)
            label = image_signal @ w * 1.5 + 5.0
            for _ in range(epochs_per_image):
                X.append(image_signal + rng.normal(scale=2.0, size=n_features))
                y.append(label)
                groups.append(f"img-{i}")
                sessions.append(f"c{c}-s{i % 3}")
        yield (f"synthetic-{c}",
               (np.array(X), np.array(y), np.array(groups), np.array(sessions)))


def _db_clients(client_ids: list[str] | None):
    from app.core.config import settings
    from app.data_access import queries
    from app.database import engine
    from app.phase1.dataset import build_dataset

    print(f"Reading from {settings.DB_HOST}:{settings.DB_PORT}/{settings.DB_NAME}"
          f"  (read-only)")
    with engine.connect() as conn:
        # Group the trainable sessions by owner using existing queries only. Same
        # 'completed' + timeline-version gate as fetch_client_session_ids, so each
        # client's list is exactly what train_and_save() would fit on.
        by_client: dict[str, list[str]] = {}
        for sid in queries.fetch_completed_session_ids(conn):
            s = queries.fetch_session(conn, sid)
            if s and s.get("client_id"):
                by_client.setdefault(str(s["client_id"]), []).append(sid)

        for cid in client_ids or sorted(by_client):
            sids = by_client.get(cid)
            if not sids:
                yield cid, None
                continue
            X, y, groups, sessions, _ = build_dataset(conn, sids, DEFAULT, verbose=False)
            yield cid, (X, y, groups, sessions)


def _mean(xs):
    return float(np.mean(xs)) if len(xs) else float("nan")


def _std(xs):
    return float(np.std(xs)) if len(xs) > 1 else float("nan")


def _avg_r2(res) -> float:
    """One number per result: R² averaged over valence and arousal."""
    return float(np.mean([res.r2[t] for t in T]))


def main() -> int:
    ap = argparse.ArgumentParser(description="Benchmark Phase 1 algorithms per client.")
    ap.add_argument("--client", action="append", dest="clients",
                    help="Client UUID (repeatable). Default: every client with "
                         "completed sessions.")
    ap.add_argument("--folds", type=int, default=5,
                    help="GroupKFold splits (clamped to the client's image count, "
                         "as train.py does).")
    ap.add_argument("--synthetic", action="store_true",
                    help="Use fake clients instead of the DB.")
    args = ap.parse_args()

    algos = list(models.make_models())
    missing = [n for n in models.names() if n not in algos]
    print(f"Algorithms: {', '.join(algos)}")
    if missing:
        print(f"⚠ Not installed, left out: {', '.join(missing)}")

    source = _synthetic_clients() if args.synthetic else _db_clients(args.clients)

    # results[algo] -> list of (client_id, Result), in the same client order per algo
    results: dict[str, list] = {a: [] for a in algos}
    skipped = []

    for cid, data in source:
        if data is None or data[0].shape[0] == 0:
            skipped.append((cid, "no labelled epochs"))
            continue
        X, y, groups, sessions = data
        n_images = len(np.unique(groups))
        if n_images < 2:
            skipped.append((cid, f"only {n_images} distinct image"))
            continue

        print(f"\n── client {cid}: {X.shape[0]} epochs, {n_images} images, "
              f"{len(np.unique(sessions))} sessions " + "─" * 10)
        # Fresh instances per client, so no fitted state can cross between clients.
        for name, model in models.make_models().items():
            res = evaluate.cross_validate(X, y, groups, sessions, model, name,
                                          n_splits=args.folds, grouped=True)
            results[name].append((cid, res))
            flag = "beats null" if res.beats_null() else "⚠ no signal"
            print(f"  {name:<14}"
                  + "  ".join(f"{t[:3]} R²={res.r2[t]:+.3f} MAE={res.mae[t]:.3f}"
                              for t in T)
                  + f"   (null R² {res.null_r2[T[0]]:+.3f}/{res.null_r2[T[1]]:+.3f})"
                  + f"  {flag}")

    for cid, why in skipped:
        print(f"\n  skipped client {cid}: {why}")

    n_clients = len(results[algos[0]]) if algos else 0
    if n_clients == 0:
        print("\nNo client had enough labelled data to benchmark.")
        return 1

    # ── Summary across clients ────────────────────────────────────────────────
    print("\n" + "=" * 100)
    print(f"MEAN OVER {n_clients} CLIENT(S) — grouped-by-image CV  "
          f"(± is the spread across clients)")
    print("=" * 100)
    print(f"  {'algorithm':<14}{'valence R²':>17}{'arousal R²':>17}"
          f"{'val MAE':>10}{'aro MAE':>10}{'ΔR² vs null':>14}{'beats null':>13}")

    summary = []
    for name, rows in results.items():
        r2 = {t: [r.r2[t] for _, r in rows] for t in T}
        mae = {t: [r.mae[t] for _, r in rows] for t in T}
        gain = [np.mean([r.r2[t] - r.null_r2[t] for t in T]) for _, r in rows]
        wins = sum(r.beats_null() for _, r in rows)
        summary.append((_mean([_avg_r2(r) for _, r in rows]), name))
        print(f"  {name:<14}"
              + "".join(f"{_mean(r2[t]):>+10.3f} ±{_std(r2[t]):.3f}" for t in T)
              + "".join(f"{_mean(mae[t]):>10.3f}" for t in T)
              + f"{_mean(gain):>+14.3f}"
              + f"{wins:>9d}/{n_clients}")

    summary.sort(reverse=True)
    best_score, best = summary[0]
    print(f"\n  Best mean R² (valence+arousal averaged): {best}  ({best_score:+.3f})")
    if not all(r.beats_null() for _, r in results[best]):
        print(f"  ⚠ {best} does not beat predict-the-mean for every client.")
    if len(summary) > 1 and n_clients > 1:
        margin = best_score - summary[1][0]
        spread = _std([_avg_r2(r) for _, r in results[best]])
        if margin < spread:
            print(f"  ⚠ Margin over {summary[1][1]} ({margin:.3f}) is smaller than the "
                  f"spread across clients ({spread:.3f}) — the ranking may be noise.")

    # Which algorithm each client individually favours. If this disagrees a lot, say
    # so in the write-up — but the default is still the single best-on-average one.
    if n_clients > 1:
        favourite: dict[str, int] = {}
        for i in range(n_clients):
            top = max(algos, key=lambda a: _avg_r2(results[a][i][1]))
            favourite[top] = favourite.get(top, 0) + 1
        print("  Per-client favourite: "
              + ", ".join(f"{a} ×{k}" for a, k in
                          sorted(favourite.items(), key=lambda kv: -kv[1])))

    return 0


if __name__ == "__main__":
    sys.exit(main())
