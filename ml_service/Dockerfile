# ML Service Dockerfile
FROM python:3.11-slim

WORKDIR /app

# Set PYTHONPATH so that 'from app.x import y' resolves correctly
ENV PYTHONPATH=/app
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

# Install Python dependencies first (better caching)
COPY requirements.txt .

RUN pip install --no-cache-dir -r requirements.txt

# Copy application files
COPY . .

# Create a non-root user and set ownership of the application directory.
# saved_models is created here (before the chown and before it becomes a mount
# point) so that when the ml-models named volume first mounts over it, the volume
# inherits appuser ownership. Without this the fresh volume is root-owned and the
# appuser process cannot write trained model artifacts into it.
RUN useradd --create-home --uid 1001 appuser && \
    mkdir -p /app/saved_models && \
    chown -R appuser:appuser /app

USER appuser

# Expose FastAPI port
EXPOSE 8000

# Start FastAPI service
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]