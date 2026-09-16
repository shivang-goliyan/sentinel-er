"""Country table the science service needs at prediction time: region, today's World Bank income
class and the latest GDP per capita, keyed by ISO3 (with the ISO2 code PAGER uses).
Run after build_dataset.py: uv run python ml/casualty/export_meta.py"""
import json
from pathlib import Path

from build_dataset import API_INCOME, CATALOGS, INCOME_ORDER

here = Path(__file__).parent
meta = json.loads((CATALOGS / "wb_countries.json").read_text())[1]
gdp_rows = json.loads((CATALOGS / "wb_gdp_per_capita.json").read_text())[1]

latest = {}
for g in gdp_rows:
    if g["value"] is None:
        continue
    code, year = g["countryiso3code"], int(g["date"])
    if code not in latest or year > latest[code][0]:
        latest[code] = (year, float(g["value"]))

out = {}
for m in meta:
    region = m["region"]["value"].strip()
    if region == "Aggregates":
        continue
    income = API_INCOME.get(m["incomeLevel"]["id"])
    year, value = latest.get(m["id"], (None, None))
    out[m["id"]] = {
        "iso2": m["iso2Code"],
        "name": m["name"],
        "region": region,
        "income_class": INCOME_ORDER.get(income) if income else None,
        "gdp_per_capita": value,
        "gdp_year": year,
    }

(here / "artifacts" / "country_meta.json").write_text(json.dumps(out, separators=(",", ":")) + "\n")
print(f"{len(out)} countries; USA: {out['USA']}")
