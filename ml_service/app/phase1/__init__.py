"""
ML Phase 1 — predict OASIS valence/arousal from filtered EEG.

Reads eeg_filtered_samples directly and computes its own features. Deliberately
independent of the separate window-feature table the results chart uses: the raw
data is already in the DB, so there is no reason to put this pipeline behind
another deliverable.

    epochs.py    eeg_filtered_samples + events + images -> labelled epochs
    features.py  epoch -> 50-dim feature vector (band powers, ratios, asymmetry)
    dataset.py   many sessions -> (X, y, groups, sessions)
    evaluate.py  grouped-by-image CV, null baseline, leakage guard
    config.py    every knob, in one place
"""
