"""
api/process.py

/process endpoint — triggers the elliptic feature extraction pipeline
for a given session and writes results to elliptic_band_stats.

Responsibility: signal processing + feature extraction only.
  - Fetches SDK-filtered EEG from eeg_filtered_samples
  - Computes elliptic band stats (mean, std, peak per band per channel)
  - Writes the 60-feature vector per window to elliptic_band_stats

This is intentionally separate from /infer, which handles
ML model inference and insight generation on top of already-computed
features. The separation keeps signal processing and ML inference
as independent, independently-testable steps:

  POST /process/{session_id}  ->  computes + stores features
  POST /infer/{session_id}    ->  loads features + runs ML + stores insights

Usage:
    POST /process/{session_id}
    POST /process/{session_id}?window_size_s=2.0&step_s=1.0
    POST /process/{session_id}?window_size_s=4.0&step_s=2.0
"""

from fastapi import APIRouter, HTTPException
from typing import Optional
from sqlalchemy.exc import SQLAlchemyError

from app.database import engine
from app.feature_extraction.pipeline import run_elliptic_pipeline

router = APIRouter()


@router.post("/process/{session_id}", tags=["pipeline"])
def process_session(
    session_id:    str,
    window_size_s: Optional[float] = None,
    step_s:        Optional[float] = None,
):
    """
    Trigger the elliptic feature extraction pipeline for one session.

    Fetches SDK-filtered EEG from eeg_filtered_samples, computes elliptic
    band stats (mean, std, peak) across sliding windows for all 4 channels
    and 5 bands, then writes results to elliptic_band_stats.

    Args:
        session_id:    UUID of the session to process.
        window_size_s: Analysis window size in seconds.
                       Default (None) = full session as one window.
        step_s:        Step between consecutive windows in seconds.
                       Default (None) = no overlap (step equals window size).

    Returns:
        {
          "session_id":    str,
          "n_rows":        int,   -- rows written to elliptic_band_stats
          "window_size_s": float, -- resolved window size used
          "step_s":        float, -- resolved step used
        }
    """
    try:
        with engine.begin() as conn:
            result = run_elliptic_pipeline(
                conn,
                session_id    = session_id,
                window_size_s = window_size_s,
                step_s        = step_s,
            )

        return {
            "status":        "ok",
            "session_id":    session_id,
            "n_rows":        result["n_rows"],
            "window_size_s": result["window_size_s"],   # resolved — never None
            "step_s":        result["step_s"],           # resolved — never None
        }

    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))

    except SQLAlchemyError as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")