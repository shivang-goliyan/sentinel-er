import sys
import zipfile
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))

import smoke_data as sd  # noqa: E402
import smoke_model as sm_  # noqa: E402

NOTE = '"-Syndrome data are inherently non-specific.\n-Data for the most recent two weeks are not final."'


def epiquery(n_days: int) -> str:
    head = "Data note 1,Date ,Dim1Name,Dim1Value,Dim2Name,Dim2Value,Ind1Name,Chosen metric value,Min. Yeardate,Select Metric\n"
    rows = []
    for i, d in enumerate(pd.date_range("2023-06-01", periods=n_days)):
        value = "1,204" if i == 0 else str(100 + i)
        rows.append(f'{NOTE},{d.month}/{d.day}/{d:%y},Citywide,Citywide,Age Group,All age groups,Asthma,"{value}",1/1/2016,Count')
    return head + "\n".join(rows) + "\n"


def test_date_column_trailing_space():
    s = sd.parse_epiquery(epiquery(20))
    assert s.index[0] == pd.Timestamp("2023-06-01")
    assert s.iloc[0] == 1204.0


def test_drops_two_provisional_weeks():
    s = sd.parse_epiquery(epiquery(20))
    assert len(s) == 6
    assert s.index[-1] == pd.Timestamp("2023-06-06")


def test_missing_date_column_fails():
    with pytest.raises(ValueError):
        sd.parse_epiquery("When,Chosen metric value\n1/1/16,3\n")


AIR_HEAD = ('"State Code","County Code","Site Num","Parameter Code","POC","Latitude","Longitude","Datum",'
            '"Parameter Name","Sample Duration","Pollutant Standard","Date Local","Units of Measure","Event Type",'
            '"Observation Count","Observation Percent","Arithmetic Mean","1st Max Value","1st Max Hour","AQI",'
            '"Method Code","Method Name","Local Site Name","Address","State Name","County Name","City Name",'
            '"CBSA Name","Date of Last Change"')


def air_row(state, county, site, date, event, mean, std="PM25 24-hour 2012", dur="24 HOUR"):
    return (f'"{state}","{county}","{site}","88101",1,40.8,-73.9,"WGS84","PM2.5 - Local Conditions","{dur}",'
            f'"{std}","{date}","Micrograms/cubic meter (LC)","{event}",1,100.0,{mean},{mean},0,50,"170",'
            f'"Met One BAM-1020","IS 52, Bronx","681 Kelly St, Bronx, NY","New York","Bronx","New York",'
            f'"New York-Newark-Jersey City, NY-NJ","2024-05-01"')


def airdata_zip(tmp_path: Path, rows: list[str]) -> Path:
    p = tmp_path / "daily_88101_2023.zip"
    with zipfile.ZipFile(p, "w") as z:
        z.writestr("daily_88101_2023.csv", AIR_HEAD + "\n" + "\n".join(rows) + "\n")
    return p


def test_airdata_keeps_smoke_rows(tmp_path):
    p = airdata_zip(tmp_path, [
        air_row("36", "005", "0110", "2023-06-07", "Included", 177.4),
        air_row("36", "005", "0110", "2023-06-07", "Excluded", 9.0),
        air_row("36", "005", "0110", "2023-06-07", "Included", 177.4, std="PM25 Annual 2012"),
        air_row("36", "081", "0124", "2023-06-07", "None", 202.6),
        air_row("34", "005", "0001", "2023-06-07", "None", 500.0),
        air_row("36", "001", "0001", "2023-06-07", "None", 500.0),
    ])
    f = sd.parse_airdata(p)
    assert f.loc["2023-06-07", "bronx"] == pytest.approx(177.4)
    assert f.loc["2023-06-07", "queens"] == pytest.approx(202.6)
    assert f.loc["2023-06-07", "pm_sites"] == 2


def test_citywide_ignores_county_mix():
    idx = pd.date_range("2023-01-01", periods=6)
    by = pd.DataFrame({"a": [10.0] * 6, "b": [14.0, np.nan, 14.0, np.nan, 14.0, np.nan]}, index=idx)
    city = sd.citywide_pm(by)
    assert city.std() == pytest.approx(0, abs=1e-9)


def test_smoke_above_trailing_median():
    pm = pd.Series([8.0] * 40 + [60.0, 8.0], index=pd.date_range("2023-05-01", periods=42))
    smoke, bg = sm_.smoke_excess(pm)
    assert bg.iloc[40] == 8.0
    assert smoke.iloc[40] == pytest.approx(52.0)
    assert smoke.iloc[41] == 0.0


def test_log_form_bends_over():
    x = np.array([0.1, 131.0])
    y = sm_.shape(x, "log")
    assert y[0] == pytest.approx(0.1, rel=0.01)
    assert y[1] < 30
    with pytest.raises(ValueError):
        sm_.shape(x, "cubic")


def test_lags_average_the_right_days():
    s = pd.Series([0, 0, 0, 0, 0, 10.0, 20.0], index=pd.date_range("2023-06-01", periods=7))
    lt = sm_.lag_terms(s)
    assert lt["s01"].iloc[6] == 15.0
    assert lt["s23"].iloc[6] == 0.0
    assert lt["s45"].iloc[6] == 0.0
    assert pd.isna(lt["s45"].iloc[4])


def synthetic(kappa: float, seed: int = 3) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    idx = pd.date_range("2016-01-01", "2026-06-30")
    pm = pd.Series(7 + rng.gamma(2, 1.5, len(idx)), index=idx)
    spikes = rng.choice(len(idx), 120, replace=False)
    pm.iloc[spikes] += rng.uniform(10, 45, 120)
    tmax = 15 + 12 * np.sin(2 * np.pi * (idx.dayofyear - 110) / 365.25) + rng.normal(0, 4, len(idx))
    table = pd.DataFrame({"pm": pm, "tmax": tmax}, index=idx)
    df = sm_.frame(table.assign(visits_citywide=0.0))
    base = np.log(200) + 0.15 * np.sin(2 * np.pi * idx.dayofyear / 365.25) - 0.35 * df["post2020"]
    eta = base + kappa * sm_.BETA_LIT * df["s01"].fillna(0)
    table["visits_citywide"] = rng.poisson(np.exp(eta))
    return table


def test_fit_recovers_known_correction():
    table = synthetic(kappa=0.5)
    df = sm_.frame(table).dropna(subset=["y", "tmax", *sm_.TERMS])
    f = sm_.fit(df, "corrected", trend_df=6)
    kappa = 1 + f.smoke_mean()[0] / sm_.BETA_LIT
    assert kappa == pytest.approx(0.5, abs=0.25)
    base = sm_.predict(f, df, with_smoke=False)
    assert np.all(sm_.predict(f, df) > 0)
    assert np.median(base) == pytest.approx(np.median(df["y"]), rel=0.1)


def test_served_bands_stay_ordered():
    path = HERE / "artifacts" / "coefficients.json"
    if not path.exists():
        pytest.skip("train.py has not been run")
    m = sm_.SmokeModel(path)
    out = m.pct_change(np.array([[0, 0, 0], [5, 0, 0], [60, 20, 5]]))
    assert out["p50"][0] == pytest.approx(0, abs=1e-9)
    assert np.all(out["p10"] <= out["p50"]) and np.all(out["p50"] <= out["p90"])
    assert out["p50"][2] > out["p50"][1] > 0


def test_deviance_zero_when_perfect():
    y = np.array([0.0, 3.0, 10.0])
    assert sm_.deviance(y, np.where(y == 0, 1e-12, y)) == pytest.approx(0, abs=1e-6)
    assert sm_.deviance(y, y + 1) > 0

