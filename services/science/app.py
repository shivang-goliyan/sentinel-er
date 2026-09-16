"""Pure functions over arrays, behind HTTP. Bound to localhost; only the core talks to it."""
import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
import requests
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parents[2]
ARTIFACTS = ROOT / "ml" / "casualty" / "artifacts"
SMOKE_ARTIFACTS = ROOT / "ml" / "smoke" / "artifacts"
sys.path.insert(0, str(ROOT / "ml" / "casualty"))
sys.path.insert(0, str(ROOT / "ml" / "smoke"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import ed_demand  # noqa: E402
from casualty_model import POP_BINS, CasualtyModel  # noqa: E402
from smoke_model import SmokeModel  # noqa: E402

app = FastAPI(title="sentinel-science", docs_url=None, redoc_url=None)
started = datetime.now(timezone.utc)
model = CasualtyModel(ARTIFACTS)
countries = json.loads((ARTIFACTS / "country_meta.json").read_text())
by_iso2 = {v["iso2"]: k for k, v in countries.items()}
metrics = json.loads((ARTIFACTS / "metrics.json").read_text())
smoke = SmokeModel(SMOKE_ARTIFACTS / "coefficients.json") if (SMOKE_ARTIFACTS / "coefficients.json").exists() else None


@app.get("/health")
def health():
    return {"ok": True, "started_at": started.isoformat(), "casualty_model": model.info.get("variant"),
            "smoke_model": smoke.info.get("variant") if smoke else None}


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


class PointIn(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    skip_hrrr: bool = False


# plain def: FastAPI runs it on a worker thread, and the HRRR pull takes a while
@app.post("/ed-demand")
def ed_demand_route(body: PointIn):
    if smoke is None:
        raise HTTPException(status_code=503, detail="smoke model not trained yet; run ml/smoke/train.py")
    try:
        return ed_demand.build(body.lat, body.lon, smoke, skip_hrrr=body.skip_hrrr)
    except requests.RequestException as err:
        raise HTTPException(status_code=502, detail=f"an upstream weather service failed: {err}") from err
    except RuntimeError as err:
        raise HTTPException(status_code=502, detail=str(err)) from err


@app.get("/smoke/card")
def smoke_card():
    if not (SMOKE_ARTIFACTS / "metrics.json").exists():
        raise HTTPException(status_code=404, detail="no smoke metrics yet")
    out = {"metrics": json.loads((SMOKE_ARTIFACTS / "metrics.json").read_text()), "charts": {}}
    for name in ("validation_june2023",):
        p = SMOKE_ARTIFACTS / "charts" / f"{name}.json"
        if p.exists():
            out["charts"][name] = json.loads(p.read_text())
    return out
