"""Next three days of environmental ED demand at a point: smoke, heat, storms.

Smoke PM2.5 per hour comes from HRRR-Smoke (near-surface MASSDEN, 0-48 h) and, where HRRR has
nothing, from the Open-Meteo CAMS forecast minus its own 30-day background. The smoke model turns
daily smoke into a percent change in asthma ED visits. Heat uses NWS HeatRisk for the category and
Sun et al. 2021 for a percent change on days at or above the local 95th centile of warm-season
maximum temperature. Storms are flagged from active NWS warnings, with no percent change.
"""

import json
import math
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
import requests

ROOT = Path(__file__).resolve().parents[2]
HRRR_DIR = ROOT / "data" / "raw" / "hrrr"
CACHE_DIR = ROOT / "data" / "raw" / "ed_demand"
UA = "sentinel-er (+https://github.com/shivang-goliyan/sentinel-er)"

HRRR_BUCKET = "https://noaa-hrrr-bdp-pds.s3.amazonaws.com"
HRRR_SEARCH = ":MASSDEN:8 m above ground:"
HRRR_MAX_FXX = 48
HRRR_WORKERS = int(os.environ.get("HRRR_WORKERS", "8"))
HRRR_BUDGET_S = float(os.environ.get("HRRR_BUDGET_S", "75"))
CAMS_URL = "https://air-quality-api.open-meteo.com/v1/air-quality"
FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"
HEATRISK_URL = "https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/identify"
NWS_ALERTS = "https://api.weather.gov/alerts/active"

HEATRISK_NAMES = ["little to none", "minor", "moderate", "major", "extreme"]

# Sun S et al. BMJ 2021;375:e065653 (PMID 34819309). Extreme heat = 95th centile of local May-Sep
# daily max temperature, against the local temperature of minimum morbidity, lags 0-5.
SUN_2021 = {
    "cite": "Sun S et al. BMJ 2021;375:e065653 (PMID 34819309)",
    "url": "https://doi.org/10.1136/bmj-2021-065653",
    "definition": "daily max temperature at or above the local 95th centile of May to September, "
                  "compared with the local temperature of lowest ED use",
    "all_cause": [7.8, 7.3, 8.2],
    "heat_illness": [66.3, 60.2, 72.7],
    "renal": [30.4, 23.4, 37.8],
    "not_associated": ["cardiovascular", "respiratory"],
}
P95_YEARS = (2010, 2019)

# rule thresholds, all in percent change of asthma ED visits
RULES = {
    "rt_extra_p50": 10.0,
    "rt_on_call_p50": 5.0,
    "stock_p90": 10.0,
    "beds_p50": 20.0,
    "heatrisk_review": 3,
}

_session = requests.Session()
_session.headers["user-agent"] = UA
_lock = threading.Lock()
_nearest: dict[tuple[float, float], int] = {}
_memo: dict[str, tuple[float, object]] = {}


def _memoised(key: str, ttl: float, fn):
    now = time.time()
    with _lock:
        hit = _memo.get(key)
        if hit and now - hit[0] < ttl:
            return hit[1]
    value = fn()
    with _lock:
        _memo[key] = (now, value)
    return value


def _get_json(url: str, params: dict | None = None, timeout: float = 20, headers: dict | None = None):
    r = _session.get(url, params=params, timeout=timeout, headers=headers)
    r.raise_for_status()
    return r.json()


# ---------- HRRR ----------

def in_hrrr_domain(lat: float, lon: float) -> bool:
    # the CONUS grid's corners, rounded inwards
    return 22.0 <= lat <= 52.5 and -134.0 <= lon <= -61.0


def hrrr_cycle(now: datetime, probe=None) -> datetime | None:
    """Latest 00/06/12/18z cycle whose f48 file is already on AWS."""
    probe = probe or _hrrr_has_f48
    base = now.replace(minute=0, second=0, microsecond=0)
    base -= timedelta(hours=base.hour % 6)
    for back in range(0, 5):
        cycle = base - timedelta(hours=6 * back)
        if probe(cycle):
            return cycle
    return None


