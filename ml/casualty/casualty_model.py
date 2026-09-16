"""Shared feature building and prediction for the casualty model.

Each prediction starts from a physical prior: people exposed at each intensity × a global
fatality-rate curve (the median of USGS PAGER's country curves), scaled by the country's own
record (how many people its past earthquakes killed compared with that curve). LightGBM quantile
boosters then learn the correction on top, so
    log1p(deaths_q) = log1p(prior) + booster_q(features)
The boosters are saved without the prior; add it back at predict time.
"""

import json
import math
import xml.etree.ElementTree as ET
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd

QUANTILES = (0.1, 0.5, 0.9)
POP_BINS = list(range(4, 11))
POP_COLS = [f"pop_mmi{k}" for k in POP_BINS]
FACTOR_PRIOR = 10.0

BASE_FEATURES = [f"log_{c}" for c in POP_COLS] + [
    "magnitude", "depth_km", "hour_sin", "hour_cos", "is_night", "income_class", "log_gdp_per_capita",
    "log_global_expected", "country_factor", "region_factor"]
ALERT_FEATURES = BASE_FEATURES + ["pager_alert"]


def global_curve(fatality_xml):
    root = ET.parse(fatality_xml).getroot()
    thetas = [float(m.attrib["theta"]) for m in root.iter("model")]
    betas = [float(m.attrib["beta"]) for m in root.iter("model")]
    return float(np.median(thetas)), float(np.median(betas))


def curve_rates(theta, beta, bins=POP_BINS):
    return np.array([0.5 * (1 + math.erf(math.log(k / theta) / beta / math.sqrt(2))) for k in bins])


def add_features(df, theta, beta):
    df = df.copy()
    for c in POP_COLS:
        df[f"log_{c}"] = np.log1p(df[c].clip(lower=0))
    hour = df["local_hour"]
    df["hour_sin"] = np.sin(2 * np.pi * hour / 24)
    df["hour_cos"] = np.cos(2 * np.pi * hour / 24)
    # night = 22:00 to 05:59 local, when most people are indoors and asleep
    df["is_night"] = np.where(hour.isna(), np.nan, ((hour >= 22) | (hour < 6)).astype(float))
    df["log_gdp_per_capita"] = np.log10(df["gdp_per_capita"])
    df["global_expected"] = df[POP_COLS].to_numpy(dtype=float) @ curve_rates(theta, beta)
    df["log_global_expected"] = np.log1p(df["global_expected"])
    return df


def learn_factors(rows):
    """log10 of (recorded deaths + k) / (curve-expected deaths + k), per country and per region,
    from training rows only. k keeps countries with little history near zero."""
    out = {}
    for key in ("iso3", "region"):
        g = rows.groupby(key).agg(deaths=("deaths", "sum"), expected=("global_expected", "sum"),
                                  events=("deaths", "size"))
        factor = np.log10((g["deaths"] + FACTOR_PRIOR) / (g["expected"] + FACTOR_PRIOR))
        out[key] = {k: {"factor": round(float(f), 5), "events": int(n)}
                    for k, f, n in zip(g.index, factor, g["events"])}
    return out


def apply_factors(df, factors):
    df = df.copy()
    region = df["region"].map({k: v["factor"] for k, v in factors["region"].items()})
    country = df["iso3"].map({k: v["factor"] for k, v in factors["iso3"].items()})
    df["region_factor"] = region.fillna(0.0)
    df["country_factor"] = country.fillna(df["region_factor"])
    df["prior_log1p"] = np.log1p(df["global_expected"] * 10 ** df["country_factor"])
    return df


def fit_quantiles(X, y_log1p, weight, prior, params):
    models = {}
    for q in QUANTILES:
        m = lgb.LGBMRegressor(alpha=q, **params)
        m.fit(X, y_log1p, sample_weight=weight, init_score=prior)
        models[q] = m.booster_
    return models


def predict_quantiles(models, X, prior):
    raw = np.column_stack([models[q].predict(X) for q in QUANTILES]) + np.asarray(prior)[:, None]
    # separately fitted quantiles can cross; sorting restores p10 <= p50 <= p90
    return np.clip(np.expm1(np.sort(raw, axis=1)), 0, None)


class CasualtyModel:
    """Loads the saved artifacts and predicts from a frame with the training-table columns."""

    def __init__(self, folder):
        folder = Path(folder)
        self.info = json.loads((folder / "features.json").read_text())
        self.factors = json.loads((folder / "country_factors.json").read_text())
        self.features = self.info["features"]
        self.theta = self.info["prior"]["theta"]
        self.beta = self.info["prior"]["beta"]
        self.shift = self.info["prior"]["shift_log1p"]
        self.boosters = {t: {q: lgb.Booster(model_file=str(folder / f"model_{t}_p{int(q * 100)}.txt"))
                             for q in QUANTILES} for t in ("deaths", "injured")}

    def prepare(self, df):
        return apply_factors(add_features(df, self.theta, self.beta), self.factors)

    def predict(self, df):
        ready = self.prepare(df)
        out = {}
        for target, models in self.boosters.items():
            p = predict_quantiles(models, ready[self.features], ready["prior_log1p"] + self.shift[target])
            out[target] = pd.DataFrame(p, columns=["p10", "p50", "p90"], index=df.index)
        return out, ready

    def explain(self, ready_row, target="deaths"):
        booster = self.boosters[target][0.5]
        contrib = booster.predict(ready_row[self.features], pred_contrib=True)[0]
        prior = float(ready_row["prior_log1p"].iloc[0]) + self.shift[target]
        return {
            "prior_log1p": round(prior, 4),
            "booster_base_log1p": round(float(contrib[-1]), 4),
            "prediction_log1p": round(prior + float(contrib.sum()), 4),
            "contributions": sorted(
                [{"feature": f, "contribution_log1p": round(float(c), 4),
                  "value": None if pd.isna(v) else round(float(v), 4)}
                 for f, c, v in zip(self.features, contrib[:-1], ready_row[self.features].iloc[0])],
                key=lambda d: -abs(d["contribution_log1p"])),
        }
