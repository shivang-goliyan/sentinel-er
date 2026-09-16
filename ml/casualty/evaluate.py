"""Hold-out results, contributions, bias checks, the injury ratio, and the charts.

Run after train.py. Writes holdout.json, bias.json, charts/*.png + charts/*.json, and adds the
hold-out verdict and injury ratio to metrics.json.
"""

import json
import math
import xml.etree.ElementTree as ET
from pathlib import Path

import lightgbm as lgb
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

from build_dataset import HOLDOUTS, PAGER_DIR, parse_pager_xml  # noqa: E402
from train import (ARTIFACTS, CATALOGS, DERIVED, QUANTILES, add_features, pager_bin,  # noqa: E402
                   weighted_median)

CHARTS = ARTIFACTS / "charts"

# the figures USGS/NCEI match on are per mainshock record; the official ones cover the whole sequence
OFFICIAL = {
    "turkey-2023": {
        "deaths": 53537, "injured": 107213,
        "label": "Türkiye official, Feb 2024 (whole sequence, Türkiye only)",
        "source": "https://turkishminute.com/2024/02/02/turkey-revised-its-2023-earthquake-death-toll-53537/",
        "deaths_with_syria": 59488,
    },
    "nepal-2015": {
        "deaths": 8790, "injured": 22300,
        "label": "Nepal Post Disaster Needs Assessment (includes the 12 May aftershock)",
        "source": "https://www.gfdrr.org/sites/default/files/publication/pda-2015-nepal-vola.pdf",
    },
}
INCOME_NAMES = {0: "Low", 1: "Lower-middle", 2: "Upper-middle", 3: "High"}

BG = "#0e1116"
FG = "#e6e9ef"
MUTED = "#8a93a6"
ACCENT = "#4cc9f0"
TRUTH = "#f4a261"
BASE = "#b392f0"
GRID = "#262b36"


def style():
    plt.rcParams.update({
        "figure.facecolor": BG, "axes.facecolor": BG, "savefig.facecolor": BG,
        "axes.edgecolor": GRID, "axes.labelcolor": FG, "xtick.color": MUTED, "ytick.color": MUTED,
        "text.color": FG, "font.size": 13, "axes.titlesize": 16, "axes.titleweight": "bold",
        "axes.grid": True, "grid.color": GRID, "grid.linewidth": 0.8, "legend.frameon": False,
        "font.family": "DejaVu Sans",
    })


def fatality_params():
    root = ET.parse(CATALOGS / "fatality.xml").getroot()
    return {m.attrib["ccode"]: (float(m.attrib["theta"]), float(m.attrib["beta"])) for m in root.iter("model")}


def pager_rates(theta, beta):
    return np.array([0.5 * (1 + math.erf(math.log(s / theta) / beta / math.sqrt(2))) for s in range(1, 11)])


def baseline_turkey(params):
    exp = json.loads((PAGER_DIR / "raw" / "us6000jllz.exposures.json").read_text())
    per_country = {}
    for c in exp["population_exposure"]["country_exposures"]:
        tb = params.get(c["country_code"])
        if tb:
            per_country[c["country_code"]] = float(np.dot(np.asarray(c["exposure"], float), pager_rates(*tb)))
    tr = int(round(per_country["TR"]))
    assert tr == 21546, f"PAGER baseline for Turkey came out {tr}, USGS published 21,546"
    return float(sum(per_country.values())), {"TR": tr, "total_all_countries": round(sum(per_country.values()))}


def baseline_nepal(params):
    parsed = parse_pager_xml((PAGER_DIR / "raw" / "us20002926.pager.xml").read_bytes())
    pops = np.array([parsed[f"pop_mmi{k}"] for k in range(1, 11)], float)
    total = float(np.dot(pops, pager_rates(*params["NP"])))
    return total, {"NP_params_on_total_exposure": round(total),
                   "note": "the 2015 PAGER file has no per-country split, so Nepal's parameters are applied "
                           "to all exposed people"}


def load_models(folder, target):
    return {q: lgb.Booster(model_file=str(folder / f"model_{target}_p{int(q * 100)}.txt")) for q in QUANTILES}


def predict(models, X):
    raw = np.sort(np.column_stack([models[q].predict(X) for q in QUANTILES]), axis=1)
    return np.clip(np.expm1(raw), 0, None)


def log_error(pred, truth):
    return abs(math.log10(pred + 1) - math.log10(truth + 1))