def _hrrr_has_f48(cycle: datetime) -> bool:
    url = f"{HRRR_BUCKET}/hrrr.{cycle:%Y%m%d}/conus/hrrr.t{cycle:%H}z.wrfsfcf{HRRR_MAX_FXX:02d}.grib2.idx"
    try:
        return _session.head(url, timeout=10).status_code == 200
    except requests.RequestException:
        return False


def _hrrr_point(cycle: datetime, fxx: int, lat: float, lon: float) -> float:
    import eccodes
    from herbie import Herbie

    h = Herbie(cycle.strftime("%Y-%m-%d %H:%M"), model="hrrr", product="sfc", fxx=fxx,
               save_dir=str(HRRR_DIR), priority=["aws"], verbose=False)
    path = h.download(HRRR_SEARCH, overwrite=True, verbose=False)
    try:
        with open(path, "rb") as f:
            gid = eccodes.codes_grib_new_from_file(f)
        if gid is None:
            raise RuntimeError(f"empty HRRR subset for f{fxx:02d}")
        try:
            key = (round(lat, 3), round(lon, 3))
            idx = _nearest.get(key)
            if idx is None:
                idx = int(eccodes.codes_grib_find_nearest(gid, lat, lon)[0]["index"])
                _nearest[key] = idx
            kg = eccodes.codes_get_double_element(gid, "values", idx)
        finally:
            eccodes.codes_release(gid)
    finally:
        Path(path).unlink(missing_ok=True)
    return float(kg) * 1e9


def hrrr_smoke(lat: float, lon: float, cycle: datetime, first_fxx: int) -> tuple[dict[datetime, float], list[str]]:
    """Near-surface smoke in ug/m3 by valid hour. Returns what arrived inside the time budget."""
    cache = CACHE_DIR / f"hrrr_{cycle:%Y%m%d%H}_{lat:.3f}_{lon:.3f}.json"
    got: dict[datetime, float] = {}
    if cache.exists():
        for k, v in json.loads(cache.read_text()).items():
            got[datetime.fromisoformat(k)] = v
    wanted = [f for f in range(max(0, first_fxx), HRRR_MAX_FXX + 1) if cycle + timedelta(hours=f) not in got]
    problems: list[str] = []
    if wanted:
        pool = ThreadPoolExecutor(max_workers=HRRR_WORKERS)
        futures = {pool.submit(_hrrr_point, cycle, f, lat, lon): f for f in wanted}
        try:
            for fut in as_completed(futures, timeout=HRRR_BUDGET_S):
                f = futures[fut]
                try:
                    got[cycle + timedelta(hours=f)] = round(fut.result(), 3)
                except Exception as err:  # one bad hour shouldn't sink the rest
                    problems.append(f"f{f:02d}: {err}")
        except TimeoutError:
            problems.append(f"HRRR ran past {HRRR_BUDGET_S:.0f} s; {len(wanted) - len(problems)} hours tried")
        finally:
            pool.shutdown(wait=False, cancel_futures=True)
        if got:
            CACHE_DIR.mkdir(parents=True, exist_ok=True)
            cache.write_text(json.dumps({k.isoformat(): v for k, v in sorted(got.items())}))
    return got, problems


# ---------- CAMS, weather, HeatRisk, alerts ----------

def cams_pm25(lat: float, lon: float) -> dict[datetime, float]:
    def pull():
        d = _get_json(CAMS_URL, {"latitude": lat, "longitude": lon, "hourly": "pm2_5", "past_days": 31,
                                 "forecast_days": 5, "timezone": "GMT"})
        out = {}
        for t, v in zip(d["hourly"]["time"], d["hourly"]["pm2_5"]):
            if v is not None:
                out[datetime.fromisoformat(t).replace(tzinfo=timezone.utc)] = float(v)
        return out
    return _memoised(f"cams:{lat:.2f}:{lon:.2f}", 1800, pull)


