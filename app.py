#!/usr/bin/env python3
"""Colorado ZIP Code Finder — Flask web server."""

import json
import os
from pathlib import Path

from flask import Flask, jsonify, render_template, request, send_from_directory

DATA_DIR = Path(__file__).parent / "data"

app = Flask(__name__)

# Load lookup data into memory at startup
def _load(name):
    path = DATA_DIR / name
    if not path.exists():
        print(f"WARNING: {name} not found — run setup.py first")
        return {}
    with open(path) as f:
        return json.load(f)

SEARCH_INDEX    = _load("search_index.json")
COUNTY_OVERLAPS = _load("county_zip_overlaps.json")
PLACE_OVERLAPS  = _load("place_zip_overlaps.json")


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/data/<path:filename>")
def serve_data(filename):
    return send_from_directory(DATA_DIR, filename)


@app.route("/api/search")
def search():
    q = request.args.get("q", "").lower().strip()
    if len(q) < 2:
        return jsonify([])
    results = [item for item in SEARCH_INDEX if q in item["name"].lower()]
    # Rank: starts-with before contains, then alphabetical
    results.sort(key=lambda x: (not x["name"].lower().startswith(q), x["name"].lower()))
    return jsonify(results[:15])


@app.route("/api/zipcodes")
def zipcodes():
    kind = request.args.get("type", "")
    key  = request.args.get("name", "").lower()
    store = COUNTY_OVERLAPS if kind == "county" else PLACE_OVERLAPS
    data  = store.get(key)
    if data is None:
        return jsonify({"error": "Not found"}), 404
    return jsonify(data)


if __name__ == "__main__":
    missing = [f for f in ["search_index.json", "county_zip_overlaps.json", "place_zip_overlaps.json"]
               if not (DATA_DIR / f).exists()]
    if missing:
        print("ERROR: Data files missing. Run: python setup.py")
        raise SystemExit(1)
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", debug=False, port=port)
