"""Smoke -> asthma ED visits: the literature term, the learned correction, and inference.

log E[visits_t] = baseline_t + b_lit * s01_t + g * s01_t + d23 * s23_t + d45 * s45_t

- s is smoke PM2.5: the day's PM2.5 above its trailing 30-day median (never below zero).
- s01 is the mean of lag 0 and lag 1, s23 of lags 2-3, s45 of lags 4-5.
- Two exposure forms are tried: linear, and 10 * ln(1 + s / 10), which has the same slope near zero
  but bends over at high concentrations. Training-year cross-validation picks one.
- The "warm" season option zeroes smoke outside April-September in training, so winter inversion
  days don't pass for smoke. It changes training labels only.
- b_lit is fixed from Gan et al. 2020 (OR 1.089 per 10 ug/m3) and enters as an offset.
- g and the d's are learned. g / b_lit + 1 is the multiplicative correction on the literature term.
"""

import json
import math
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd
import patsy
import statsmodels.api as sm
from pandas.tseries.holiday import USFederalHolidayCalendar

LIT = {
    "or_per_10": 1.089,
    "ci95": [1.043, 1.136],
    "lag": "0-1",
    "cite": "Gan RW et al. J Expo Sci Environ Epidemiol 2020;30:618-628 (PMID 32051501), asthma ED visits, "
            "wildfire PM2.5, Oregon 2013",
}
BETA_LIT = math.log(LIT["or_per_10"]) / 10
SE_LIT = (math.log(LIT["ci95"][1]) - math.log(LIT["ci95"][0])) / (2 * 1.96) / 10

BACKGROUND_DAYS = 30
TERMS = ["s01", "s23", "s45"]
START = pd.Timestamp("2016-01-01")


