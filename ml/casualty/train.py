"""Cross-validate and train the casualty quantile models.

Reads artifacts/training_table.csv.gz (from build_dataset.py). Writes the six default boosters,
features.json and metrics.json to artifacts/, and out-of-fold predictions to data/raw/derived/
for evaluate.py.
"""

import json
import math
import time
import xml.etree.ElementTree as ET
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.model_selection import GroupKFold

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
ARTIFACTS = HERE / "artifacts"
DERIVED = REPO / "data" / "raw" / "derived"
CATALOGS = REPO / "data" / "raw" / "catalogs"

QUANTILES = (0.1, 0.5, 0.9)
POP_COLS = [f"pop_mmi{k}" for k in range(4, 11)]
BASE_FEATURES = [f"log_{c}" for c in POP_COLS] + [
    "magnitude", "depth_km", "hour_sin", "hour_cos", "is_night", "income_class", "log_gdp_per_capita"]
ALERT_FEATURES = BASE_FEATURES + ["pager_alert"]
PARAMS = dict(objective="quantile", learning_rate=0.03, n_estimators=600, num_leaves=15,
              min_child_samples=20, subsample=0.8, subsample_freq=1, colsample_bytree=0.8,
              reg_lambda=1.0, n_jobs=2, verbose=-1, random_state=11)
BIN_EDGES = [0, 1, 10, 100, 1_000, 10_000]
BIN_LABELS = ["0", "1-9", "10-99", "100-999", "1,000-9,999", "10,000+"]


def add_features(df):
    df = df.copy()
    for c in POP_COLS:
        df[f"log_{c}"] = np.log1p(df[c].clip(lower=0))
    hour = df["local_hour"]
    df["hour_sin"] = np.sin(2 * np.pi * hour / 24)
    df["hour_cos"] = np.cos(2 * np.pi * hour / 24)
    # night = 22:00 to 05:59 local, when most people are indoors and asleep
    df["is_night"] = np.where(hour.isna(), np.nan, ((hour >= 22) | (hour < 6)).astype(float))
    df["log_gdp_per_capita"] = np.log10(df["gdp_per_capita"])
    return df


def pager_bin(x):
    x = np.asarray(x, dtype=float)
    return np.searchsorted(BIN_EDGES, np.round(x), side="right") - 1


def weighted_median(values, weights):
    order = np.argsort(values)
    v, w = values[order], weights[order]
    cum = np.cumsum(w)
    return float(v[np.searchsorted(cum, cum[-1] / 2)])


def score(y, p10, p50, p90, w):
    y = np.asarray(y, float)
    err = np.abs(np.log10(p50 + 1) - np.log10(y + 1))
    inside = (y >= np.floor(p10)) & (y <= np.ceil(p90))
    same_bin = pager_bin(p50) == pager_bin(y)
    out = {
        "rows": int(len(y)),
        "bin_accuracy": round(float(np.average(same_bin, weights=w)), 4),
        "median_abs_log10_error": round(weighted_median(err, w), 4),
        "interval_80_coverage": round(float(np.average(inside, weights=w)), 4),
    }
    return out


def score_block(frame, target, pred_prefix):
    y = frame[target].to_numpy()
    w = frame["weight"].to_numpy()
    p = [frame[f"{pred_prefix}_p{int(q * 100)}"].to_numpy() for q in QUANTILES]
    block = {"all_rows_weighted": score(y, *p, w)}
    pos = y > 0
    if pos.any():
        block["rows_above_zero"] = score(y[pos], *(a[pos] for a in p), np.ones(pos.sum()))
    return block


def fit_quantiles(X, y, w):
    models = {}
    for q in QUANTILES:
        m = lgb.LGBMRegressor(alpha=q, **PARAMS)
        m.fit(X, y, sample_weight=w)
        models[q] = m
    return models


def predict_sorted(models, X):
    raw = np.column_stack([models[q].predict(X) for q in QUANTILES])
    # quantile boosters are fitted separately and can cross; sorting restores p10 <= p50 <= p90
    raw = np.sort(raw, axis=1)
    return np.clip(np.expm1(raw), 0, None)


