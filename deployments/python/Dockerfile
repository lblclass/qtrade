FROM python:3.13-slim

WORKDIR /app
ENV PYTHONPATH=/app/src
COPY python/pyproject.toml /app/pyproject.toml
COPY python/src /app/src

CMD ["python", "-m", "qtrade_research.cli", "demo"]

