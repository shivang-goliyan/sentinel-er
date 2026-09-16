# Casualty model

Estimates deaths and injuries from an earthquake's shaking footprint. It outputs a median and a
10–90% band, and every estimate is a **screening estimate**.

## How it works

Each estimate starts from a physical prior:

    prior = Σ people exposed at MMI k × global fatality rate(k) × 10^country_factor

- The fatality-rate curve is the median of USGS PAGER's country curves (`fatality.xml`).
- `country_factor` is log10 of how many people the country's past earthquakes killed compared with
  that curve. It comes from training rows only, falls back to the World Bank region, then to 0.

LightGBM quantile boosters (α = 0.1, 0.5, 0.9) then learn a correction on the log scale:

    log1p(deaths_q) = log1p(prior) + booster_q(features)

Injuries use the same prior plus a learned constant shift.

- **Features:** log1p of people at MMI 4–10, magnitude, depth, local time of day, night flag,
  World Bank income class, GDP per capita, the log prior terms, and the country and region
  factors.
- **Explanations:** `booster.predict(..., pred_contrib=True)` gives native TreeSHAP contributions
  on top of the prior.

Inference code: `casualty_model.py` (`CasualtyModel`).

## Rerun

```
uv sync
cd ml/casualty
uv run python build_dataset.py     # downloads are cached in data/raw; a rerun only fetches what's missing
uv run python train.py
uv run python evaluate.py
uv run pytest tests -q
```

The first full build fetches ~3,500 PAGER files at ≤ 4 requests/s (roughly 30 minutes). After
that, everything reruns in a few minutes.

## Data and rules

| Source | Rows | Labels |
|---|---|---|
| USGS ComCat PAGER, 1975–2026 (mostly 2013 on) | 3,547 events | NOAA NCEI HazEL, joined on origin time ±60 s, epicentres within 100 km, magnitude ±0.3 (455 matched) |
| USGS EXPO-CAT, 1960–2007 | 5,617 events | Shaking deaths from EXPO-CAT; injuries from PAGER-CAT (joined on `eqID // 100`) |

- **Death labels.**
  - ComCat events with no NCEI match count as 0 deaths, because NCEI lists every earthquake that
    caused deaths. NCEI `deaths` is used, falling back to `deathsTotal`.
  - EXPO-CAT uses `PAGER_prefShakingDeaths`. When no source recorded any deaths it's 0. The 14 rows
    that have only total deaths are dropped.
- **Injury labels.** Only rows with injuries actually recorded train the injury model: NCEI
  `injuries`, else `injuriesTotal`, and PAGER-CAT `PAGER_prefInjuries`.
- **Sampling.** Of 11,113 ComCat events with a PAGER product:
  - Every yellow/orange/red event, every M ≥ 6.0 and both hold-outs are kept (2,049).
  - 1,500 of the remaining 9,064 green events below M6 are sampled at random (seed 7), each with
    weight 6.04.
  - Two events whose USGS detail page kept failing are left out.
- **Exposure.**
  - ComCat: `pager.xml` `<exposure dmin dmax>` bins, where integer MMI k covers [k−0.5, k+0.5).
  - EXPO-CAT gives urban and rural counts at MMI ±0.25 in half steps, so bin k = ½·(k−0.5) +
    (k) + ½·(k+0.5).
  - Six EXPO-CAT events that ComCat also covers keep the ComCat row.
- **Country.**
  - The EXPO-CAT ISO code where given. Otherwise the Natural Earth country containing the
    epicentre, or the nearest one within 500 km. Otherwise PAGER's country code.
  - Income class: the World Bank OGHIST class for the year before the event (1987–2023 table;
    nearest listed year outside it).
  - GDP per capita: World Bank, the year before the event.
- **Sequences.**
  - Gardner & Knopoff (1974) space–time windows (van Stiphout et al. 2012 fit), largest event
    first. This gives 5,988 groups, and cross-validation folds never split a group.
- **Aftershock zeros.** NCEI books a sequence's deaths to its mainshock. So 951 smaller events
  recorded with 0 deaths, in sequences whose largest event killed people, are left out of
  training.
- **Hold-outs.** Türkiye 2023 (`us6000jllz`, with `us6000jlqa`) and Nepal 2015 (`us20002926`),
  plus everything within 200 km and −30…+365 days of each, and anything in the same sequence.
  That's 14 events, never seen in training, factors or tuning.

After those rules, the deaths model trains on 8,199 rows (816 deadly) and the injury model on
1,092.

## Results

Numbers are from 5-fold cross-validation grouped by sequence, out of fold. Error is |log10(pred+1) −
log10(truth+1)|. The "band" is p10–p90. Rows weighted by sampling weight where marked.

**Deaths**

