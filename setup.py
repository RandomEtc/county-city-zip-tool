#!/usr/bin/env python3
"""
One-time data preparation script for the Colorado ZIP Code Finder.
Downloads Census shapefiles, computes ZCTA overlaps, saves results to data/.
Run: python setup.py
"""

import json
import os
import sys
from pathlib import Path

import geopandas as gpd
import requests
from shapely.strtree import STRtree

BASE_DIR = Path(__file__).parent
DOWNLOADS_DIR = BASE_DIR / "downloads"
DATA_DIR = BASE_DIR / "data"

DOWNLOADS_DIR.mkdir(exist_ok=True)
DATA_DIR.mkdir(exist_ok=True)

SOURCES = {
    "zcta":   "https://www2.census.gov/geo/tiger/GENZ2020/shp/cb_2020_us_zcta520_500k.zip",
    "county": "https://www2.census.gov/geo/tiger/GENZ2020/shp/cb_2020_us_county_500k.zip",
    "place":  "https://www2.census.gov/geo/tiger/TIGER2025/PLACE/tl_2025_08_place.zip",
}

CO_FIPS = "08"  # Colorado state FIPS code

TARGET_CRS = "EPSG:26913"   # NAD83 / UTM Zone 13N — accurate area calcs for Colorado
WEB_CRS    = "EPSG:4326"    # WGS84 — for Leaflet

SIMPLIFY_M = 0              # no simplification — source files are already appropriately sized
ZCTA_MIN_COVERAGE = 0.10    # include ZCTAs with >= 10% inside target
ZCTA_PRIMARY_COVERAGE = 0.50


def download(key: str, url: str) -> Path:
    dest = DOWNLOADS_DIR / f"{key}.zip"
    if dest.exists():
        print(f"  [skip] {key}.zip already downloaded")
        return dest
    print(f"  Downloading {key} from {url} ...")
    with requests.get(url, stream=True, timeout=300) as r:
        r.raise_for_status()
        total = int(r.headers.get("content-length", 0))
        downloaded = 0
        with open(dest, "wb") as f:
            for chunk in r.iter_content(chunk_size=1 << 20):
                f.write(chunk)
                downloaded += len(chunk)
                if total:
                    pct = downloaded * 100 // total
                    print(f"\r    {pct}% ({downloaded // 1024 // 1024}MB / {total // 1024 // 1024}MB)", end="", flush=True)
        print()
    print(f"  Saved {dest.stat().st_size // 1024 // 1024}MB to {dest.name}")
    return dest


def compute_overlaps(targets_proj, zctas_proj, name_col):
    """
    Returns dict keyed by lowercase target name:
      { "denver": { "display_name": "Denver", "zips": [...] } }
    """
    zctas_proj = zctas_proj.copy()
    zctas_proj["_area"] = zctas_proj.geometry.area

    # Build spatial index over ZCTAs for fast candidate lookup
    zcta_geoms = list(zctas_proj.geometry)
    tree = STRtree(zcta_geoms)

    result = {}
    n = len(targets_proj)
    for i, (_, target_row) in enumerate(targets_proj.iterrows()):
        display_name = str(target_row[name_col]).strip()
        target_geom  = target_row.geometry
        target_area  = target_geom.area
        print(f"\r  [{i+1}/{n}] {display_name:<40}", end="", flush=True)

        # STRtree query returns indices of candidate ZCTAs
        candidate_idxs = tree.query(target_geom, predicate="intersects")
        candidates = zctas_proj.iloc[candidate_idxs]

        zips = []
        for _, zcta_row in candidates.iterrows():
            intersection = zcta_row.geometry.intersection(target_geom)
            inter_area = intersection.area
            if inter_area < 1:
                continue
            zcta_coverage = inter_area / zcta_row["_area"]
            area_coverage = inter_area / target_area if target_area > 0 else 0

            if zcta_coverage >= ZCTA_MIN_COVERAGE or area_coverage >= ZCTA_MIN_COVERAGE:
                zips.append({
                    "zip":           zcta_row["ZCTA5CE20"],
                    "zcta_coverage": round(zcta_coverage, 4),
                    "area_coverage": round(area_coverage, 4),
                    "primary":       zcta_coverage >= ZCTA_PRIMARY_COVERAGE,
                })

        zips.sort(key=lambda x: (-int(x["primary"]), -x["zcta_coverage"]))
        result[display_name.lower()] = {
            "display_name": display_name,
            "zips": zips,
        }

    print()
    return result


