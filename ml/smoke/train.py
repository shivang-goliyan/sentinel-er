"""Fit the smoke correction on NYC with 2023 held out, then check it on June 2023.

Steps
1. Leave-one-year-out CV on training years picks the exposure form and season option, and whether
   the learned correction beats the literature term alone.
2. Final fits on every training day (all years but 2023).
3. June 2023: predict asthma ED visits from air quality alone and compare with what happened.

Writes ml/smoke/artifacts/{coefficients,metrics}.json and charts/validation_june2023.{json,png}.
"""

import json
import math
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

import smoke_data as sd
import smoke_model as sm_
from smoke_model import BETA_LIT, LIT, SE_LIT, TERMS

HERE = Path(__file__).resolve().parent
ART = HERE / "artifacts"
CHARTS = ART / "charts"

HOLD_OUT = 2023
TREND_DF = 8
FORMS = ["linear", "log"]
SEASONS = ["all", "warm"]
KINDS = ["literature", "corrected"]
# 2016 and 2026 sit on the spline's edges; 2020-21 carry the pandemic flags
CV_YEARS = [2017, 2018, 2019, 2022, 2024, 2025]
SMOKE_DAY = 5.0
EPISODE = ("2023-06-06", "2023-06-08")
PEAK = "2023-06-07"
WINDOW = ("2023-05-20", "2023-06-30")
DRAWS = 4000


def clean(df: pd.DataFrame) -> pd.DataFrame:
    return df.dropna(subset=["y", "tmax", *TERMS])


def cross_validate(table: pd.DataFrame, smoke_days: pd.Index) -> list[dict]:
    rows = []
    for form in FORMS:
        for season in SEASONS:
            df = clean(sm_.frame(table, form, season))
            train = df[df.index.year != HOLD_OUT]
            for kind in KINDS:
                dev_all = dev_smoke = 0.0
                n_all = n_smoke = 0
                for year in CV_YEARS:
                    tr, te = train[train.index.year != year], train[train.index.year == year]
                    f = sm_.fit(tr, kind, TREND_DF)
                    mu = sm_.predict(f, te)
                    dev_all += sm_.deviance(te["y"], mu)
                    n_all += len(te)
                    mask = te.index.isin(smoke_days)
                    dev_smoke += sm_.deviance(te["y"][mask], mu[mask])
                    n_smoke += int(mask.sum())
                rows.append({"form": form, "season": season, "kind": kind,
                             "deviance_all": round(dev_all, 1), "days": n_all,
                             "deviance_smoke_days": round(dev_smoke, 1), "smoke_days": n_smoke})
                print(f"  cv {form:6s} {season:4s} {kind:10s} all {dev_all:9.1f}  smoke days {dev_smoke:8.1f} ({n_smoke})")
    return rows


def episode_check(table: pd.DataFrame) -> list[dict]:
    """Every candidate on 6-8 June 2023. Reported for transparency; selection never looks at it."""
    rows = []
    for form in FORMS:
        for season in SEASONS:
            df = clean(sm_.frame(table, form, season))
            train, test = df[df.index.year != HOLD_OUT], df[df.index.year == HOLD_OUT]
            ep = (test.index >= EPISODE[0]) & (test.index <= EPISODE[1])
            for kind in KINDS:
                f = sm_.fit(train, kind, TREND_DF)
                base = sm_.predict(f, test, with_smoke=False)
                mu = sm_.predict(f, test)
                obs = test["y"].to_numpy()
                rows.append({"form": form, "season": season, "kind": kind,
                             "predicted_excess": rnd((mu[ep] - base[ep]).sum()),
                             "observed_excess": rnd((obs[ep] - base[ep]).sum()),
                             "june_deviance": rnd(sm_.deviance(obs[test.index.month == 6], mu[test.index.month == 6]))})
    return rows


def draws(f: sm_.Fit, n: int = DRAWS, seed: int = 5) -> tuple[np.ndarray, np.ndarray]:
    rng = np.random.default_rng(seed)
    b = rng.normal(BETA_LIT, SE_LIT, n)
    theta = rng.multivariate_normal(f.smoke_mean(), f.smoke_cov(), n, method="cholesky") if f.terms else np.zeros((n, 0))
    return b, theta