| Rows | Bin accuracy¹ | Median error | Band coverage | Pinball (log1p) |
|---|---|---|---|---|
| All 8,199 (weighted) | 0.93 | 0.00 | 0.98 | 0.042 |
| 816 deadly | 0.30 | 0.48 | 0.70 | 0.51 |
| 59 with ≥ 1,000 deaths | 0.07 | 1.63 | 0.32 | 1.35 |

¹ PAGER bins: 0, 1–9, 10–99, 100–999, 1,000–9,999, 10,000+.

**Injuries** (1,068 rows with injuries): bin accuracy 0.47, median error 0.48, band coverage 0.61.

- **The physical prior alone** (no booster) on deadly events: median error 0.57, pinball 0.83. The
  booster mainly adds the band and handles the many small events.
- **PAGER's alert level as a feature** changed almost nothing (deadly pinball 0.508 vs 0.511), so
  the default model leaves it out.

**Against the USGS PAGER empirical model** (point estimates, deaths):

| | Median error, deadly | Mean error, ≥ 1,000 deaths | Bin accuracy (weighted) |
|---|---|---|---|
| This model, all rows | 0.48 | 1.73 | 0.93 |
| PAGER baseline, all rows | 0.49 | 0.69 | 0.88 |
| This model, 2008 on | 0.45 | 1.53 | 0.97 |
| PAGER baseline, 2008 on | 0.47 | 0.62 | 0.96 |

PAGER's curves were calibrated on events from 1973–2010, so its pre-2008 scores are partly in
sample. **On typical deadly earthquakes the two are level. On the largest disasters PAGER is much
closer.**

**Calibration by what was known beforehand** (median log10 gap, truth minus model median):

| Model median band | Events | Gap |
|---|---|---|
| 10–100 | 195 | −0.33 |
| 100–1,000 | 48 | +0.32 |
| 1,000–10,000 | 13 | **+0.67** |

When the model's median says "thousands", the truth has tended to be several times higher.
**For planning, use p90.**

**Hold-outs** (never seen):

| | Model p10 · p50 · p90 | Recorded (NCEI) | Official | PAGER baseline |
|---|---|---|---|---|
| Türkiye 2023 deaths | 88 · 4,070 · 55,385 | 56,697 | 53,537 (Türkiye) | 21,573 |
| Türkiye 2023 injured | 5,641 · 35,067 · 155,705 | 119,200 | 107,213 | — |
| Nepal 2015 deaths | 33 · 990 · 14,876 | 8,957 | 8,790 | 6,140 |
| Nepal 2015 injured | 2,693 · 18,669 · 42,014 | 24,000 | 22,300 | — |

- **Verdict: the median does not beat the PAGER baseline on either hold-out.**
  - Türkiye's recorded toll sits just above the band (2% over p90). Türkiye's own official toll
    sits inside it.
  - Nepal's deaths, and the injury counts for both events, sit inside their bands.
- **Why the median is low.** The physical prior alone gave 19,331 for Türkiye and 4,524 for Nepal.
  The booster pulled both down, because in training most events with a large prior killed far
  fewer people than it said. See `charts/contributions_turkey.png`.
- **The variant with PAGER's alert level** gave 77 · 5,836 · 64,403 for Türkiye. It was not chosen,
  because the choice was made on cross-validation, not on the hold-outs.

**Fairness across income classes** (deadly events, out of fold):
- Band coverage is 68–75% in every class.
- The median gap runs from −0.30 (upper-middle, high) to −0.43 (low income), so the model runs
  slightly lower for poorer countries.

**Injury ratio** (log1p injured ≈ 2.30 + 0.83·log1p deaths + class terms): R² 0.61 over 1,166
rows.

Files: `metrics.json`, `holdout.json`, `bias.json`, `dataset_summary.json`, `features.json`,
`country_factors.json`, and `charts/` (PNG for slides, JSON for the console).

## Limitations

- **The largest disasters are under-predicted at the median.** On the largest disasters, USGS's
  own empirical model is the better point estimate.
  - Once the prior passes ~10,000 deaths, the median runs several times low. The prior alone runs
    about as far high.
  - Only a few dozen training events are that large, and the boosters cannot tell them apart from
    the far more common events where the prior overshoots.
  - The 10–90% band is wide at the top end for this reason. Read it, not the median alone.
- **Scores on "events that turned out deadly" favour models that over-predict.** Conditioning on
  the outcome selects the misses in one direction. Pinball loss and calibration grouped by
  *prediction* are the fairer checks, and both are in `metrics.json`.
- **The exposure used in training is PAGER's latest version for each event**, after the ShakeMap
  was reviewed. The first estimate a few minutes after an earthquake uses earlier, rougher
  shaking.
- **The PAGER baseline here is an approximation.** It applies the epicentre country's curve to
  all exposed people, while USGS splits exposure by country. For Türkiye 2023 the per-country
  version is used, and it reproduces USGS's published 21,546 exactly.
- **EXPO-CAT populations are back-projected** to the year of each event, and its MMI 4 bin lacks
  the 3.5 half-step.
- **Injury records are sparse and uneven** between sources.
