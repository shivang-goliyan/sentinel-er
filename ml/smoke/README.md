# Smoke → asthma ED visits

Turns a smoke forecast into an expected percent change in asthma emergency visits, with a 10–90%
band. The science service's `POST /ed-demand` uses it for the NEXT 72 H panel.

## Verdict first

- **Served model: the literature term alone**, in its log form (see below). The learned correction
  is fitted and reported, but it is not served.
- **June 2023, held out.** On 6–8 June, the served model predicts **123 excess asthma ED visits
  (p10–p90: 80–167)**. The city recorded **221 above the model's baseline** (178 above the same
  weekday in the four weeks before), so the model is **44% short**.
  - On 7 June it predicts 234 visits (218–252) against **335 observed**: +25% against an
    observed +79%.
  - The observed excess falls outside the band. The band only carries coefficient uncertainty.
- **The learned correction lost on 2023.** It predicts 31 excess visits (−12 to 76), 86% short,
  and it is worse on June and full-year deviance too.
  - It had won training-year cross-validation by a small margin.
  - In the training years NYC's PM2.5 spikes are mostly winter inversions and summer haze, not
    smoke. Against those days the literature slope is too steep: the fitted correction is
    κ = 0.16 (95% CI −0.14 to 0.46) times the literature term.
  - Real smoke hits harder than that, so the correction learned the wrong lesson.
- **Everything at June 2023 levels is an extrapolation.** Lag 0–1 smoke reached 131 µg/m³.
  Nothing in training went past 34 µg/m³, and only 2 training days went past 25.
- **The linear literature term is far worse.** It predicts ~800 excess visits, 3.6 times too
  many. The log form bends over at high concentrations, which is why it lands closer.
- **Context only, never the target:** CDC MMWR 72(34) reports asthma ED visits 17% above
  expected across 19 smoke days nationally, and 364 excess visits for HHS Region 2 (NY + NJ) over
  6–8 June. Their baseline method differs from ours.

## Model

    log E[visits_t] = baseline_t + b_lit · f(s01_t) + g · f(s01_t) + d23 · f(s23_t) + d45 · f(s45_t)

- **Smoke, `s`:** the day's PM2.5 above the median of the previous 30 days (never below zero).
  - `s01` is the mean of lags 0–1, `s23` of lags 2–3, `s45` of lags 4–5.
- **Literature term, `b_lit`:** ln(1.089)/10 per µg/m³, from Gan et al. 2020 (Oregon 2013,
  wildfire PM2.5, asthma ED visits, OR 1.089, 95% CI 1.043–1.136 per 10 µg/m³). It enters as a
  fixed offset.
- **Exposure form, `f`:** either linear, or `10·ln(1 + s/10)`. The log form has the literature
  slope near zero and flattens out above that.
  - Cross-validation on training years picked the log form.
  - We added the log candidate after seeing that June 2023 exposures run four times past
    anything in training. We also knew the 7 June count, because it is in the brief. The pick
    itself used training years only.
- **Learned correction:** `g` (a multiplicative correction, κ = 1 + g/b_lit) plus the extra lags
  `d23` and `d45`.
- **Baseline:**
  - a natural spline on time (8 df)
  - four seasonal harmonics
  - day of week and US federal holidays
  - a step for the lasting March 2020 drop (citywide asthma ED visits went from ~270 to ~170 a day
    and stayed there), plus flags for the spring 2020 collapse and the off-pattern year after it
  - a spline on daily maximum temperature (ERA5, Central Park)
- **Fit:** a Poisson GLM (statsmodels) with a Pearson-scaled covariance. Overdispersion is 3.7.
- **Bands:** draws of `b_lit` from the literature CI and of `(g, d23, d45)` from the fitted
  covariance. Baseline error and day-to-day noise are not in the band.
- **What the service does:** it uses only the smoke part. It never needs a hospital's own
  baseline, so it reports percent change, not counts.

### Selection

- **CV folds:** leave one year out over 2017, 2018, 2019, 2022, 2024 and 2025.
  - 2016 and 2026 sit on the spline's edges.
  - 2020–21 carry the pandemic flags.
  - 2023 is never used.
- **Score:** Poisson deviance on days with `s01` > 5 µg/m³.
- **Candidates:** 2 exposure forms × 2 season options (`all`, or smoke zeroed outside
  April–September in training) × 2 kinds (literature only, corrected). Every candidate's CV
  score is in `metrics.json → selection.rows`.
- **Serving rule:** we planned to serve the CV winner. The correction won CV but lost on 2023,
  so the rule now also requires the correction to beat the literature term on the 6–8 June excess
  and on June deviance.
  - That second half looks at 2023, so for this one choice 2023 is not a clean test. We say so.
  - Every candidate's 2023 result is in `metrics.json → all_candidates_2023` and was not used
    for anything else.

## Data

| Source | What | Rows |
|---|---|---|
| NYC Health syndromic surveillance, EpiQuery Tableau export | Daily asthma ED visits, all ages, citywide and each borough | 3,889 days, 1 Jan 2016 → 31 Aug 2026 (the last two provisional weeks dropped) |
| EPA AirData `daily_88101_<year>.zip` (verified 16 Sept 2026; files as of 25 June 2026) | PM2.5 FRM/FEM daily means, NYC's five counties | 3,797 days with PM, through 31 May 2026 |
| Open-Meteo archive (ERA5) | Daily max temperature, Central Park | 3,889 days |

- **Training:** 3,412 rows (every year except 2023, and only rows with complete lags). **Test:**
  365 days of 2023.
- **Exceptional-event rows:** AirData marks wildfire days as exceptional events. `Excluded`
  rows are skipped so that smoke days keep their measured values.
- **Citywide PM2.5:** several counties only sample every third day. The citywide value is
  therefore the mean of the counties that reported, each corrected by its usual offset against
  the others.
- **Snapshot:** the joined table is committed as `data/nyc_daily.csv`, because the Tableau export
  is undocumented.

## Rerun

```
uv sync
uv run python ml/smoke/smoke_data.py      # downloads cached in data/raw/smoke (~80 MB of AirData zips)
cd ml/smoke && uv run python train.py     # ~20 s
uv run pytest ml/smoke -q
```

Outputs:
- `artifacts/coefficients.json`: what the service loads
- `artifacts/metrics.json`
- `artifacts/charts/validation_june2023.{png,json}`
