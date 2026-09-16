"""Cross-validate and train the casualty quantile models.

Reads artifacts/training_table.csv.gz (from build_dataset.py). Writes the six default boosters,
country_factors.json, features.json and metrics.json to artifacts/, and out-of-fold predictions to
data/raw/derived/ for evaluate.py.
"""

import json
import math
import time
import xml.etree.ElementTree as ET
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.model_selection import GroupKFold

from casualty_model import (ALERT_FEATURES, BASE_FEATURES, FACTOR_PRIOR, POP_COLS, QUANTILES, add_features,
                            apply_factors, fit_quantiles, global_curve, learn_factors, predict_quantiles)

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
ARTIFACTS = HERE / "artifacts"
DERIVED = REPO / "data" / "raw" / "derived"
CATALOGS = REPO / "data" / "raw" / "catalogs"
TARGETS = ("deaths", "injured")

PARAMS = dict(objective="quantile", learning_rate=0.05, n_estimators=600, num_leaves=15,
              min_child_samples=20, subsample=0.8, subsample_freq=1, colsample_bytree=0.8,
              reg_lambda=1.0, n_jobs=2, verbose=-1, random_state=11)
BIN_EDGES = [0, 1, 10, 100, 1_000, 10_000]
BIN_LABELS = ["0", "1-9", "10-99", "100-999", "1,000-9,999", "10,000+"]


def pager_bin(x):
    x = np.asarray(x, dtype=float)
    return np.searchsorted(BIN_EDGES, np.round(x), side="right") - 1


def weighted_median(values, weights):
    order = np.argsort(values)
    v, w = np.asarray(values)[order], np.asarray(weights)[order]
    cum = np.cumsum(w)
    return float(v[np.searchsorted(cum, cum[-1] / 2)])


def pinball(y, p10, p50, p90):
    ly = np.log1p(y)
    total = 0.0
    for q, p in zip(QUANTILES, (p10, p50, p90)):
        d = ly - np.log1p(p)
        total = total + np.maximum(q * d, (q - 1) * d)
    return total / len(QUANTILES)


def score(y, p10, p50, p90, w):
    y = np.asarray(y, float)
    err = np.abs(np.log10(p50 + 1) - np.log10(y + 1))
    inside = (y >= np.floor(p10)) & (y <= np.ceil(p90))
    return {
        "rows": int(len(y)),
        "bin_accuracy": round(float(np.average(pager_bin(p50) == pager_bin(y), weights=w)), 4),
        "median_abs_log10_error": round(weighted_median(err, w), 4),
        "mean_abs_log10_error": round(float(np.average(err, weights=w)), 4),
        "interval_80_coverage": round(float(np.average(inside, weights=w)), 4),
        "pinball_log1p": round(float(np.average(pinball(y, p10, p50, p90), weights=w)), 4),
    }


def score_block(frame, target, prefix="pred"):
    y = frame[target].to_numpy()
    w = frame["weight"].to_numpy()
    p = [frame[f"{prefix}_p{int(q * 100)}"].to_numpy() for q in QUANTILES]
    block = {"all_rows_weighted": score(y, *p, w)}
    for label, mask in (("rows_above_zero", y > 0), ("rows_1000_plus", y >= 1000)):
        if mask.any():
            block[label] = score(y[mask], *(a[mask] for a in p), np.ones(mask.sum()))
    return block


def drop_booked_elsewhere(train):
    """NCEI books a sequence's deaths to its mainshock, so a strong aftershock often shows 0 deaths
    it did not really have. Those zeros are dropped when the sequence's largest event killed people;
    secondary events with deaths of their own stay."""
    largest = train.groupby("sequence")["magnitude"].transform("max")
    main_deaths = train.assign(_main=np.where(train["magnitude"] == largest, train["deaths"], 0.0)) \
        .groupby("sequence")["_main"].transform("max")
    drop = (train["magnitude"] < largest) & (train["deaths"] == 0) & (main_deaths > 0)
    return train[~drop].reset_index(drop=True), int(drop.sum())


def prior_shift(rows, target):
    """How far the target sits above the deaths prior, typically. 0 for deaths; for injuries the
    median gap among rows with recorded injuries."""
    if target == "deaths":
        return 0.0
    known = rows[rows[target].notna()]
    return float(np.median(np.log1p(known[target]) - known["prior_log1p"]))