def main():
    style()
    CHARTS.mkdir(parents=True, exist_ok=True)
    feat_info = json.loads((ARTIFACTS / "features.json").read_text())
    feats = feat_info["features"]
    other_feats = feat_info["other_variant_features"]
    metrics = json.loads((ARTIFACTS / "metrics.json").read_text())
    table = add_features(pd.read_csv(ARTIFACTS / "training_table.csv.gz", parse_dates=["time"]))
    params = fatality_params()

    models = {t: load_models(ARTIFACTS, t) for t in ("deaths", "injured")}
    other = {t: load_models(DERIVED / "models_other_variant", t) for t in ("deaths", "injured")}
    baselines = {"turkey-2023": baseline_turkey(params), "nepal-2015": baseline_nepal(params)}

    holdout = {"variant": feat_info["variant"], "events": {}}
    for name, h in HOLDOUTS.items():
        row = table[table["event_id"] == h["id"]]
        assert len(row) == 1, f"holdout {h['id']} missing from the training table"
        X = row[feats]
        entry = {"event_id": h["id"], "magnitude": float(row["magnitude"].iloc[0]),
                 "ncei_id": row["ncei_id"].iloc[0] if "ncei_id" in row else None}
        for target in ("deaths", "injured"):
            p = predict(models[target], X)[0]
            po = predict(other[target], row[other_feats])[0]
            truth = float(row[target].iloc[0]) if pd.notna(row[target].iloc[0]) else None
            entry[target] = {
                "p10": round(p[0]), "p50": round(p[1]), "p90": round(p[2]),
                "ncei": truth,
                "official": OFFICIAL[name][target],
                "inside_p10_p90": bool(truth is not None and p[0] <= truth <= p[2]),
                "same_pager_bin": bool(truth is not None and pager_bin(p[1]) == pager_bin(truth)),
                "log10_error_p50": round(log_error(p[1], truth), 3) if truth is not None else None,
                "other_variant": {"p10": round(po[0]), "p50": round(po[1]), "p90": round(po[2])},
            }
        base_total, base_detail = baselines[name]
        entry["deaths"]["pager_baseline"] = round(base_total)
        entry["deaths"]["pager_baseline_detail"] = base_detail
        truth = entry["deaths"]["ncei"]
        entry["deaths"]["baseline_log10_error"] = round(log_error(base_total, truth), 3)
        entry["deaths"]["model_beats_baseline"] = entry["deaths"]["log10_error_p50"] < entry["deaths"]["baseline_log10_error"]
        entry["official_note"] = OFFICIAL[name]["label"]
        entry["official_source"] = OFFICIAL[name]["source"]

        booster = models["deaths"][0.5]
        contrib = booster.predict(X, pred_contrib=True)[0]
        pairs = sorted(zip(feats, contrib[:-1], X.iloc[0].tolist()), key=lambda t: -abs(t[1]))
        entry["contributions_p50_deaths"] = {
            "base_value_log1p": round(float(contrib[-1]), 4),
            "prediction_log1p": round(float(contrib.sum()), 4),
            "top": [{"feature": f, "contribution_log1p": round(float(c), 4),
                     "value": None if v is None or (isinstance(v, float) and math.isnan(v)) else round(float(v), 4)}
                    for f, c, v in pairs[:8]],
        }
        holdout["events"][name] = entry
    (ARTIFACTS / "holdout.json").write_text(json.dumps(holdout, indent=2, default=str))

    # bias on out-of-fold predictions of the default variant
    cv = pd.read_csv(DERIVED / f"cv_{feat_info['variant']}_deaths.csv.gz")
    cv["residual_log10"] = np.log10(cv["pred_p50"] + 1) - np.log10(cv["deaths"] + 1)
    cv["inside"] = (cv["deaths"] >= np.floor(cv["pred_p10"])) & (cv["deaths"] <= np.ceil(cv["pred_p90"]))
    cv["same_bin"] = pager_bin(cv["pred_p50"]) == pager_bin(cv["deaths"])
    cv["income"] = cv["income_class"].map(INCOME_NAMES).fillna("Unknown")

    def summarise(frame, key):
        out = {}
        for k, part in frame.groupby(key):
            deadly = part[part["deaths"] > 0]
            out[str(k)] = {
                "rows": int(len(part)),
                "rows_with_deaths": int(len(deadly)),
                "coverage_weighted": round(float(np.average(part["inside"], weights=part["weight"])), 3),
                "bin_accuracy_weighted": round(float(np.average(part["same_bin"], weights=part["weight"])), 3),
                "median_residual_log10_deadly": round(float(deadly["residual_log10"].median()), 3) if len(deadly) else None,
                "coverage_deadly": round(float(deadly["inside"].mean()), 3) if len(deadly) else None,
            }
        return out

    bias = {
        "what": "out-of-fold p50 deaths vs recorded deaths; residual > 0 means the model over-predicts",
        "by_income_class": summarise(cv, "income"),
        "by_region": summarise(cv, "region"),
    }
    (ARTIFACTS / "bias.json").write_text(json.dumps(bias, indent=2))

    # injury ratio: log1p(injured) ~ log1p(deaths) + income class
    train = table[table["holdout"].isna() & table["injured"].notna() & table["income_class"].notna()]
    X = np.column_stack([np.ones(len(train)), np.log1p(train["deaths"].to_numpy()),
                         *[(train["income_class"] == k).astype(float).to_numpy() for k in (1, 2, 3)]])
    y = np.log1p(train["injured"].to_numpy())
    coef, *_ = np.linalg.lstsq(X, y, rcond=None)
    resid = y - X @ coef
    r2 = 1 - resid.var() / y.var()
    injury_ratio = {
        "formula": "log1p(injured) = a + b*log1p(deaths) + c_LM + c_UM + c_H (low income is the reference)",
        "a": round(float(coef[0]), 4), "b": round(float(coef[1]), 4),
        "c_lower_middle": round(float(coef[2]), 4), "c_upper_middle": round(float(coef[3]), 4),
        "c_high": round(float(coef[4]), 4),
        "rows": int(len(train)), "r2": round(float(r2), 3), "residual_sd": round(float(resid.std()), 3),
    }

    both_beat = all(e["deaths"]["model_beats_baseline"] for e in holdout["events"].values())
    any_beat = any(e["deaths"]["model_beats_baseline"] for e in holdout["events"].values())
    metrics["holdout_verdict"] = (
        "The model's p50 deaths is closer to NCEI than the PAGER empirical baseline on both hold-outs."
        if both_beat else
        "The model's p50 deaths beats the PAGER empirical baseline on one hold-out but not the other."
        if any_beat else
        "The model's p50 deaths does NOT beat the PAGER empirical baseline on the hold-outs.")
    metrics["holdout_summary"] = {
        n: {t: {k: e[t][k] for k in ("p10", "p50", "p90", "ncei", "inside_p10_p90")} for t in ("deaths", "injured")}
        | {"pager_baseline_deaths": e["deaths"]["pager_baseline"]}
        for n, e in holdout["events"].items()
    }
    metrics["injury_ratio"] = injury_ratio
    (ARTIFACTS / "metrics.json").write_text(json.dumps(metrics, indent=2))

    chart_holdout(holdout)
    chart_calibration(cv)
    chart_bias(bias)
    chart_contributions(holdout)
    print(metrics["holdout_verdict"])
    print(json.dumps(metrics["holdout_summary"], indent=2))