def forecast_tmax(lat: float, lon: float) -> dict:
    def pull():
        d = _get_json(FORECAST_URL, {"latitude": lat, "longitude": lon, "daily": "temperature_2m_max",
                                     "timezone": "auto", "forecast_days": 4})
        return {"timezone": d["timezone"], "days": dict(zip(d["daily"]["time"], d["daily"]["temperature_2m_max"]))}
    return _memoised(f"tmax:{lat:.2f}:{lon:.2f}", 1800, pull)


def warm_season_p95(lat: float, lon: float) -> float:
    la, lo = round(lat * 4) / 4, round(lon * 4) / 4
    cache = CACHE_DIR / f"p95_{la:.2f}_{lo:.2f}.json"
    if cache.exists():
        return json.loads(cache.read_text())["p95_c"]
    d = _get_json(ARCHIVE_URL, {"latitude": la, "longitude": lo, "daily": "temperature_2m_max",
                                "start_date": f"{P95_YEARS[0]}-05-01", "end_date": f"{P95_YEARS[1]}-09-30",
                                "timezone": "auto"}, timeout=60)
    vals = [v for t, v in zip(d["daily"]["time"], d["daily"]["temperature_2m_max"])
            if v is not None and 5 <= int(t[5:7]) <= 9]
    if len(vals) < 500:
        raise RuntimeError(f"only {len(vals)} warm-season days came back for the heat threshold")
    p95 = round(float(np.percentile(vals, 95)), 1)
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps({"p95_c": p95, "days": len(vals), "years": P95_YEARS, "lat": la, "lon": lo}))
    return p95


def heatrisk(lat: float, lon: float) -> dict[str, int]:
    """HeatRisk category by local date, from the ImageServer's catalog items (day files 1-7)."""
    def pull():
        geom = json.dumps({"x": lon, "y": lat, "spatialReference": {"wkid": 4326}})
        d = _get_json(HEATRISK_URL, {"geometry": geom, "geometryType": "esriGeometryPoint",
                                     "returnGeometry": "false", "returnCatalogItems": "true", "f": "json"})
        if "error" in d:
            raise RuntimeError(d["error"].get("message", "HeatRisk said no"))
        out = {}
        for item in (d.get("catalogItems") or {}).get("features", []):
            a = item["attributes"]
            if a.get("category") is None or a.get("idp_validtime") is None:
                continue
            day = datetime.fromtimestamp(a["idp_validtime"] / 1000, tz=timezone.utc).date().isoformat()
            out[day] = int(a["category"])
        if not out:
            raise RuntimeError("HeatRisk had no data at this point")
        return out
    return _memoised(f"heatrisk:{lat:.2f}:{lon:.2f}", 1800, pull)


def storm_alerts(lat: float, lon: float) -> list[dict]:
    def pull():
        d = _get_json(NWS_ALERTS, {"point": f"{lat:.4f},{lon:.4f}", "severity": "Severe,Extreme"},
                      headers={"accept": "application/geo+json"})
        out = []
        for f in d.get("features", []):
            p = f["properties"]
            if p.get("status") != "Actual":
                continue
            out.append({k: p.get(k) for k in ("event", "severity", "urgency", "headline", "onset", "expires")})
        return out
    return _memoised(f"nws:{lat:.3f}:{lon:.3f}", 300, pull)


# ---------- assembly ----------

def _pct_band(published: list[float]) -> dict[str, float]:
    """p10/p50/p90 from a published [estimate, 95% low, 95% high], assuming normal on the log scale."""
    est, lo, hi = (math.log1p(x / 100) for x in published)
    se = (hi - lo) / (2 * 1.96)
    z = 1.2816
    return {"p10": round(math.expm1(est - z * se) * 100, 1), "p50": round(published[0], 1),
            "p90": round(math.expm1(est + z * se) * 100, 1)}


