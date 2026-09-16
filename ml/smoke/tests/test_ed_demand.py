import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pytest

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "services" / "science"))
sys.path.insert(0, str(REPO / "ml" / "smoke"))

import ed_demand as ed  # noqa: E402

NOW = datetime(2026, 9, 16, 13, 20, tzinfo=timezone.utc)


class FlatModel:
    """Two percent per ug/m3 of lag 0-1 smoke, with a fixed band."""
    info = {"variant": "test", "literature": {"cite": "test"}}
    learned = False
    background_days = 30
    support = 34.0

    def pct_change(self, S):
        p50 = 2.0 * np.asarray(S)[:, 0]
        return {"p10": p50 * 0.5, "p50": p50, "p90": p50 * 1.5, "point": p50}


def fake_world(monkeypatch, smoke_hrrr=0.0, cams_extra=0.0, tmax=30.0, level=1, storms=(), hrrr_fails=False):
    cams = {}
    t = NOW.replace(minute=0) - timedelta(days=31)
    while t < NOW + timedelta(days=5):
        # a daily cycle that the per-hour background has to cancel
        cams[t] = 8.0 + 4 * np.sin(t.hour / 24 * 2 * np.pi) + (cams_extra if t > NOW else 0.0)
        t += timedelta(hours=1)
    monkeypatch.setattr(ed, "cams_pm25", lambda lat, lon: cams)
    days = {(NOW + timedelta(days=i)).date().isoformat(): tmax for i in range(4)}
    monkeypatch.setattr(ed, "forecast_tmax", lambda lat, lon: {"timezone": "America/New_York", "days": days})
    monkeypatch.setattr(ed, "warm_season_p95", lambda lat, lon: 34.6)
    monkeypatch.setattr(ed, "heatrisk", lambda lat, lon: {d: level for d in days})
    monkeypatch.setattr(ed, "storm_alerts", lambda lat, lon: list(storms))
    cycle = datetime(2026, 9, 16, 6, tzinfo=timezone.utc)
    monkeypatch.setattr(ed, "hrrr_cycle", lambda now: cycle)

    def hrrr(lat, lon, cyc, first):
        if hrrr_fails:
            raise RuntimeError("bucket said no")
        return {cyc + timedelta(hours=f): smoke_hrrr for f in range(max(0, first), 49)}, []
    monkeypatch.setattr(ed, "hrrr_smoke", hrrr)


def test_hrrr_then_cams_by_hour(monkeypatch):
    fake_world(monkeypatch, smoke_hrrr=40.0)
    r = ed.build(38.8, -77.05, FlatModel(), now=NOW)
    sources = [h["source"] for h in r["hours"]]
    assert len(sources) == 72
    # local midnight is 04z; the 06z cycle runs to 06z two days on
    assert sources[:2] == ["cams", "cams"]
    assert sources[2:51] == ["hrrr"] * 49
    assert set(sources[51:]) == {"cams"}
    assert r["days"][1]["smoke"]["ugm3"] == pytest.approx(40.0)
    assert r["days"][1]["smoke"]["beyond_training"]
    assert not r["days"][0]["smoke"]["beyond_training"]
    assert r["days"][0]["smoke"]["hours"] == {"hrrr": 22, "cams": 2}
    assert r["fallbacks"] == []


def test_daily_cycle_isnt_smoke(monkeypatch):
    fake_world(monkeypatch)
    r = ed.build(38.8, -77.05, FlatModel(), now=NOW, skip_hrrr=True)
    assert all(h["smoke"] == 0 for h in r["hours"])
    assert r["recommendations"][0]["cause"] == "none"
    assert r["fallbacks"] == ["HRRR skipped on request; CAMS covers every hour"]


def test_hrrr_failure_falls_back(monkeypatch):
    fake_world(monkeypatch, cams_extra=12.0, hrrr_fails=True)
    r = ed.build(38.8, -77.05, FlatModel(), now=NOW)
    assert r["sources"]["hrrr"]["status"] == "failed"
    assert any("HRRR failed" in f for f in r["fallbacks"])
    assert {h["source"] for h in r["hours"]} == {"cams"}
    assert r["days"][2]["smoke"]["ugm3"] == pytest.approx(12.0, abs=0.01)


def test_heavy_smoke_fires_rules(monkeypatch):
    fake_world(monkeypatch, smoke_hrrr=30.0)
    r = ed.build(38.8, -77.05, FlatModel(), now=NOW)
    texts = [x["text"] for x in r["recommendations"]]
    assert any("respiratory therapist hours on day two" in t for t in texts)
    assert any("inhaler stock" in t for t in texts)
    assert any("short-stay beds" in t for t in texts)
    assert all(not any(c.isdigit() for c in t) for t in texts)
    assert [x["id"] for x in r["recommendations"]] == list(range(1, len(texts) + 1))


def test_extreme_heat_uses_sun(monkeypatch):
    fake_world(monkeypatch, tmax=36.0, level=3, storms=[{"event": "Severe Thunderstorm Warning"}])
    r = ed.build(38.8, -77.05, FlatModel(), now=NOW, skip_hrrr=True)
    heat = r["days"][0]["heat"]
    assert heat["extreme"] and heat["evidence"] == "literature"
    assert heat["all_cause_pct"]["p50"] == 7.8
    assert heat["all_cause_pct"]["p10"] < 7.8 < heat["all_cause_pct"]["p90"]
    causes = {x["cause"] for x in r["recommendations"]}
    assert causes == {"heat", "storm"}
    assert r["storms"]["flag"]


def test_mild_heat_category_only(monkeypatch):
    fake_world(monkeypatch, tmax=31.0, level=3)
    r = ed.build(38.8, -77.05, FlatModel(), now=NOW, skip_hrrr=True)
    heat = r["days"][0]["heat"]
    assert heat["evidence"] == "category only" and heat["all_cause_pct"] is None
    assert heat["level_name"] == "major"
    assert "review cooling capacity" in r["recommendations"][0]["text"]


def test_band_from_published_ci():
    b = ed._pct_band([66.3, 60.2, 72.7])
    assert b["p50"] == 66.3
    assert 60.2 < b["p10"] < 66.3 < b["p90"] < 72.7


def test_cycle_steps_back_six_hours():
    seen = []

    def probe(c):
        seen.append(c.hour)
        return c.hour == 6

    c = ed.hrrr_cycle(datetime(2026, 9, 16, 13, 5, tzinfo=timezone.utc), probe)
    assert c == datetime(2026, 9, 16, 6, tzinfo=timezone.utc)
    assert seen == [12, 6]
    assert ed.hrrr_cycle(NOW, lambda c: False) is None


def test_domain_check_rough_edges():
    assert ed.in_hrrr_domain(38.8, -77.05)
    assert not ed.in_hrrr_domain(28.61, 77.21)
    assert not ed.in_hrrr_domain(61.2, -149.9)