def save_chart(fig, name, data):
    fig.savefig(CHARTS / f"{name}.png", dpi=200, bbox_inches="tight")
    plt.close(fig)
    (CHARTS / f"{name}.json").write_text(json.dumps(data, indent=2, default=str))


def chart_holdout(holdout):
    names = {"turkey-2023": "Türkiye 2023 · M7.8", "nepal-2015": "Nepal 2015 · M7.8"}
    fig, axes = plt.subplots(1, 2, figsize=(14, 5.2))
    data = []
    for ax, target in zip(axes, ("deaths", "injured")):
        for i, (key, e) in enumerate(holdout["events"].items()):
            d = e[target]
            yv = len(holdout["events"]) - 1 - i
            ax.plot([max(d["p10"], 1), max(d["p90"], 1)], [yv, yv], color=ACCENT, lw=10, alpha=0.35,
                    solid_capstyle="round", label="model 10–90%" if i == 0 else None)
            ax.scatter([max(d["p50"], 1)], [yv], color=ACCENT, s=140, zorder=3, label="model median" if i == 0 else None)
            if d["ncei"]:
                ax.scatter([d["ncei"]], [yv], marker="D", color=TRUTH, s=110, zorder=4,
                           label="recorded (NOAA NCEI)" if i == 0 else None)
            if target == "deaths":
                ax.scatter([d["pager_baseline"]], [yv], marker="s", color=BASE, s=90, zorder=4,
                           label="USGS PAGER empirical model" if i == 0 else None)
            data.append({"event": key, "target": target, **{k: d.get(k) for k in
                         ("p10", "p50", "p90", "ncei", "official", "pager_baseline")}})
        ax.set_xscale("log")
        ax.set_yticks(range(len(holdout["events"])))
        ax.set_yticklabels([names[k] for k in reversed(list(holdout["events"]))])
        ax.set_title("Deaths" if target == "deaths" else "Injured")
        ax.set_ylim(-0.7, len(holdout["events"]) - 0.3)
        ax.grid(axis="y", visible=False)
    axes[0].legend(loc="lower center", bbox_to_anchor=(1.05, -0.32), ncol=4, fontsize=11)
    fig.suptitle("Held-out earthquakes the model never saw", fontsize=18, fontweight="bold", y=1.02)
    save_chart(fig, "holdout", data)


