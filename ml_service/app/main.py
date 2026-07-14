from fastapi import FastAPI
from app.api.health   import router as health_router
from app.api.infer    import router as infer_router
from app.api.process  import router as process_router

app = FastAPI(
    title="NeuroStudy ML Service",
    description=(
        "EEG signal processing and ML inference service "
        "for the NeuroStudy Companion platform."
    ),
    version="0.1.0",
)

app.include_router(health_router)
app.include_router(infer_router)
app.include_router(process_router)