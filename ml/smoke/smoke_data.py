"""Build the NYC daily table: asthma ED visits, monitor PM2.5 and max temperature.

Sources
- NYC Health syndromic surveillance (EpiQuery Tableau export), asthma ED visits per day,
  citywide and by borough, all ages.
- EPA AirData pre-generated daily files, parameter 88101 (PM2.5 FRM/FEM), for the five NYC
  counties.
- Open-Meteo historical weather (ERA5), daily max temperature at Central Park, as a confounder.

Downloads are cached in data/raw/smoke. The joined table is written to ml/smoke/data/nyc_daily.csv
and committed, because the Tableau export is undocumented and could vanish.
"""

import argparse
import csv
import io
import json
import zipfile
from datetime import date
from pathlib import Path

import pandas as pd
import requests

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
RAW = REPO / "data" / "raw" / "smoke"
TABLE = HERE / "data" / "nyc_daily.csv"

USER_AGENT = "sentinel-er (+https://github.com/shivang-goliyan/sentinel-er)"
EPIQUERY = ("https://a816-healthtableau.nyc.gov/t/HDI-EPIQUERY/views/HDISurveillanceModules_syndromic/"
            "ViewIndicatorQuickLook.csv?Aggregate%20by=Day&Dim1Value={area}&Dim2Value=All%20age%20groups")
AIRDATA = "https://aqs.epa.gov/aqsweb/airdata/daily_88101_{year}.zip"
ERA5 = ("https://archive-api.open-meteo.com/v1/archive?latitude=40.7812&longitude=-73.9665"
        "&start_date={start}&end_date={end}&daily=temperature_2m_max&timezone=America%2FNew_York")

AREAS = {"citywide": "Citywide", "bronx": "Bronx", "brooklyn": "Brooklyn", "manhattan": "Manhattan",
         "queens": "Queens", "staten_island": "Staten%20Island"}
# Bronx, Kings, New York, Queens, Richmond
COUNTIES = {"005": "bronx", "047": "brooklyn", "061": "manhattan", "081": "queens", "085": "staten_island"}
FIRST_YEAR = 2016
PROVISIONAL_DAYS = 14


def _get(url: str, dest: Path, timeout: int = 300) -> Path:
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    r = requests.get(url, headers={"user-agent": USER_AGENT}, timeout=timeout)
    r.raise_for_status()
    tmp = dest.with_suffix(dest.suffix + ".part")
    tmp.write_bytes(r.content)
    tmp.rename(dest)
    return dest


def parse_epiquery(text: str) -> pd.Series:
    """Daily counts from the EpiQuery CSV. The date column is 'Date ' with a trailing space and the
    counts can carry thousands separators. The last two weeks are provisional and dropped."""
    rows = list(csv.DictReader(io.StringIO(text)))
    if not rows:
        raise ValueError("the EpiQuery export came back empty")
    date_key = next((k for k in rows[0] if k.strip() == "Date"), None)
    if date_key is None:
        raise ValueError(f"no Date column in the EpiQuery export: {list(rows[0])}")
    out = {}
    for r in rows:
        raw = (r.get("Chosen metric value") or "").replace(",", "").strip()
        if not raw:
            continue
        out[pd.to_datetime(r[date_key].strip(), format="%m/%d/%y")] = float(raw)
    s = pd.Series(out, dtype=float).sort_index()
    s.index.name = "date"
    if len(s) > PROVISIONAL_DAYS:
        s = s.iloc[:-PROVISIONAL_DAYS]
    return s


def load_asthma() -> pd.DataFrame:
    cols = {}
    for key, area in AREAS.items():
        p = _get(EPIQUERY.format(area=area), RAW / f"nyc_{area.replace('%20', '_')}.csv")
        cols[f"visits_{key}"] = parse_epiquery(p.read_text())
    return pd.DataFrame(cols)


