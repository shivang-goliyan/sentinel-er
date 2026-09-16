"""Pure functions over arrays, behind HTTP. Bound to localhost; only the core talks to it."""
from datetime import datetime, timezone

from fastapi import FastAPI

app = FastAPI(title="sentinel-science", docs_url=None, redoc_url=None)
started = datetime.now(timezone.utc)


@app.get("/health")
def health():
    return {"ok": True, "started_at": started.isoformat()}