def chart_calibration(cv):
    deadly = cv[cv["deaths"] > 0]
    fig, ax = plt.subplots(figsize=(7.5, 7))
    lim = [1, max(deadly["deaths"].max(), deadly["pred_p50"].max()) * 2]
    ax.fill_between(lim, [lim[0] / 10, lim[1] / 10], [lim[0] * 10, lim[1] * 10], color=ACCENT, alpha=0.08,
                    label="within 10×")
    ax.plot(lim, lim, color=MUTED, lw=1, ls="--")
    ax.scatter(deadly["deaths"], deadly["pred_p50"].clip(lower=1), s=14, color=ACCENT, alpha=0.6)
    ax.set_xscale("log")
    ax.set_yscale("log")
    ax.set_xlim(lim)
    ax.set_ylim(lim)
    ax.set_xlabel("recorded deaths")
    ax.set_ylabel("predicted deaths (median, out of fold)")
    ax.set_title(f"Cross-validated, {len(deadly):,} deadly earthquakes")
    ax.legend(loc="upper left")
    save_chart(fig, "cv_calibration", deadly[["event_id", "deaths", "pred_p10", "pred_p50", "pred_p90"]]
               .to_dict(orient="records"))


def chart_bias(bias):
    groups = bias["by_income_class"]
    order = [k for k in ("Low", "Lower-middle", "Upper-middle", "High", "Unknown") if k in groups]
    cover = [groups[k]["coverage_deadly"] or 0 for k in order]
    resid = [groups[k]["median_residual_log10_deadly"] or 0 for k in order]
    fig, axes = plt.subplots(1, 2, figsize=(13, 4.8))
    axes[0].bar(order, cover, color=ACCENT)
    axes[0].axhline(0.8, color=TRUTH, ls="--", lw=1.2, label="target 80%")
    axes[0].set_ylim(0, 1)
    axes[0].set_title("Interval coverage, deadly events")
    axes[0].legend()
    axes[1].bar(order, resid, color=[BASE if r > 0 else ACCENT for r in resid])
    axes[1].axhline(0, color=MUTED, lw=1)
    axes[1].set_title("Median error (log10), deadly events")
    axes[1].set_ylabel("over-predicts ↑   under-predicts ↓")
    for ax in axes:
        ax.tick_params(axis="x", rotation=15)
        ax.grid(axis="x", visible=False)
    fig.suptitle("Does the model treat poorer and richer countries alike?", fontsize=17, fontweight="bold", y=1.03)
    save_chart(fig, "bias", {k: groups[k] for k in order})


def chart_contributions(holdout):
    pretty = {
        "log_pop_mmi9": "people at MMI 9", "log_pop_mmi8": "people at MMI 8", "log_pop_mmi7": "people at MMI 7",
        "log_pop_mmi6": "people at MMI 6", "log_pop_mmi5": "people at MMI 5", "log_pop_mmi4": "people at MMI 4",
        "log_pop_mmi10": "people at MMI 10", "magnitude": "magnitude", "depth_km": "depth",
        "hour_sin": "time of day", "hour_cos": "time of day (cos)", "is_night": "night-time",
        "income_class": "country income class", "log_gdp_per_capita": "GDP per capita",
        "pager_alert": "PAGER alert",
    }
    e = holdout["events"]["turkey-2023"]["contributions_p50_deaths"]
    top = e["top"][:6][::-1]
    fig, ax = plt.subplots(figsize=(10, 5))
    ax.barh([pretty.get(t["feature"], t["feature"]) for t in top], [t["contribution_log1p"] for t in top],
            color=[ACCENT if t["contribution_log1p"] > 0 else BASE for t in top])
    ax.axvline(0, color=MUTED, lw=1)
    ax.set_xlabel("push on predicted deaths (log scale)")
    ax.set_title("Why the model predicted what it did — Türkiye 2023")
    ax.grid(axis="y", visible=False)
    save_chart(fig, "contributions_turkey", e)


if __name__ == "__main__":
    main()