def cross_validate(train, features, target, folds=5):
    rows = train[train[target].notna()].copy()
    X = rows[features]
    y = np.log1p(rows[target].to_numpy())
    w = rows["weight"].to_numpy()
    oof = np.zeros((len(rows), len(QUANTILES)))
    for fit_idx, test_idx in GroupKFold(n_splits=folds).split(X, y, rows["sequence"]):
        models = fit_quantiles(X.iloc[fit_idx], y[fit_idx], w[fit_idx])
        oof[test_idx] = predict_sorted(models, X.iloc[test_idx])
    for k, q in enumerate(QUANTILES):
        rows[f"pred_p{int(q * 100)}"] = oof[:, k]
    return rows


def pager_baseline(frame):
    """USGS PAGER empirical fatality model with the epicentre country's theta/beta applied to the
    whole exposure. Approximate: the real model splits exposure by country."""
    root = ET.parse(CATALOGS / "fatality.xml").getroot()
    params = {m.attrib["ccode"]: (float(m.attrib["theta"]), float(m.attrib["beta"])) for m in root.iter("model")}
    meta = json.loads((CATALOGS / "wb_countries.json").read_text())[1]
    iso3_to_2 = {m["id"]: m["iso2Code"] for m in meta}
    out = np.full(len(frame), np.nan)
    for i, (iso3, pops) in enumerate(zip(frame["iso3"], frame[POP_COLS].to_numpy())):
        tb = params.get(iso3_to_2.get(iso3, ""))
        if not tb:
            continue
        theta, beta = tb
        mmi = np.arange(4, 11)
        rates = 0.5 * (1 + np.vectorize(math.erf)(np.log(mmi / theta) / beta / math.sqrt(2)))
        out[i] = float(np.sum(pops * rates))
    return out


