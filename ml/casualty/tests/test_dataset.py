import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import build_dataset as bd  # noqa: E402

PAGER_OLD = b"""<?xml version="1.0"?>
<pager ccode="NP">
  <event eventcode="x1" magnitude="7.8" depth="8.2" maxmmi="8.7" localtime="11:56:25" number="9"/>
  <alerts><alert type="fatality" level="red" summary="yes"/></alerts>
  <exposure dmin="6.5" dmax="7.5" exposure="3556392" rangeInsideMap="1"/>
  <exposure dmin="7.5" dmax="8.5" exposure="2884736" rangeInsideMap="1"/>
  <historicevents><historicevent><exposure>999</exposure></historicevent></historicevents>
</pager>"""


def test_pager_bins_map_to_mmi():
    row = bd.parse_pager_xml(PAGER_OLD)
    assert row["pop_mmi7"] == 3556392
    assert row["pop_mmi8"] == 2884736
    assert row["pop_mmi9"] == 0
    assert row["fatality_alert"] == "red"
    assert row["pager_ccode"] == "NP"


def _quakes(rows):
    df = pd.DataFrame(rows, columns=["time", "lat", "lon", "magnitude"])
    df["time"] = pd.to_datetime(df["time"], utc=True)
    return df


def test_join_keeps_nearest_origin():
    left = _quakes([("2020-01-01T00:00:00", 10.0, 20.0, 6.0)])
    right = _quakes([("2020-01-01T00:00:50", 10.1, 20.1, 6.1), ("2020-01-01T00:00:05", 10.2, 20.0, 6.2)])
    right = right.rename(columns={"lat": "latitude", "lon": "longitude", "magnitude": "ncei_mag"})
    right["id"] = [1, 2]
    matched, n = bd.join_by_origin(left, right, ["id"])
    assert n == 1
    assert matched.loc[0, "id"] == 2


def test_join_rejects_distant_quake():
    left = _quakes([("2020-01-01T00:00:00", 10.0, 20.0, 6.0)])
    right = _quakes([("2020-01-01T00:00:10", 12.0, 20.0, 6.0), ("2020-01-01T00:00:10", 10.0, 20.0, 6.9)])
    right = right.rename(columns={"lat": "latitude", "lon": "longitude", "magnitude": "ncei_mag"})
    right["id"] = [1, 2]
    matched, n = bd.join_by_origin(left, right, ["id"])
    assert n == 0
    assert pd.isna(matched.loc[0, "id"])


def test_expocat_halves_edge_columns():
    frame = pd.DataFrame({"U065": [100.0], "U070": [100.0], "U075": [100.0], "R070": [10.0]})
    bins = bd.expocat_bins(frame)
    assert np.isclose(bins.loc[0, "pop_mmi7"], 50 + 100 + 50 + 10)
    assert np.isclose(bins.loc[0, "pop_mmi8"], 50)


def test_windows_grow_with_magnitude():
    d6, t6 = bd.gk_window(6.0)
    d8, t8 = bd.gk_window(8.0)
    assert d8 > d6 and t8 > t6