def excess_draws(f: sm_.Fit, df: pd.DataFrame, base: np.ndarray, b: np.ndarray, theta: np.ndarray) -> np.ndarray:
    S = df[TERMS].to_numpy()
    eta = np.outer(b, S[:, 0])
    if f.terms:
        eta = eta + theta @ S.T
    return base[None, :] * np.expm1(eta)


def q(a, axis=0) -> dict:
    p = np.percentile(a, [10, 50, 90], axis=axis)
    return {"p10": p[0], "p50": p[1], "p90": p[2]}


def rnd(x, n=1):
    if isinstance(x, dict):
        return {k: rnd(v, n) for k, v in x.items()}
    if isinstance(x, (list, tuple, np.ndarray)):
        return [rnd(v, n) for v in x]
    if x is None or (isinstance(x, float) and math.isnan(x)):
        return None
    return round(float(x), n)


def main():
    table = sd.load_table()
    raw = clean(sm_.frame(table, "linear", "all"))
    smoke_days = raw.index[raw["s01"] > SMOKE_DAY]
    train_raw = raw[raw.index.year != HOLD_OUT]

    print("cross-validation on training years", CV_YEARS)
    cv = cross_validate(table, smoke_days)
    best = min((r for r in cv if r["kind"] == "corrected"), key=lambda r: r["deviance_smoke_days"])
    form, season = best["form"], best["season"]
    lit_cv = next(r for r in cv if r["form"] == form and r["season"] == season and r["kind"] == "literature")
    correction_wins_cv = best["deviance_smoke_days"] < lit_cv["deviance_smoke_days"]
    print(f"picked form={form} season={season}; correction {'wins' if correction_wins_cv else 'loses'} in CV")

    df = clean(sm_.frame(table, form, season))
    train = df[df.index.year != HOLD_OUT]
    test = df[df.index.year == HOLD_OUT]
    fits = {k: sm_.fit(train, k, TREND_DF) for k in KINDS}
    corr = fits["corrected"]
    theta, cov = corr.smoke_mean(), corr.smoke_cov()
    se = np.sqrt(np.diag(cov))
    kappa = 1 + theta[0] / BETA_LIT
    kappa_ci = [1 + (theta[0] - 1.96 * se[0]) / BETA_LIT, 1 + (theta[0] + 1.96 * se[0]) / BETA_LIT]
    print(f"correction kappa {kappa:.2f} ({kappa_ci[0]:.2f} to {kappa_ci[1]:.2f}); lags {theta[1:]} se {se[1:]}")

    # ---- 2023 ----
    out = {}
    series = pd.DataFrame(index=test.index)
    series["observed"] = test["y"]
    series["pm"] = test["pm"]
    series["smoke"] = test["smoke"]
    obs = test["y"].to_numpy()
    # a baseline that doesn't lean on the model: same weekday over the four weeks before
    wk = table["visits_citywide"]
    series["baseline_weeks"] = sum(wk.shift(7 * k) for k in range(1, 5)).reindex(test.index) / 4
    ep = (test.index >= EPISODE[0]) & (test.index <= EPISODE[1])
    peak = test.index == PEAK
    june = (test.index >= "2023-06-01") & (test.index <= "2023-06-30")
    for kind, f in fits.items():
        base = sm_.predict(f, test, with_smoke=False)
        mu = sm_.predict(f, test)
        b, th = draws(f)
        ex = excess_draws(f, test, base, b, th)
        series[f"baseline_{kind}"] = base
        series[f"pred_{kind}"] = mu
        band = q(base[None, :] + ex)
        series[f"pred_{kind}_p10"] = band["p10"]
        series[f"pred_{kind}_p90"] = band["p90"]
        ep_ex = q(ex[:, ep].sum(axis=1))
        obs_ex = float((obs[ep] - base[ep]).sum())
        out[kind] = {
            "year_2023": {"deviance": rnd(sm_.deviance(obs, mu)), "mae": rnd(np.mean(np.abs(obs - mu)), 2),
                          "baseline_only_deviance": rnd(sm_.deviance(obs, base))},
            "june_2023": {"deviance": rnd(sm_.deviance(obs[june], mu[june])),
                          "mae": rnd(np.mean(np.abs(obs[june] - mu[june])), 2),
                          "baseline_only_mae": rnd(np.mean(np.abs(obs[june] - base[june])), 2)},
            "episode_6_8_june": {
                "predicted_excess": rnd(ep_ex),
                "observed_excess_vs_model_baseline": rnd(obs_ex),
                "observed_excess_vs_prior_weeks": rnd(float((obs[ep] - series["baseline_weeks"].to_numpy()[ep]).sum())),
                "error": rnd(ep_ex["p50"] - obs_ex),
                "error_pct": rnd((ep_ex["p50"] - obs_ex) / obs_ex * 100),
                "observed_inside_p10_p90": bool(ep_ex["p10"] <= obs_ex <= ep_ex["p90"]),
            },
            "peak_7_june": {
                "observed": int(obs[peak][0]),
                "baseline": rnd(base[peak][0]),
                "predicted": rnd(mu[peak][0]),
                "predicted_p10_p90": [rnd(band["p10"][peak][0]), rnd(band["p90"][peak][0])],
                "error": rnd(mu[peak][0] - obs[peak][0]),
                "error_pct": rnd((mu[peak][0] - obs[peak][0]) / obs[peak][0] * 100),
                "predicted_pct_change": rnd((mu[peak][0] / base[peak][0] - 1) * 100),
                "observed_pct_change": rnd((obs[peak][0] / base[peak][0] - 1) * 100),
            },
        }
        print(f"  {kind:10s} 6-8 June excess predicted {ep_ex['p50']:.0f} ({ep_ex['p10']:.0f}-{ep_ex['p90']:.0f})"
              f" vs observed {obs_ex:.0f}; 7 June predicted {mu[peak][0]:.0f} vs {obs[peak][0]:.0f}")

    lit_e, cor_e = out["literature"]["episode_6_8_june"], out["corrected"]["episode_6_8_june"]
    beats = {
        "episode_excess_abs_error": abs(cor_e["error"]) < abs(lit_e["error"]),
        "june_deviance": out["corrected"]["june_2023"]["deviance"] < out["literature"]["june_2023"]["deviance"],
        "year_deviance": out["corrected"]["year_2023"]["deviance"] < out["literature"]["year_2023"]["deviance"],
    }
    # The plan was to serve the CV winner. A correction that wins CV but loses on the hold-out doesn't
    # get served; that one choice then leans on 2023, and the README says so.
    use_correction = correction_wins_cv and beats["episode_excess_abs_error"] and beats["june_deviance"]
    served = "corrected" if use_correction else "literature"
    served_e = out[served]["episode_6_8_june"]
    verdict = (
        f"Served model: {served}. The correction {'won' if correction_wins_cv else 'lost'} training-year CV"
        f"{'' if use_correction == correction_wins_cv else ' but failed the 2023 check, so it is not served'}. "
        f"On 6-8 June 2023 the served model predicts "
        f"{served_e['predicted_excess']['p50']:.0f} excess asthma ED visits (p10-p90 "
        f"{served_e['predicted_excess']['p10']:.0f}-{served_e['predicted_excess']['p90']:.0f}) against "
        f"{served_e['observed_excess_vs_model_baseline']:.0f} observed above the model baseline, an error of "
        f"{served_e['error_pct']:+.0f}%. The learned correction "
        f"{'beats' if beats['episode_excess_abs_error'] else 'does not beat'} the literature-only model on the "
        f"episode excess, {'beats' if beats['june_deviance'] else 'does not beat'} it on June deviance, and "
        f"{'beats' if beats['year_deviance'] else 'does not beat'} it on 2023 deviance. June 2023 smoke "
        f"(s01 up to {raw.loc[raw.index.year == HOLD_OUT, 's01'].max():.0f} ug/m3) runs far past anything in "
        f"training (max {train_raw['s01'].max():.0f} ug/m3), so any number at that level is an extrapolation."
    )
    print(verdict)

    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    variant = f"smoke-nyc-{form}-{season}-{served}"
    coeffs = {
        "variant": variant,
        "created_at": now,
        "use_correction": use_correction,
        "literature": {**LIT, "beta_per_ugm3": BETA_LIT, "se_per_ugm3": SE_LIT},
        "exposure": {
            "form": form,
            "season_in_training": season,
            "background_days": sm_.BACKGROUND_DAYS,
            "background": "trailing median of daily PM2.5 over the previous 30 days",
            "terms": {"s01": "mean of lags 0-1", "s23": "mean of lags 2-3", "s45": "mean of lags 4-5"},
            "training_max_s01": rnd(train_raw["s01"].max(), 2),
        },
        "correction": {
            "terms": TERMS,
            "mean": theta.tolist(),
            "cov": cov.tolist(),
            "se": se.tolist(),
            "kappa": rnd(kappa, 3),
            "kappa_ci95": rnd(kappa_ci, 3),
            "scale": rnd(corr.scale, 3),
        },
        "trained": {"rows": corr.rows, "from": str(train.index.min().date()), "to": str(train.index.max().date()),
                    "hold_out_year": HOLD_OUT, "trend_df": TREND_DF},
    }
    metrics = {
        "variant": variant,
        "created_at": now,
        "data": {
            "outcome": "NYC syndromic surveillance, asthma ED visits, citywide, all ages (EpiQuery export)",
            "exposure": "EPA AirData daily_88101 (PM2.5 FRM/FEM), Bronx, Kings, New York, Queens, Richmond",
            "confounder": "Open-Meteo ERA5 daily max temperature, Central Park",
            "table_rows": int(len(table)),
            "table_from": str(table.index.min().date()),
            "table_to": str(table.index.max().date()),
            "pm_to": str(table["pm"].dropna().index.max().date()),
            "training_rows": corr.rows,
            "test_rows_2023": int(len(test)),
            "training_smoke_days": {f"s01_over_{t}": int((train_raw["s01"] > t).sum()) for t in (5, 10, 25)},
            "test_smoke_days": {f"s01_over_{t}": int((raw.loc[raw.index.year == HOLD_OUT, "s01"] > t).sum())
                                for t in (5, 10, 25, 100)},
            "training_max_s01": rnd(train_raw["s01"].max(), 1),
            "test_max_s01": rnd(raw.loc[raw.index.year == HOLD_OUT, "s01"].max(), 1),
        },
        "selection": {"cv_years": CV_YEARS, "smoke_day_threshold_s01": SMOKE_DAY, "rows": cv,
                      "picked": {"form": form, "season": season}, "correction_wins_cv": correction_wins_cv,
                      "served_rule": "serve the correction only if it wins CV and also beats the literature term "
                                     "on the 6-8 June excess and June deviance; the second half looks at 2023"},
        "all_candidates_2023": episode_check(table),
        "correction": {"kappa": rnd(kappa, 3), "kappa_ci95": rnd(kappa_ci, 3),
                       "lag_2_3_per_ugm3": rnd(theta[1], 5), "lag_2_3_se": rnd(se[1], 5),
                       "lag_4_5_per_ugm3": rnd(theta[2], 5), "lag_4_5_se": rnd(se[2], 5),
                       "overdispersion": rnd(corr.scale, 3)},
        "validation_2023": out,
        "correction_beats_literature_2023": beats,
        "served": served,
        "verdict": verdict,
        "context_not_target": {
            "source": "CDC MMWR 2023;72(34):926, doi:10.15585/mmwr.mm7234a5",
            "national": "asthma ED visits 17% above expected across 19 smoke days, April-August 2023",
            "region_2_excess_6_8_june": 364,
            "note": "HHS Region 2 is New York and New Jersey, with a different baseline method; not comparable one to one",
        },
        "uncertainty": "p10-p90 bands carry the literature CI and the correction's covariance; baseline error and "
                       "day-to-day Poisson noise are not in the band",
    }
    ART.mkdir(parents=True, exist_ok=True)
    CHARTS.mkdir(parents=True, exist_ok=True)
    (ART / "coefficients.json").write_text(json.dumps(coeffs, indent=2))
    (ART / "metrics.json").write_text(json.dumps(metrics, indent=2))

    win = series.loc[WINDOW[0]:WINDOW[1]]
    chart = {
        "title": "June 2023 New York smoke: asthma ED visits, predicted from air quality alone",
        "served": served,
        "dates": [d.strftime("%Y-%m-%d") for d in win.index],
        "observed": rnd(win["observed"].tolist(), 0),
        "baseline": rnd(win[f"baseline_{served}"].tolist(), 1),
        "literature": rnd(win["pred_literature"].tolist(), 1),
        "literature_p10": rnd(win["pred_literature_p10"].tolist(), 1),
        "literature_p90": rnd(win["pred_literature_p90"].tolist(), 1),
        "corrected": rnd(win["pred_corrected"].tolist(), 1),
        "corrected_p10": rnd(win["pred_corrected_p10"].tolist(), 1),
        "corrected_p90": rnd(win["pred_corrected_p90"].tolist(), 1),
        "pm25": rnd(win["pm"].tolist(), 1),
        "smoke": rnd(win["smoke"].tolist(), 1),
        "episode": list(EPISODE),
        "peak": PEAK,
    }
    (CHARTS / "validation_june2023.json").write_text(json.dumps(chart))
    plot(chart, metrics)
    print("wrote", ART)


