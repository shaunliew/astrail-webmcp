# Render deploy target — multi-stage, non-root, $PORT bind, SIGTERM graceful shutdown.

FROM python:3.14-slim AS builder
WORKDIR /app
RUN pip install --no-cache-dir uv
COPY pyproject.toml .
# Install dependencies only (the app itself is not a packaged module yet).
RUN uv sync --no-dev --no-install-project

FROM python:3.14-slim AS runtime
WORKDIR /app
# Run as an unprivileged user.
RUN useradd --create-home --uid 10001 appuser
COPY --from=builder /app/.venv /app/.venv
COPY backend/ ./backend/
ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PORT=8000
USER appuser
EXPOSE 8000
# Render injects $PORT; `exec` makes uvicorn PID 1 so it receives SIGTERM directly.
CMD ["sh", "-c", "exec uvicorn backend.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