def parse_airdata(path: Path, counties: dict[str, str] = COUNTIES) -> pd.DataFrame:
    """Daily mean PM2.5 per NYC county. Exceptional-event 'Excluded' rows are skipped so smoke
    days keep their measured values; duplicates across pollutant standards are collapsed."""
    use = ["State Code", "County Code", "Site Num", "POC", "Sample Duration", "Date Local",
           "Event Type", "Arithmetic Mean"]
    parts = []
    with zipfile.ZipFile(path) as z:
        name = next(n for n in z.namelist() if n.endswith(".csv"))
        with z.open(name) as f:
            for chunk in pd.read_csv(f, usecols=use, dtype=str, chunksize=250_000):
                keep = (chunk["State Code"] == "36") & chunk["County Code"].isin(counties)
                if keep.any():
                    parts.append(chunk[keep])
    if not parts:
        return pd.DataFrame(columns=list(counties.values()))
    df = pd.concat(parts)
    df = df[df["Event Type"] != "Excluded"]
    df["value"] = pd.to_numeric(df["Arithmetic Mean"], errors="coerce")
    df = df.dropna(subset=["value"])
    df = df.drop_duplicates(["County Code", "Site Num", "POC", "Sample Duration", "Date Local"])
    # one number per monitor-day, then per county
    per_site = df.groupby(["County Code", "Site Num", "Date Local"])["value"].mean().reset_index()
    per_county = per_site.groupby(["Date Local", "County Code"])["value"].mean().unstack()
    per_county = per_county.rename(columns=counties)
    per_county.index = pd.to_datetime(per_county.index)
    per_county.index.name = "date"
    sites = per_site.groupby("Date Local")["Site Num"].nunique()
    sites.index = pd.to_datetime(sites.index)
    per_county["pm_sites"] = sites
    return per_county


def load_pm(years: list[int]) -> pd.DataFrame:
    frames = []
    for y in years:
        p = RAW / f"daily_88101_{y}.zip"
        try:
            _get(AIRDATA.format(year=y), p, timeout=900)
        except requests.HTTPError as err:
            print(f"  no AirData file for {y}: {err}")
            continue
        f = parse_airdata(p)
        print(f"  {y}: {len(f)} days, up to {f.index.max().date() if len(f) else '-'}")
        frames.append(f)
    pm = pd.concat(frames).sort_index()
    pm = pm[~pm.index.duplicated()]
    boroughs = [c for c in COUNTIES.values() if c in pm]
    pm = pm.rename(columns={b: f"pm_{b}" for b in boroughs})
    return pm.assign(pm=citywide_pm(pm[[f"pm_{b}" for b in boroughs]]))


def citywide_pm(by_county: pd.DataFrame) -> pd.Series:
    """Mean over the counties that reported, after taking out each county's usual offset.
    Several counties only sample every third day, so a plain mean jumps with the mix."""
    v = by_county.clip(lower=0)
    # offsets from days when every county reported, so the mix can't leak into them
    full = v.dropna()
    if len(full) < 30:
        full = v[v.notna().sum(axis=1) >= 2]
    offset = full.sub(full.mean(axis=1), axis=0).mean()
    return v.sub(offset, axis=1).mean(axis=1).clip(lower=0)


def load_tmax(start: str, end: str) -> pd.Series:
    p = _get(ERA5.format(start=start, end=end), RAW / f"era5_tmax_{start}_{end}.json")
    d = json.loads(p.read_text())["daily"]
    s = pd.Series(d["temperature_2m_max"], index=pd.to_datetime(d["time"]), dtype=float)
    s.index.name = "date"
    return s


def build(years: list[int]) -> pd.DataFrame:
    print("asthma ED visits")
    visits = load_asthma()
    print(f"  {len(visits)} days, {visits.index.min().date()} to {visits.index.max().date()}")
    print("PM2.5 monitors")
    pm = load_pm(years)
    end = min(visits.index.max(), pd.Timestamp(date.today()) - pd.Timedelta(days=7))
    print("max temperature")
    tmax = load_tmax(visits.index.min().strftime("%Y-%m-%d"), end.strftime("%Y-%m-%d"))
    table = visits.join(pm, how="left").join(tmax.rename("tmax"), how="left")
    table = table.round(3)
    TABLE.parent.mkdir(parents=True, exist_ok=True)
    table.to_csv(TABLE)
    summary = {
        "rows": int(len(table)),
        "first": str(table.index.min().date()),
        "last": str(table.index.max().date()),
        "pm_days": int(table["pm"].notna().sum()),
        "pm_last": str(table["pm"].dropna().index.max().date()),
        "tmax_days": int(table["tmax"].notna().sum()),
    }
    print(json.dumps(summary, indent=2))
    return table


def load_table(path: Path = TABLE) -> pd.DataFrame:
    t = pd.read_csv(path, parse_dates=["date"], index_col="date")
    return t.asfreq("D")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--years", default=f"{FIRST_YEAR}-{date.today().year}")
    a = ap.parse_args()
    lo, hi = (int(x) for x in a.years.split("-"))
    build(list(range(lo, hi + 1)))