def cross_validate(train, features, target, folds=5):
    rows = train[train[target].notna()].reset_index(drop=True)
    oof = np.zeros((len(rows), len(QUANTILES)))
    prior_only = np.zeros(len(rows))
    for fit_idx, test_idx in GroupKFold(n_splits=folds).split(rows, groups=rows["sequence"]):
        # factors come from the fitting folds only, so the held-out fold never sees its own deaths
        factors = learn_factors(train[~train["sequence"].isin(rows.loc[test_idx, "sequence"])])
        fit = apply_factors(rows.iloc[fit_idx], factors)
        test = apply_factors(rows.iloc[test_idx], factors)
        shift = prior_shift(fit, target)
        models = fit_quantiles(fit[features], np.log1p(fit[target].to_numpy()), fit["weight"].to_numpy(),
                               fit["prior_log1p"].to_numpy() + shift, PARAMS)
        oof[test_idx] = predict_quantiles(models, test[features], test["prior_log1p"].to_numpy() + shift)
        prior_only[test_idx] = np.expm1(test["prior_log1p"].to_numpy() + shift)
    for k, q in enumerate(QUANTILES):
        rows[f"pred_p{int(q * 100)}"] = oof[:, k]
    rows["prior_only"] = prior_only
    return rows


def pager_baseline(frame):
    """USGS PAGER empirical fatality model with the epicentre country's theta/beta applied to the
    whole exposure. Approximate: the real model splits exposure by country."""
    root = ET.parse(CATALOGS / "fatality.xml").getroot()
    params = {m.attrib["ccode"]: (float(m.attrib["theta"]), float(m.attrib["beta"])) for m in root.iter("model")}
    meta = json.loads((CATALOGS / "wb_countries.json").read_text())[1]
    iso3_to_2 = {m["id"]: m["iso2Code"] for m in meta}
    out = np.full(len(frame), np.nan)
    mmi = np.arange(4, 11)
    for i, (iso3, pops) in enumerate(zip(frame["iso3"], frame[POP_COLS].to_numpy(dtype=float))):
        tb = params.get(iso3_to_2.get(iso3, ""))
        if tb:
            theta, beta = tb
            rates = np.array([0.5 * (1 + math.erf(math.log(s / theta) / beta / math.sqrt(2))) for s in mmi])
            out[i] = float(np.sum(pops * rates))
    return out


def compare_with_baseline(cv):
    cv = cv.copy()
    cv["baseline"] = pager_baseline(cv)
    out = {}
    have = cv[cv["baseline"].notna()]
    for label, part in (("all_rows", have), ("from_2008", have[have["source"] == "comcat"])):
        y = part["deaths"].to_numpy()
        w = part["weight"].to_numpy()
        entry = {"rows": int(len(part))}
        for name, pred in (("model_p50", part["pred_p50"]), ("prior_only", part["prior_only"]),
                           ("pager_baseline", part["baseline"])):
            pred = pred.to_numpy()
            err = np.abs(np.log10(pred + 1) - np.log10(y + 1))
            entry[name] = {
                "bin_accuracy_weighted": round(float(np.average(pager_bin(pred) == pager_bin(y), weights=w)), 4),
                "median_abs_log10_error_deadly": round(float(np.median(err[y > 0])), 4) if (y > 0).any() else None,
                "mean_abs_log10_error_1000_plus": round(float(err[y >= 1000].mean()), 4) if (y >= 1000).any() else None,
            }
        out[label] = entry
    return cv, out