def plot(chart: dict, metrics: dict):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.dates as mdates
    import matplotlib.pyplot as plt

    ink, paper, faint, drill, info, bad = "#0f1418", "#ece8dd", "#647077", "#f3b63c", "#9dbfe0", "#ff5d4f"
    x = pd.to_datetime(chart["dates"])
    fig, (ax, ax2) = plt.subplots(2, 1, figsize=(10, 6.2), sharex=True, height_ratios=[3, 1], facecolor=ink)
    for a in (ax, ax2):
        a.set_facecolor(ink)
        a.tick_params(colors=paper, labelsize=9)
        for s in a.spines.values():
            s.set_color("#3a4850")
    arr = lambda k: np.array([np.nan if v is None else v for v in chart[k]], float)  # noqa: E731
    ax.fill_between(x, arr("literature_p10"), arr("literature_p90"), color=bad, alpha=0.12, lw=0)
    ax.fill_between(x, arr("corrected_p10"), arr("corrected_p90"), color=drill, alpha=0.18, lw=0)
    ax.plot(x, arr("baseline"), color=faint, lw=1.2, ls="--", label="baseline (no smoke)")
    tag = {k: " (served)" if chart["served"] == k else "" for k in ("literature", "corrected")}
    ax.plot(x, arr("literature"), color=bad, lw=1.4, label="literature term only" + tag["literature"])
    ax.plot(x, arr("corrected"), color=drill, lw=1.8, label="with learned correction" + tag["corrected"])
    ax.plot(x, arr("observed"), color=paper, lw=0, marker="o", ms=3.5, label="observed")
    ax.set_ylabel("asthma ED visits / day", color=paper)
    ax.legend(facecolor=ink, edgecolor="#3a4850", labelcolor=paper, fontsize=8, loc="upper right")
    e = metrics["validation_2023"][metrics["served"]]["episode_6_8_june"]
    ax.set_title(
        f"NYC, June 2023 (held out). 6-8 June excess: predicted {e['predicted_excess']['p50']:.0f} "
        f"({e['predicted_excess']['p10']:.0f}-{e['predicted_excess']['p90']:.0f}), observed "
        f"{e['observed_excess_vs_model_baseline']:.0f}", color=paper, fontsize=10, loc="left")
    ax2.bar(x, arr("pm25"), color=info, width=0.8)
    ax2.set_ylabel("PM2.5 µg/m³", color=paper)
    ax2.xaxis.set_major_formatter(mdates.DateFormatter("%d %b"))
    fig.tight_layout()
    fig.savefig(CHARTS / "validation_june2023.png", dpi=130, facecolor=ink)
    plt.close(fig)


if __name__ == "__main__":
    main()