def smoke_excess(pm: pd.Series, window: int = BACKGROUND_DAYS) -> tuple[pd.Series, pd.Series]:
    """PM2.5 above the trailing median of the previous `window` days."""
    filled = pm.interpolate(limit=2, limit_area="inside")
    bg = filled.shift(1).rolling(window, min_periods=window // 3).median()
    return (filled - bg).clip(lower=0), bg


def shape(x, form: str):
    if form == "linear":
        return x
    if form == "log":
        return 10 * np.log1p(x / 10)
    raise ValueError(f"unknown exposure form {form!r}")


def lag_terms(smoke: pd.Series, form: str = "linear") -> pd.DataFrame:
    return pd.DataFrame({
        "s01": shape((smoke + smoke.shift(1)) / 2, form),
        "s23": shape((smoke.shift(2) + smoke.shift(3)) / 2, form),
        "s45": shape((smoke.shift(4) + smoke.shift(5)) / 2, form),
    }, index=smoke.index)


def calendar(index: pd.DatetimeIndex, tmax: pd.Series | None = None) -> pd.DataFrame:
    hol = USFederalHolidayCalendar().holidays(index.min() - pd.Timedelta(days=1), index.max() + pd.Timedelta(days=1))
    doy = index.dayofyear.to_numpy() / 365.25
    out = pd.DataFrame(index=index)
    out["t"] = (index - START).days / 365.25
    for k in range(1, 5):
        out[f"sin{k}"] = np.sin(2 * np.pi * k * doy)
        out[f"cos{k}"] = np.cos(2 * np.pi * k * doy)
    out["dow"] = index.dayofweek.astype(str)
    out["holiday"] = index.isin(hol).astype(float)
    # ED asthma visits fell by about a third in March 2020 and never came back; on top of that the
    # spring 2020 collapse and a year of off-pattern respiratory seasons
    out["post2020"] = (index >= "2020-03-15").astype(float)
    out["covid_a"] = ((index >= "2020-03-15") & (index < "2020-07-01")).astype(float)
    out["covid_b"] = ((index >= "2020-07-01") & (index < "2021-07-01")).astype(float)
    if tmax is not None:
        out["tmax"] = tmax.reindex(index).interpolate(limit=3, limit_area="inside").to_numpy()
    return out


# explicit spline bounds so held-out years at the edges and hot days outside training still evaluate
BASE_FORMULA = ("cr(t, df={trend_df}, constraints='center', lower_bound=-0.1, upper_bound=11.5) + sin1 + cos1 + sin2 + cos2 + sin3 + cos3 + sin4 + cos4"
                " + C(dow, levels=['0','1','2','3','4','5','6']) + holiday + post2020 + covid_a + covid_b"
                " + cr(tmax, df=4, constraints='center', lower_bound=-25, upper_bound=45)")


@dataclass
class Fit:
    kind: str
    names: list[str]
    params: np.ndarray
    cov: np.ndarray
    scale: float
    design_info: object
    terms: list[str] = field(default_factory=list)
    rows: int = 0

    def term_index(self) -> list[int]:
        return [self.names.index(t) for t in self.terms]

    def smoke_mean(self) -> np.ndarray:
        return self.params[self.term_index()] if self.terms else np.zeros(0)

    def smoke_cov(self) -> np.ndarray:
        i = self.term_index()
        return self.cov[np.ix_(i, i)] if self.terms else np.zeros((0, 0))


def design(df: pd.DataFrame, trend_df: int, terms: list[str], info=None):
    rhs = BASE_FORMULA.format(trend_df=trend_df)
    if terms:
        rhs += " + " + " + ".join(terms)
    if info is None:
        X = patsy.dmatrix(rhs, df, return_type="dataframe", NA_action="raise")
        return X, X.design_info
    X = patsy.build_design_matrices([info], df, return_type="dataframe", NA_action="raise")[0]
    return X, info


def frame(table: pd.DataFrame, form: str = "linear", season: str = "all",
          target: str = "visits_citywide") -> pd.DataFrame:
    smoke, bg = smoke_excess(table["pm"])
    if season == "warm":
        smoke = smoke.where((smoke.index.month >= 4) & (smoke.index.month <= 9), 0.0)
    elif season != "all":
        raise ValueError(f"unknown season option {season!r}")
    df = calendar(table.index, table.get("tmax"))
    df = df.join(lag_terms(smoke, form))
    df["y"] = table[target]
    df["pm"] = table["pm"]
    df["smoke"] = smoke
    df["background"] = bg
    return df


def fit(df: pd.DataFrame, kind: str, trend_df: int) -> Fit:
    terms = TERMS if kind == "corrected" else []
    X, info = design(df, trend_df, terms)
    offset = BETA_LIT * df["s01"].to_numpy()
    res = sm.GLM(df["y"].to_numpy(), X, family=sm.families.Poisson(), offset=offset).fit(scale="X2")
    return Fit(kind=kind, names=list(X.columns), params=np.asarray(res.params), cov=np.asarray(res.cov_params()),
               scale=float(res.scale), design_info=info, terms=terms, rows=len(df))


def predict(f: Fit, df: pd.DataFrame, with_smoke: bool = True) -> np.ndarray:
    X, _ = design(df, 0, f.terms, info=f.design_info)
    eta = X.to_numpy() @ f.params
    if f.terms:
        # the design already holds the smoke terms; zero them for the baseline
        idx = f.term_index()
        eta = eta - X.to_numpy()[:, idx] @ f.params[idx]
    base = np.exp(eta)
    if not with_smoke:
        return base
    return base * np.exp(effect(f.smoke_mean(), df[TERMS].to_numpy(), BETA_LIT, bool(f.terms)))


def effect(theta: np.ndarray, S: np.ndarray, beta_lit: float, learned: bool) -> np.ndarray:
    """Log rate ratio from smoke for each row of S = [s01, s23, s45]."""
    S = np.atleast_2d(S)
    out = beta_lit * S[:, 0]
    if learned:
        out = out + S @ theta
    return out


def deviance(y: np.ndarray, mu: np.ndarray) -> float:
    y = np.asarray(y, float)
    mu = np.asarray(mu, float)
    with np.errstate(divide="ignore", invalid="ignore"):
        term = np.where(y > 0, y * np.log(y / mu), 0.0)
    return float(2 * np.sum(term - (y - mu)))


class SmokeModel:
    """What the science service loads: coefficients only, no baseline."""

    def __init__(self, path: Path):
        c = json.loads(Path(path).read_text())
        self.info = c
        self.beta_lit = c["literature"]["beta_per_ugm3"]
        self.se_lit = c["literature"]["se_per_ugm3"]
        self.learned = bool(c["use_correction"])
        self.mean = np.array(c["correction"]["mean"], float)
        self.cov = np.array(c["correction"]["cov"], float)
        self.background_days = c["exposure"]["background_days"]
        self.form = c["exposure"]["form"]
        self.support = c["exposure"]["training_max_s01"]

    def pct_change(self, S: np.ndarray, draws: int = 4000, seed: int = 11) -> dict[str, np.ndarray]:
        """p10/p50/p90 percent change in asthma ED visits for rows of S = [s01, s23, s45]."""
        S = shape(np.atleast_2d(np.asarray(S, float)), self.form)
        rng = np.random.default_rng(seed)
        b = rng.normal(self.beta_lit, self.se_lit, draws)
        eta = np.outer(b, S[:, 0])
        if self.learned:
            theta = rng.multivariate_normal(self.mean, self.cov, draws, method="cholesky")
            eta = eta + theta @ S.T
        pct = np.expm1(eta) * 100
        q = np.percentile(pct, [10, 50, 90], axis=0)
        point = np.expm1(effect(self.mean, S, self.beta_lit, self.learned)) * 100
        return {"p10": q[0], "p50": q[1], "p90": q[2], "point": point}