def calibration(cv):
    """Median of log10(truth+1) - log10(prediction+1), grouped by what was known before the fact
    (the prior, and the model's own median). Grouping by the outcome instead would reward
    over-prediction."""
    y = np.log10(cv["deaths"] + 1)
    out = {"note": "median log10 gap, truth minus prediction; 0 = calibrated, +0.3 = truth about 2x higher, "
                   "-1 = truth 10x lower"}
    bands = [(0, 10), (10, 100), (100, 1_000), (1_000, 10_000), (10_000, 1e12)]
    for label, key in (("by_prior", "prior_only"), ("by_model_p50", "pred_p50")):
        rows = {}
        for lo, hi in bands:
            m = (cv[key] >= lo) & (cv[key] < hi)
            if m.sum() == 0:
                continue
            rows[f"{lo:g}-{hi:g}" if hi < 1e12 else f"{lo:g}+"] = {
                "events": int(m.sum()),
                "model_p50_gap": round(float(np.median(y[m] - np.log10(cv.loc[m, "pred_p50"] + 1))), 3),
                "prior_gap": round(float(np.median(y[m] - np.log10(cv.loc[m, "prior_only"] + 1))), 3),
                "inside_p10_p90": round(float(((cv.loc[m, "deaths"] >= np.floor(cv.loc[m, "pred_p10"]))
                                               & (cv.loc[m, "deaths"] <= np.ceil(cv.loc[m, "pred_p90"]))).mean()), 3),
            }
        out[label] = rows
    return out


