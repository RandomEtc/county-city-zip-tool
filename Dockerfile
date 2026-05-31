FROM python:3.12-slim

WORKDIR /app

# System libs needed by shapely/pyogrio wheels
RUN apt-get update && apt-get install -y --no-install-recommends \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies (cached layer — only invalidated when requirements change)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt gunicorn

# Run data setup — downloads Census files and precomputes overlaps (~3 min, ~80MB download)
# Runs as its own layer so Docker cache avoids re-running when only app code changes
COPY setup.py .
RUN python setup.py && rm -rf downloads/

# Copy application code
COPY app.py .
COPY templates/ templates/
COPY static/ static/

EXPOSE 8080

CMD ["gunicorn", "--bind", "0.0.0.0:8080", "--workers", "2", "--timeout", "60", "app:app"]