def main():
    started = time.time()
    table = pd.read_csv(ARTIFACTS / "training_table.csv.gz", parse_dates=["time"])
    table = add_features(table)
    train = table[table["holdout"].isna()].copy()
    DERIVED.mkdir(parents=True, exist_ok=True)

    metrics = {"quantiles": list(QUANTILES), "params": {k: v for k, v in PARAMS.items() if k != "verbose"},
               "cv": {}, "target_transform": "log1p", "folds": "5-fold GroupKFold by earthquake sequence"}
    oof_frames = {}
    for variant, feats in (("without_pager_alert", BASE_FEATURES), ("with_pager_alert", ALERT_FEATURES)):
        metrics["cv"][variant] = {}
        for target in ("deaths", "injured"):
            print(f"cv {variant} {target}", flush=True)
            rows = cross_validate(train, feats, target)
            metrics["cv"][variant][target] = score_block(rows, target, "pred")
            oof_frames[(variant, target)] = rows

    deaths_cv = oof_frames[("without_pager_alert", "deaths")]
    deaths_cv["baseline"] = pager_baseline(deaths_cv)
    has_base = deaths_cv["baseline"].notna()
    base_rows = deaths_cv[has_base]
    base_block = {}
    for label, part in (("all_rows", base_rows), ("from_2008", base_rows[base_rows["source"] == "comcat"])):
        y = part["deaths"].to_numpy()
        b = part["baseline"].to_numpy()
        m = part["pred_p50"].to_numpy()
        w = part["weight"].to_numpy()
        pos = y > 0
        base_block[label] = {
            "rows": int(len(part)),
            "baseline_bin_accuracy": round(float(np.average(pager_bin(b) == pager_bin(y), weights=w)), 4),
            "model_bin_accuracy": round(float(np.average(pager_bin(m) == pager_bin(y), weights=w)), 4),
            "baseline_median_abs_log10_error_deaths_gt0": round(float(np.median(
                np.abs(np.log10(b[pos] + 1) - np.log10(y[pos] + 1)))), 4) if pos.any() else None,
            "model_median_abs_log10_error_deaths_gt0": round(float(np.median(
                np.abs(np.log10(m[pos] + 1) - np.log10(y[pos] + 1)))), 4) if pos.any() else None,
        }
    metrics["cv_vs_pager_baseline"] = {
        "note": "Baseline = PAGER empirical model with the epicentre country's parameters on the total "
                "exposure (an approximation of the per-country original). The baseline was calibrated on "
                "much of the 1960-2007 catalogue, so its pre-2008 scores are partly in-sample; the from_2008 "
                "rows are the fairer comparison.",
        **base_block,
    }

    a = metrics["cv"]["with_pager_alert"]["deaths"]["rows_above_zero"]
    b = metrics["cv"]["without_pager_alert"]["deaths"]["rows_above_zero"]
    clearly_better = (b["median_abs_log10_error"] - a["median_abs_log10_error"] >= 0.1
                      and a["bin_accuracy"] - b["bin_accuracy"] >= 0.02
                      and a["interval_80_coverage"] >= b["interval_80_coverage"] - 0.02)
    default = "with_pager_alert" if clearly_better else "without_pager_alert"
    metrics["default_variant"] = default
    metrics["default_reason"] = (
        "pager_alert improved out-of-fold error on deadly events by >= 0.1 log10 and bin accuracy by >= 2 "
        "points without losing coverage" if clearly_better else
        "pager_alert did not clearly beat the model without it on out-of-fold deadly events (needs >= 0.1 "
        "log10 lower error and >= 2 points bin accuracy), and PAGER's alert can be revised after the fact, "
        "so the default leaves it out")
    feats = ALERT_FEATURES if clearly_better else BASE_FEATURES

    files = {}
    for target in ("deaths", "injured"):
        rows = train[train[target].notna()]
        models = fit_quantiles(rows[feats], np.log1p(rows[target].to_numpy()), rows["weight"].to_numpy())
        for q, m in models.items():
            name = f"model_{target}_p{int(q * 100)}.txt"
            m.booster_.save_model(str(ARTIFACTS / name))
            files[name] = {"target": target, "quantile": q, "rows": int(len(rows))}
        other = ALERT_FEATURES if feats is BASE_FEATURES else BASE_FEATURES
        alt = fit_quantiles(rows[other], np.log1p(rows[target].to_numpy()), rows["weight"].to_numpy())
        alt_dir = DERIVED / "models_other_variant"
        alt_dir.mkdir(parents=True, exist_ok=True)
        for q, m in alt.items():
            m.booster_.save_model(str(alt_dir / f"model_{target}_p{int(q * 100)}.txt"))

    for (variant, target), rows in oof_frames.items():
        keep = ["event_id", "source", "time", "iso3", "region", "income_class", "weight", target,
                "pred_p10", "pred_p50", "pred_p90"] + (["baseline"] if "baseline" in rows else [])
        rows[keep].to_csv(DERIVED / f"cv_{variant}_{target}.csv.gz", index=False)

    (ARTIFACTS / "features.json").write_text(json.dumps({
        "features": feats,
        "variant": default,
        "other_variant_features": ALERT_FEATURES if feats is BASE_FEATURES else BASE_FEATURES,
        "model_files": files,
        "target": "log1p of the count; predictions are expm1 of the sorted quantiles, clipped at 0",
        "preprocessing": {
            "log_pop_mmiK": "log1p(people exposed to integer MMI K, i.e. K-0.5 <= MMI < K+0.5)",
            "hour_sin/hour_cos": "local hour of day on a 24 h circle",
            "is_night": "1 if local time is 22:00-05:59",
            "income_class": "World Bank class: 0 low, 1 lower-middle, 2 upper-middle, 3 high",
            "log_gdp_per_capita": "log10 of World Bank GDP per capita (current US$), year before the event",
            "pager_alert": "PAGER fatality alert: 0 green, 1 yellow, 2 orange, 3 red",
            "missing": "left as NaN; LightGBM routes missing values",
        },
        "rows_trained": {t: int(train[t].notna().sum()) for t in ("deaths", "injured")},
    }, indent=2))

    metrics["wall_seconds"] = round(time.time() - started, 1)
    (ARTIFACTS / "metrics.json").write_text(json.dumps(metrics, indent=2))
    print(json.dumps(metrics["cv"], indent=2))
    print("default:", default)


if __name__ == "__main__":
    main()