def main():
    print("=== Colorado ZIP Code Finder — Data Setup ===\n")

    # 1. Download files
    print("Step 1: Downloading Census shapefiles")
    paths = {k: download(k, url) for k, url in SOURCES.items()}

    # 2. Load county file — national, filter to Colorado by STATEFP
    print("\nStep 2: Loading Colorado counties")
    counties_all = gpd.read_file(f"zip://{paths['county']}", engine="pyogrio")
    counties = counties_all[counties_all["STATEFP"] == CO_FIPS].copy()
    print(f"  Loaded {len(counties)} Colorado counties (of {len(counties_all)} national), CRS={counties.crs}")

    co_state = counties.geometry.union_all()
    co_bbox  = co_state.bounds  # (minx, miny, maxx, maxy)
    print(f"  Colorado bbox: {tuple(round(x, 3) for x in co_bbox)}")

    # 3. Load and filter ZCTAs to Colorado
    print("\nStep 3: Filtering ZCTAs to Colorado")
    print("  Loading national ZCTA file with bbox pre-filter...")
    zctas_all = gpd.read_file(f"zip://{paths['zcta']}", bbox=co_bbox, engine="pyogrio")
    print(f"  Bbox pre-filter: {len(zctas_all)} candidates")

    zctas_all = zctas_all.to_crs(counties.crs)
    co_zctas = zctas_all[zctas_all.geometry.intersects(co_state)].copy()
    print(f"  Precise filter: {len(co_zctas)} Colorado ZCTAs")

    # 4. Load places
    print("\nStep 4: Loading Colorado places")
    places = gpd.read_file(f"zip://{paths['place']}", engine="pyogrio")
    places = places.to_crs(counties.crs)
    print(f"  Loaded {len(places)} places, CRS={places.crs}")

    # 5. Project to UTM for area calculations
    print("\nStep 5: Projecting to UTM Zone 13N (EPSG:26913)")
    counties_proj = counties.to_crs(TARGET_CRS)
    places_proj   = places.to_crs(TARGET_CRS)
    zctas_proj    = co_zctas.to_crs(TARGET_CRS)

    # 6. Export geometries for web (no additional simplification — sources are already sized well)
    print("\nStep 6: Exporting geometries")

    def save_geojson(gdf_proj, props, out_path):
        gdf_web = gdf_proj[["geometry"] + props].to_crs(WEB_CRS)
        gdf_web.to_file(out_path, driver="GeoJSON")
        size_kb = os.path.getsize(out_path) // 1024
        print(f"  Saved {out_path.name} ({size_kb}KB, {len(gdf_web)} features)")

    save_geojson(zctas_proj,    ["ZCTA5CE20"],                   DATA_DIR / "co_zctas.geojson")
    save_geojson(counties_proj, ["NAME", "GEOID"],               DATA_DIR / "co_counties.geojson")
    save_geojson(places_proj,   ["NAME", "PLACEFP", "CLASSFP"],  DATA_DIR / "co_places.geojson")

    # 7. Compute overlaps
    print("\nStep 7: Computing county-ZCTA overlaps")
    county_overlaps = compute_overlaps(counties_proj, zctas_proj, "NAME")
    with open(DATA_DIR / "county_zip_overlaps.json", "w") as f:
        json.dump(county_overlaps, f)
    print(f"  Saved county_zip_overlaps.json ({len(county_overlaps)} counties)")

    print("\nStep 8: Computing place-ZCTA overlaps")
    place_overlaps = compute_overlaps(places_proj, zctas_proj, "NAME")
    with open(DATA_DIR / "place_zip_overlaps.json", "w") as f:
        json.dump(place_overlaps, f)
    print(f"  Saved place_zip_overlaps.json ({len(place_overlaps)} places)")

    # 8. Build search index
    print("\nStep 9: Building search index")
    index = []
    for name, data in county_overlaps.items():
        index.append({"name": data["display_name"], "type": "county", "key": name})
    for name, data in place_overlaps.items():
        index.append({"name": data["display_name"], "type": "place",  "key": name})
    index.sort(key=lambda x: x["name"].lower())
    with open(DATA_DIR / "search_index.json", "w") as f:
        json.dump(index, f)
    print(f"  Saved search_index.json ({len(index)} entries)")

    print("\n=== Setup complete! Run: python app.py ===")


if __name__ == "__main__":
    main()
