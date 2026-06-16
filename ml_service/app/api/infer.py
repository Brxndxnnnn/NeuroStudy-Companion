from fastapi import APIRouter

router = APIRouter()


@router.post("/infer", tags=["ml"])
def infer():
    """
    ML inference endpoint.
    Placeholder until models/persistence.py and insights pipeline are complete.
    """
    return {"status": "not_implemented", "message": "ML inference not yet implemented"}