def main():
    started = time.time()
    theta, beta = global_curve(CATALOGS / "fatality.xml")
    table = add_features(pd.read_csv(ARTIFACTS / "training_table.csv.gz", parse_dates=["time"]), theta, beta)
    train, dropped = drop_booked_elsewhere(table[table["holdout"].isna()].reset_index(drop=True))
    DERIVED.mkdir(parents=True, exist_ok=True)

    metrics = {
        "quantiles": list(QUANTILES),
        "params": {k: v for k, v in PARAMS.items() if k != "verbose"},
        "target_transform": "log1p",
        "structure": "log1p(target_q) = physical prior + LightGBM quantile booster. Prior = people at each "
                     f"MMI x global PAGER curve (theta {theta:.3f}, beta {beta:.3f}, median of USGS fatality.xml), "
                     "x 10^country_factor; injuries add a learned constant shift",
        "folds": "5-fold GroupKFold by earthquake sequence; country/region factors re-learned inside each fold",
        "rows_dropped_deaths_booked_to_mainshock": dropped,
        "drop_rule": "a smaller event in a sequence whose largest event killed people, recorded with 0 deaths "
                     "(NCEI books sequence deaths to the mainshock)",
        "cv": {},
    }
    oof = {}
    for variant, feats in (("without_pager_alert", BASE_FEATURES), ("with_pager_alert", ALERT_FEATURES)):
        metrics["cv"][variant] = {}
        for target in TARGETS:
            print(f"cv {variant} {target}", flush=True)
            rows = cross_validate(train, feats, target)
            metrics["cv"][variant][target] = score_block(rows, target)
            oof[(variant, target)] = rows
    for target in TARGETS:
        rows = oof[("without_pager_alert", target)].assign(prior_p10=lambda d: d["prior_only"],
                                                            prior_p50=lambda d: d["prior_only"],
                                                            prior_p90=lambda d: d["prior_only"])
        metrics["cv"].setdefault("prior_only_reference", {})[target] = score_block(rows, target, "prior")

    cv_deaths, base_block = compare_with_baseline(oof[("without_pager_alert", "deaths")])
    oof[("without_pager_alert", "deaths")] = cv_deaths
    metrics["cv_vs_pager_baseline"] = {
        "note": "pager_baseline = USGS PAGER empirical model with the epicentre country's parameters on the "
                "total exposure (an approximation of the per-country original). USGS calibrated those "
                "parameters on much of the 1960-2007 catalogue, so its pre-2008 scores are partly in-sample; "
                "from_2008 is the fairer comparison. prior_only = our starting point with no booster.",
        **base_block,
    }

    metrics["calibration_deaths"] = calibration(cv_deaths)

    with_alert = metrics["cv"]["with_pager_alert"]["deaths"]["rows_above_zero"]
    without = metrics["cv"]["without_pager_alert"]["deaths"]["rows_above_zero"]
    clearly_better = (without["median_abs_log10_error"] - with_alert["median_abs_log10_error"] >= 0.1
                      and with_alert["bin_accuracy"] - without["bin_accuracy"] >= 0.02
                      and with_alert["interval_80_coverage"] >= without["interval_80_coverage"] - 0.02)
    variant = "with_pager_alert" if clearly_better else "without_pager_alert"
    feats = ALERT_FEATURES if clearly_better else BASE_FEATURES
    other_feats = BASE_FEATURES if clearly_better else ALERT_FEATURES
    metrics["default_variant"] = variant
    metrics["default_reason"] = (
        "pager_alert improved out-of-fold error on deadly events by >= 0.1 log10 and bin accuracy by >= 2 points "
        "without losing coverage" if clearly_better else
        "pager_alert did not clearly beat the model without it on out-of-fold deadly events (the bar: >= 0.1 "
        "log10 lower median error and >= 2 points bin accuracy); PAGER's alert is also revised after the "
        "fact, so the default leaves it out")

    factors = learn_factors(train)
    (ARTIFACTS / "country_factors.json").write_text(json.dumps({
        "rule": f"log10((recorded deaths + {FACTOR_PRIOR}) / (curve-expected deaths + {FACTOR_PRIOR})) over the "
                "training rows; countries with no history fall back to their World Bank region, then 0",
        **factors,
    }, indent=2))
    ready = apply_factors(train, factors)
    files, shifts = {}, {}
    alt_dir = DERIVED / "models_other_variant"
    alt_dir.mkdir(parents=True, exist_ok=True)
    for target in TARGETS:
        rows = ready[ready[target].notna()]
        shifts[target] = prior_shift(rows, target)
        y = np.log1p(rows[target].to_numpy())
        init = rows["prior_log1p"].to_numpy() + shifts[target]
        for folder, use in ((ARTIFACTS, feats), (alt_dir, other_feats)):
            models = fit_quantiles(rows[use], y, rows["weight"].to_numpy(), init, PARAMS)
            for q, booster in models.items():
                name = f"model_{target}_p{int(q * 100)}.txt"
                booster.save_model(str(folder / name))
                if folder == ARTIFACTS:
                    files[name] = {"target": target, "quantile": q, "rows": int(len(rows))}

    for (v, target), rows in oof.items():
        keep = ["event_id", "source", "time", "iso3", "region", "income_class", "weight", target,
                "pred_p10", "pred_p50", "pred_p90", "prior_only"] + (["baseline"] if "baseline" in rows else [])
        rows[keep].to_csv(DERIVED / f"cv_{v}_{target}.csv.gz", index=False)

    (ARTIFACTS / "features.json").write_text(json.dumps({
        "features": feats,
        "variant": variant,
        "other_variant_features": other_feats,
        "model_files": files,
        "prior": {"theta": theta, "beta": beta, "shift_log1p": shifts, "factor_prior": FACTOR_PRIOR},
        "predict": "log1p(target_q) = booster_q(features) + log1p(global_expected * 10^country_factor) + "
                   "shift_log1p[target]; quantiles sorted, expm1, clipped at 0 (see casualty_model.py)",
        "preprocessing": {
            "log_pop_mmiK": "log1p(people exposed to integer MMI K, i.e. K-0.5 <= MMI < K+0.5)",
            "hour_sin/hour_cos": "local hour of day on a 24 h circle",
            "is_night": "1 if local time is 22:00-05:59",
            "income_class": "World Bank class: 0 low, 1 lower-middle, 2 upper-middle, 3 high",
            "log_gdp_per_capita": "log10 of World Bank GDP per capita (current US$), year before the event",
            "log_global_expected": "log1p(sum over MMI 4-10 of people x global PAGER fatality rate)",
            "country_factor/region_factor": "see country_factors.json",
            "pager_alert": "PAGER fatality alert: 0 green, 1 yellow, 2 orange, 3 red",
            "missing": "left as NaN; LightGBM routes missing values",
        },
        "rows_trained": {t: int(train[t].notna().sum()) for t in TARGETS},
    }, indent=2))

    metrics["wall_seconds"] = round(time.time() - started, 1)
    (ARTIFACTS / "metrics.json").write_text(json.dumps(metrics, indent=2))
    print(json.dumps({v: {t: metrics["cv"][v][t].get("rows_above_zero") for t in TARGETS}
                      for v in metrics["cv"]}, indent=1))
    print(json.dumps(metrics["cv_vs_pager_baseline"], indent=1))
    print("default:", variant)


if __name__ == "__main__":
    main()