def hourly_background(cams: dict[datetime, float], before: datetime, days: int = 30) -> dict[int, float] | None:
    """Median CAMS PM2.5 for each UTC hour over the `days` before `before`. Taking it per hour keeps
    the model's daily cycle from passing for smoke."""
    start = before - timedelta(days=days)
    by_hour: dict[int, list[float]] = {}
    for t, v in cams.items():
        if start <= t < before:
            by_hour.setdefault(t.hour, []).append(v)
    if len(by_hour) < 24 or min(len(v) for v in by_hour.values()) < days // 3:
        return None
    return {h: float(np.median(v)) for h, v in by_hour.items()}


def build(lat: float, lon: float, model, now: datetime | None = None, skip_hrrr: bool = False) -> dict:
    now = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    sources: dict[str, dict] = {}
    fallbacks: list[str] = []

    wx = forecast_tmax(lat, lon)
    tz = ZoneInfo(wx["timezone"])
    local_now = now.astimezone(tz)
    midnight = local_now.replace(hour=0, minute=0, second=0, microsecond=0)
    day_starts = [midnight + timedelta(days=i) for i in range(3)]
    # whole UTC hours; places with half-hour offsets start at the first full hour of their day
    first = day_starts[0].astimezone(timezone.utc)
    if first.minute:
        first = first.replace(minute=0) + timedelta(hours=1)
    hours = [first + timedelta(hours=h) for h in range(72)]
    # DST days have 23 or 25 hours; bucket by local date rather than by count
    dates = [d.date().isoformat() for d in day_starts]
    sources["open_meteo_weather"] = {"status": "ok", "url": FORECAST_URL, "timezone": wx["timezone"]}

    cams = cams_pm25(lat, lon)
    sources["cams"] = {"status": "ok", "url": CAMS_URL, "hours": len(cams)}
    lag_start = (day_starts[0] - timedelta(days=5)).astimezone(timezone.utc)
    bg = hourly_background(cams, lag_start)
    if bg is None:
        raise RuntimeError("not enough CAMS history for a smoke background")
    sources["cams"]["background_ugm3"] = round(float(np.mean(list(bg.values()))), 2)

    def cams_smoke(t: datetime) -> float:
        return round(max(0.0, cams[t] - bg[t.hour]), 2)

    hrrr: dict[datetime, float] = {}
    if skip_hrrr or not in_hrrr_domain(lat, lon):
        why = "skipped on request" if skip_hrrr else "outside the HRRR domain"
        fallbacks.append(f"HRRR {why}; CAMS covers every hour")
        sources["hrrr"] = {"status": "skipped", "reason": why}
    else:
        try:
            cycle = hrrr_cycle(now)
            if cycle is None:
                raise RuntimeError("no HRRR cycle with a 48-hour forecast in the last day")
            first = int((hours[0] - cycle).total_seconds() // 3600)
            hrrr, problems = hrrr_smoke(lat, lon, cycle, first)
            sources["hrrr"] = {"status": "ok" if hrrr else "failed", "cycle": cycle.isoformat(),
                               "field": HRRR_SEARCH.strip(":"), "hours": len(hrrr),
                               "url": f"{HRRR_BUCKET}/hrrr.{cycle:%Y%m%d}/conus/", "problems": problems[:5]}
            if not hrrr:
                fallbacks.append("HRRR returned nothing; CAMS covers every hour")
            elif problems:
                fallbacks.append(f"HRRR missed {len(problems)} hours; CAMS fills them")
        except Exception as err:
            sources["hrrr"] = {"status": "failed", "reason": str(err)[:200]}
            fallbacks.append(f"HRRR failed ({str(err)[:120]}); CAMS covers every hour")

    strip = []
    for t in hours:
        if t in hrrr:
            strip.append({"t": t.isoformat(), "source": "hrrr", "smoke": hrrr[t], "past": t < now})
        elif t in cams:
            strip.append({"t": t.isoformat(), "source": "cams", "smoke": cams_smoke(t),
                          "pm25": cams[t], "past": t < now})
        else:
            strip.append({"t": t.isoformat(), "source": "none", "smoke": None, "past": t < now})

    by_date: dict[str, list[float]] = {}
    for row in strip:
        if row["smoke"] is not None:
            by_date.setdefault(datetime.fromisoformat(row["t"]).astimezone(tz).date().isoformat(), []).append(row["smoke"])
    lag_dates = [(day_starts[0] - timedelta(days=k)).date().isoformat() for k in range(5, 0, -1)]
    cams_days: dict[str, list[float]] = {}
    for t in cams:
        cams_days.setdefault(t.astimezone(tz).date().isoformat(), []).append(cams_smoke(t))
    daily: dict[str, float] = {}
    lags = []
    for d in lag_dates:
        v = cams_days.get(d)
        daily[d] = float(np.mean(v)) if v else 0.0
        lags.append({"date": d, "smoke": round(daily[d], 2), "source": "cams" if v else "missing"})
    for d in dates:
        v = by_date.get(d)
        if not v:
            raise RuntimeError(f"no smoke numbers at all for {d}")
        daily[d] = float(np.mean(v))

    seq = lag_dates + dates
    S = []
    for d in dates:
        i = seq.index(d)
        s = [daily[seq[i - k]] for k in range(6)]
        S.append([(s[0] + s[1]) / 2, (s[2] + s[3]) / 2, (s[4] + s[5]) / 2])
    bands = model.pct_change(np.array(S))
    support = getattr(model, "support", None)

    try:
        if not in_hrrr_domain(lat, lon):
            raise RuntimeError("HeatRisk covers the lower 48 states only")
        levels = heatrisk(lat, lon)
        sources["heatrisk"] = {"status": "ok", "url": HEATRISK_URL.rsplit("/", 1)[0]}
    except Exception as err:
        levels = {}
        sources["heatrisk"] = {"status": "failed", "reason": str(err)[:200]}
        fallbacks.append("NWS HeatRisk unavailable; heat level left blank")
    try:
        p95 = warm_season_p95(lat, lon)
        sources["heat_threshold"] = {"status": "ok", "url": ARCHIVE_URL, "p95_c": p95,
                                     "years": f"{P95_YEARS[0]}-{P95_YEARS[1]}, May-Sep, ERA5"}
    except Exception as err:
        p95 = None
        sources["heat_threshold"] = {"status": "failed", "reason": str(err)[:200]}
        fallbacks.append("No local heat threshold; no heat percent change")

    days = []
    for n, d in enumerate(dates, start=1):
        tmax = wx["days"].get(d)
        extreme = bool(p95 is not None and tmax is not None and tmax >= p95)
        level = levels.get(d)
        heat = {
            "level": level,
            "level_name": HEATRISK_NAMES[level] if level is not None and 0 <= level < 5 else None,
            "tmax_c": tmax,
            "p95_c": p95,
            "extreme": extreme,
            "evidence": "literature" if extreme else "category only",
            "all_cause_pct": _pct_band(SUN_2021["all_cause"]) if extreme else None,
            "heat_illness_pct": _pct_band(SUN_2021["heat_illness"]) if extreme else None,
            "renal_pct": _pct_band(SUN_2021["renal"]) if extreme else None,
        }
        counts = {"hrrr": 0, "cams": 0}
        for row in strip:
            if row["source"] in counts and datetime.fromisoformat(row["t"]).astimezone(tz).date().isoformat() == d:
                counts[row["source"]] += 1
        days.append({
            "day": n,
            "date": d,
            "smoke": {
                "ugm3": round(daily[d], 2),
                "s01": round(S[n - 1][0], 2),
                "s23": round(S[n - 1][1], 2),
                "s45": round(S[n - 1][2], 2),
                "pct": {q: round(float(bands[q][n - 1]), 1) for q in ("p10", "p50", "p90")},
                "hours": counts,
                # past the highest smoke the model was checked against
                "beyond_training": bool(support is not None and S[n - 1][0] > support),
            },
            "heat": heat,
        })

    try:
        storms = storm_alerts(lat, lon)
        sources["nws_alerts"] = {"status": "ok", "url": NWS_ALERTS}
    except Exception as err:
        storms = []
        outside = isinstance(err, requests.HTTPError) and err.response is not None and err.response.status_code == 400
        sources["nws_alerts"] = {"status": "failed", "reason": "no NWS coverage here" if outside else str(err)[:200]}
        fallbacks.append("No NWS coverage here; storm flag unknown" if outside else "NWS alerts unavailable; storm flag unknown")

    return {
        "generated_at": now.isoformat(),
        "location": {"lat": lat, "lon": lon, "timezone": wx["timezone"]},
        "days": days,
        "hours": strip,
        "lags": lags,
        "storms": {"flag": bool(storms), "active": storms, "evidence": "flag only"},
        "recommendations": recommend(days, storms),
        "rules": RULES,
        "sources": sources,
        "fallbacks": fallbacks,
        "model": {
            "smoke": {"variant": model.info.get("variant"), "use_correction": model.learned,
                      "literature": model.info["literature"]["cite"],
                      "background_days": model.background_days, "training_max_s01": support},
            "heat": SUN_2021,
        },
    }


WORD = {1: "one", 2: "two", 3: "three"}


def recommend(days: list[dict], storms: list[dict]) -> list[dict]:
    """Plain rules, no language model. Texts carry no digits; the numbers live in the facts."""
    out: list[dict] = []

    def add(cause, day, text, basis):
        out.append({"cause": cause, "day": day, "text": text, "basis": basis})

    smoky = [d for d in days if d["smoke"]["pct"]["p50"] >= RULES["rt_extra_p50"]]
    watch = [d for d in days if RULES["rt_on_call_p50"] <= d["smoke"]["pct"]["p50"] < RULES["rt_extra_p50"]]
    for d in smoky:
        add("smoke", d["day"], f"Add respiratory therapist hours on day {WORD[d['day']]} for smoke-driven asthma visits",
            "smoke p50 at or above the extra-cover threshold")
    for d in watch:
        add("smoke", d["day"], f"Put a respiratory therapist on call for day {WORD[d['day']]}",
            "smoke p50 at or above the on-call threshold")
    stock = [d for d in days if d["smoke"]["pct"]["p90"] >= RULES["stock_p90"]]
    if stock:
        first = stock[0]["day"]
        add("smoke", first, f"Check nebuliser, spacer and rescue inhaler stock before day {WORD[first]}",
            "smoke p90 at or above the stock threshold")
    for d in days:
        if d["smoke"]["pct"]["p50"] >= RULES["beds_p50"]:
            add("smoke", d["day"], f"Hold short-stay beds for asthma and COPD on day {WORD[d['day']]}",
                "smoke p50 at or above the bed threshold")
    for d in days:
        h = d["heat"]
        if h["extreme"]:
            add("heat", d["day"], f"Stage extra cooling on day {WORD[d['day']]}: ice, cold fluids, cooling blankets",
                "forecast max at or above the local warm-season high")
            add("heat", d["day"], f"Keep observation beds for heat illness and kidney injury on day {WORD[d['day']]}",
                "forecast max at or above the local warm-season high")
        elif h["level"] is not None and h["level"] >= RULES["heatrisk_review"]:
            add("heat", d["day"], f"HeatRisk is {h['level_name']} on day {WORD[d['day']]}; review cooling capacity",
                "NWS HeatRisk category at or above the review level")
    if storms:
        add("storm", None, "Severe weather warning in force: check generator fuel and expect injury and outage patients",
            "active NWS severe or extreme warning at this point")
    if not out:
        add("none", None, "No environmental surge expected from the sources that answered; keep standard staffing",
            "no rule fired")
    for i, r in enumerate(out, start=1):
        r["id"] = i
    return out
