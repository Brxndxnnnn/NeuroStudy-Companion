import os
from dotenv import load_dotenv

load_dotenv()


# The rest of the stack names its DB variables POSTGRES_*; this service asks for DB_*.
# Nothing reconciled the two, so ml_service crashed on import the moment it was deployed
# with the shared env file — and kept crashing, unnoticed, because uvicorn's reloader
# keeps the container "Up" while the app inside it dies. The /process endpoint has never
# been reachable in production.
#
# Accept either spelling rather than requiring every env file in the project to agree
# with this one module.
_ALIASES = {
    "DB_USER":     "POSTGRES_USER",
    "DB_PASSWORD": "POSTGRES_PASSWORD",
    "DB_HOST":     "POSTGRES_HOST",
    "DB_PORT":     "POSTGRES_PORT",
    "DB_NAME":     "POSTGRES_DB",
}


def _require(key: str) -> str:
    """
    Read a required environment variable, falling back to its POSTGRES_* alias.

    Raises RuntimeError immediately if neither is set, rather than silently building a
    broken connection string.
    """
    val = os.getenv(key)
    if not val:
        alias = _ALIASES.get(key)
        if alias:
            val = os.getenv(alias)
    if not val:
        alias = _ALIASES.get(key)
        names = f"{key} (or {alias})" if alias else key
        raise RuntimeError(
            f"Missing required environment variable: {names}. "
            f"Check your .env or .env.docker file."
        )
    return val


class Settings:
    # ── Database ───────────────────────────────────────────────────────────────
    DB_USER:     str = _require("DB_USER")
    DB_PASSWORD: str = _require("DB_PASSWORD")
    DB_HOST:     str = _require("DB_HOST")
    DB_PORT:     str = _require("DB_PORT")
    DB_NAME:     str = _require("DB_NAME")

    @property
    def DATABASE_URL(self) -> str:
        return (
            f"postgresql://{self.DB_USER}:{self.DB_PASSWORD}"
            f"@{self.DB_HOST}:{self.DB_PORT}/{self.DB_NAME}"
        )

    # ── EEG hardware constants ─────────────────────────────────────────────────
    SAMPLE_RATE:       int   = 250        # Hz — Senseband 2
    SAMPLES_PER_FRAME: int   = 249        # SDK fires 249 samples per frame
    ADC_SCALE:         float = 0.02235    # ADC counts -> microvolts
    CHANNELS:          list  = ["fp1", "fp2", "t3", "t4"]

    # ── Frequency band definitions (Hz) ───────────────────────────────────────
    BAND_DELTA: tuple = (0.5,  4.0)
    BAND_THETA: tuple = (4.0,  8.0)
    BAND_ALPHA: tuple = (8.0,  13.0)
    BAND_BETA:  tuple = (13.0, 30.0)
    BAND_GAMMA: tuple = (30.0, 45.0)    # capped at 45 Hz — safe below Nyquist at 250 Hz

    # ── Preprocessing ──────────────────────────────────────────────────────────
    BANDPASS_LOW:  float = 0.5     # Hz
    BANDPASS_HIGH: float = 45.0    # Hz
    NOTCH_FREQ:    float = 50.0    # Hz — Singapore/EU mains (change to 60.0 for US)
    NOTCH_Q:       float = 30.0    # quality factor — higher = narrower notch

    # ── Quality gating (applied on eeg_readings filt_pkpk) ────────────────────
    QUALITY_PKPK_MAX: float = 500.0   # µV — above this = movement/EMG artefact
    QUALITY_PKPK_MIN: float = 1.0     # µV — below this = flat line / disconnected

    # ── Windowing for PSD ─────────────────────────────────────────────────────
    # How many seconds of raw samples to group into one analysis window
    WINDOW_SIZE_S:  int   = 4      # seconds per analysis window (4 * 250 = 1000 samples)
    WINDOW_OVERLAP: float = 0.5    # 50% overlap between consecutive windows

    # ── Windowing for elliptic pipeline ────────────────────────────────────────
    # CHANGE HERE to set default window/step size for elliptic feature extraction.
    # None = full session treated as one window (current default).
    # pipeline.py will fall back to these values if the caller passes None.
    # Only used when the caller (e.g. /process) doesn't pass its own value.
    ELLIPTIC_WINDOW_SIZE_S: float = None   # seconds per analysis window
    ELLIPTIC_STEP_S:        float = None   # step between consecutive windows

    # ── ML service ─────────────────────────────────────────────────────────────
    MODEL_DIR: str = os.getenv("MODEL_DIR", "/app/saved_models")


settings = Settings()