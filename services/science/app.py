"""Pure functions over arrays, behind HTTP. Bound to localhost; only the core talks to it."""
import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parents[2]
ARTIFACTS = ROOT / "ml" / "casualty" / "artifacts"
sys.path.insert(0, str(ROOT / "ml" / "casualty"))

from casualty_model import POP_BINS, CasualtyModel  # noqa: E402

app = FastAPI(title="sentinel-science", docs_url=None, redoc_url=None)
started = datetime.now(timezone.utc)
model = CasualtyModel(ARTIFACTS)
countries = json.loads((ARTIFACTS / "country_meta.json").read_text())
by_iso2 = {v["iso2"]: k for k, v in countries.items()}
metrics = json.loads((ARTIFACTS / "metrics.json").read_text())


@app.get("/health")
def health():
    return {"ok": True, "started_at": started.isoformat(), "casualty_model": model.info.get("variant")}


class CasualtyIn(BaseModel):
    # people per integer shaking band, keys "4".."10"
    pop_mmi: dict[str, float]
    magnitude: float
    depth_km: float
    local_hour: float | None = Field(default=None, ge=0, lt=24)
    iso3: str | None = None
    iso2: str | None = None


def _round(x: float) -> int:
    return int(max(0, round(float(x))))


@app.post("/casualty")
def casualty(body: CasualtyIn):
    iso3 = (body.iso3 or by_iso2.get((body.iso2 or "").upper()) or "").upper()
    meta = countries.get(iso3)
    if not meta:
        raise HTTPException(status_code=422, detail=f"unknown country {body.iso3 or body.iso2!r}")
    row = {f"pop_mmi{k}": float(body.pop_mmi.get(str(k), 0) or 0) for k in POP_BINS}
    row.update(
        magnitude=body.magnitude,
        depth_km=body.depth_km,
        local_hour=body.local_hour if body.local_hour is not None else math.nan,
        iso3=iso3,
        region=meta["region"],
        income_class=meta["income_class"] if meta["income_class"] is not None else math.nan,
        gdp_per_capita=meta["gdp_per_capita"] or math.nan,
    )
    frame = pd.DataFrame([row])
    preds, ready = model.predict(frame)
    out = {t: {q: _round(preds[t][q].iloc[0]) for q in ("p10", "p50", "p90")} for t in preds}
    why = model.explain(ready.iloc[[0]], "deaths")
    return {
        "deaths": out["deaths"],
        "injured": out["injured"],
        "explain": {**why, "contributions": why["contributions"][:6]},
        "country": {"iso3": iso3, "name": meta["name"], "region": meta["region"],
                    "income_class": meta["income_class"], "gdp_year": meta["gdp_year"]},
        "prior_deaths": _round(math.expm1(float(ready["prior_log1p"].iloc[0]))),
        "model": {"variant": model.info.get("variant"), "trained_rows": model.info.get("model_files", {})
                  .get("model_deaths_p50.txt", {}).get("rows")},
    }


@app.get("/casualty/card")
def casualty_card():
    charts = {}
    for name in ("holdout", "cv_calibration", "bias", "contributions_turkey"):
        p = ARTIFACTS / "charts" / f"{name}.json"
        if p.exists():
            charts[name] = json.loads(p.read_text())
    return {"metrics": metrics, "charts": charts}
