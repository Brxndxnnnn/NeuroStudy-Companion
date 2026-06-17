FROM python:3.11-slim

WORKDIR /app

# Set PYTHONPATH so that 'from app.x import y' resolves correctly
ENV PYTHONPATH=/app

# Install Python dependencies first (better caching)
COPY requirements.txt .

RUN pip install --no-cache-dir -r requirements.txt

# Copy application files
COPY . .

# Expose FastAPI port
EXPOSE 8000

# Start FastAPI service
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]