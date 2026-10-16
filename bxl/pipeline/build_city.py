#!/usr/bin/env python3
"""
Brussels, by power: city build.

Turns the Brussels Region's 3D buildings (UrbIS 3D Constructions, LoD2, CC0/CC BY, paradigm.brussels)
into compact binary tiles for the web viewer, and joins every mapped institution, mission and
organisation from power.json to the building it sits in.

Tile format and the tile/pack approach follow alexbarakov/amsterdam-by-building (MIT).

Usage:
  pip install shapely pyproj numpy requests
  python build_city.py path/to/UrbISBuildings3D_04000.gpkg ../web/data/power.json
"""
import json, math, sqlite3, struct, sys, collections
from pathlib import Path
import numpy as np, shapely, requests
from shapely import STRtree
from pyproj import Transformer

TILE = 600.0
SIMPLIFY = 0.3
MAGIC = 0x31584242  # 'BBX1'
OUT = Path(__file__).resolve().parent.parent / "web" / "data"
TO_LB = Transformer.from_crs(4326, 31370, always_xy=True)
TO_LL = Transformer.from_crs(31370, 4326, always_xy=True)
ORIGIN = np.array(TO_LB.transform(4.3808, 50.8427))      # Rond-point Schuman
CAT_INDEX = ["none", "eu", "agency", "security", "mission", "corp", "assoc", "consult", "union", "ngo",
             "think", "public", "media", "be", "social", "transit"]


def pad4(b): return b + b"\0" * (-len(b) % 4)
def to_local(xy): return np.c_[xy[:, 0] - ORIGIN[0], -(xy[:, 1] - ORIGIN[1])]


def gpkg_wkb(blob):
    flags = blob[3]
    env = {0: 0, 1: 32, 2: 48, 3: 48, 4: 64}[(flags >> 1) & 7]
    return blob[8 + env:]


def load_buildings(path):
    db = sqlite3.connect(path)
    print("  reading ground surfaces…", flush=True)
    rows = db.execute("SELECT BUSOLID_ID, geom FROM BuildingFaces WHERE TYPE='GROUNDSURFACE'").fetchall()
    gids = [r[0] for r in rows]
    ground = shapely.from_wkb([gpkg_wkb(r[1]) for r in rows])
    print(f"  {len(ground)} ground surfaces; reading roofs…", flush=True)
    roofs = db.execute("SELECT BUSOLID_ID, geom FROM BuildingFaces WHERE TYPE IN ('ROOFSURFACE','OUTERCEILING')").fetchall()
    rgeom = shapely.from_wkb([gpkg_wkb(r[1]) for r in roofs])
    coords, idx = shapely.get_coordinates(rgeom, include_z=True, return_index=True)
    solid_of_roof = np.array([r[0] for r in roofs], dtype=object)[idx]
    zs = collections.defaultdict(list)
    for s, z in zip(solid_of_roof, coords[:, 2]): zs[s].append(z)
    roof_h = {s: float(np.quantile(v, 0.7)) for s, v in zs.items()}
    gcoords, gidx = shapely.get_coordinates(ground, include_z=True, return_index=True)
    gz = np.bincount(gidx, weights=gcoords[:, 2]) / np.maximum(np.bincount(gidx), 1)
    by_solid = collections.defaultdict(list)
    for i, s in enumerate(gids):
        if s not in roof_h: continue
        h = roof_h[s] - gz[i]
        if not (1.5 <= h <= 200): h = min(max(h, 3.0), 200.0)
        g2 = shapely.force_2d(ground[i])
        if g2.is_empty or g2.area < 4: continue
        by_solid[s].append((h, g2))
    print(f"  {len(by_solid)} buildings with footprint and height")
    return by_solid


def assign_places(by_solid, power):
    """Find the building for each mapped place: containing footprint, else nearest within 25 m."""
    solids = list(by_solid)
    feet = [shapely.union_all([g for _, g in by_solid[s]]) if len(by_solid[s]) > 1 else by_solid[s][0][1] for s in solids]
    tree = STRtree(feet)
    places = power["places"]
    out = collections.defaultdict(list)
    for p in places:
        x, y = TO_LB.transform(p["lng"], p["lat"])
        pt = shapely.Point(x, y)
        hit = tree.query(pt, predicate="within") if False else tree.query(pt, predicate="intersects")
        j = None
        if len(hit): j = max(hit, key=lambda k: feet[k].area)
        else:
            k = tree.nearest(pt)
            if k is not None and feet[k].distance(pt) <= 25: j = k
        if j is None:
            p["gid"] = None; continue
        out[solids[j]].append(p)
    return out, tree, solids, feet


BIT_CULTURE, BIT_PROTECTED, BIT_INVENTORY = 20, 21, 22
CULTURE_IDS = set(json.loads((Path(__file__).resolve().parent / "curated.json").read_text()).get("CULTURE_IDS", []))

def enrich(tree, solids, feet):
    """Per-building facts from the heritage inventory, protected heritage and Wikidata (see build_enrich.py)."""
    path = Path(__file__).resolve().parent / "cache" / "enrich_raw.json"
    if not path.exists():
        print("  no enrichment found: run build_enrich.py first"); return {}
    raw = json.loads(path.read_text())
    info = collections.defaultdict(dict)
    def nearest(x, y, maxd):
        pt = shapely.Point(x, y)
        hit = tree.query(pt, predicate="intersects")
        if len(hit): return solids[max(hit, key=lambda k: feet[k].area)]
        k = tree.nearest(pt)
        return solids[k] if k is not None and feet[k].distance(pt) <= maxd else None
    for it in raw["inventory"]:
        s = nearest(it["x"], it["y"], 8)
        if not s: continue
        cur = info[s].get("inv")
        if cur and (cur.get("name") or not it["name"]) and cur.get("img"): continue
        info[s]["inv"] = {k: v for k, v in it.items() if k not in ("x", "y") and v not in ("", None, False)}
    for pr in raw["protected"]:
        g = shapely.make_valid(shapely.geometry.shape(pr["geom"]))
        if g.area > 400000: continue                       # whole landscapes, not buildings
        for k in tree.query(g, predicate="intersects"):
            fk = feet[k] if feet[k].is_valid else shapely.make_valid(feet[k])
            if fk.intersection(g).area >= 0.5 * fk.area:
                info[solids[k]]["prot"] = {"name": pr["name"], "as": pr["as"], "type": pr["type"], "date": pr["date"]}
    for w in raw["wikidata"]:
        x, y = TO_LB.transform(w["lng"], w["lat"])
        s = nearest(x, y, 15 if w["cls"] else 6)
        if not s: continue
        cur = info[s].get("wd")
        score = lambda v: (bool(v.get("cls")), bool(v.get("photo")), bool(v.get("wiki")))
        if cur and score(cur) >= score(w): continue
        info[s]["wd"] = {"qid": w["qid"], "name": w["name"], "desc": w["desc"], "year": w["year"], "arch": w["arch"],
                         "wiki": w["wiki"], "cls": w["cls"], "photo": w["photo"]}
    print(f"  enrichment: {sum(1 for v in info.values() if 'inv' in v)} inventory, {sum(1 for v in info.values() if 'prot' in v)} protected, "
          f"{sum(1 for v in info.values() if 'wd' in v)} Wikidata, {sum(1 for v in info.values() if v.get('wd', {}).get('cls'))} cultural")
    return info


def main():
    gpkg, power_path = sys.argv[1], sys.argv[2]
    power = json.load(open(power_path))
    by_solid = load_buildings(gpkg)
    placed, tree, tsolids, feet = assign_places(by_solid, power)
    info = enrich(tree, tsolids, feet)

    solids = sorted(by_solid)
    gid_of = {s: i for i, s in enumerate(solids)}
    sector_keys = list(power["sectors"])
    bldg_places = {}
    for s, ps in placed.items():
        g = gid_of[s]
        for p in ps: p["gid"] = g
        bldg_places[g] = [p["id"] for p in sorted(ps, key=lambda p: -(p.get("power") or -1))]
    unplaced = [p["n"] for p in power["places"] if p.get("gid") is None]
    print(f"  placed {sum(len(v) for v in placed.values())} places in {len(placed)} buildings; "
          f"{len(unplaced)} outside the building data: {', '.join(unplaced[:8])}")

    # Per-building attributes
    rows = []
    for s in solids:
        g = gid_of[s]; parts = by_solid[s]
        ps = placed.get(s, [])
        top = max(ps, key=lambda p: p.get("power") or -1) if ps else None
        pw = int(round(top["power"])) if top and top.get("power") is not None else -1
        cat = CAT_INDEX.index(top["c"]) if top else 0
        bits = 0
        for p in ps:
            for k in (p.get("sec") or {}):
                bits |= 1 << sector_keys.index(k)
        h = max(h for h, _ in parts)
        c = shapely.centroid(parts[0][1])
        f = info.get(s, {})
        year = (f.get("inv") or {}).get("year") or (f.get("wd") or {}).get("year") or 0
        if not (1000 <= year <= 2030): year = 0
        if (f.get("wd") or {}).get("cls") or any(p["id"] in CULTURE_IDS for p in ps): bits |= 1 << BIT_CULTURE
        if "prot" in f or (f.get("inv") or {}).get("listed"): bits |= 1 << BIT_PROTECTED
        if "inv" in f: bits |= 1 << BIT_INVENTORY
        bx = shapely.bounds(shapely.union_all([gg for _, gg in parts]))
        rad = max(12, int(round(max(bx[2] - bx[0], bx[3] - bx[1]) / 2)))
        rows.append(dict(gid=g, power=pw, cat=cat, hm=min(255, int(round(h))), bits=bits, year=year, info=f, r=rad,
                         parts=[(h, gg.simplify(SIMPLIFY)) for h, gg in parts], cx=c.x, cy=c.y))

    loc = to_local(np.array([[r["cx"], r["cy"]] for r in rows]))
    for r, (x, z) in zip(rows, loc):
        r["tx"], r["tz"], r["x"], r["z"] = int(math.floor(x / TILE)), int(math.floor(z / TILE)), float(x), float(z)

    OUT.mkdir(parents=True, exist_ok=True)
    tiles = collections.defaultdict(list)
    for r in rows: tiles[(r["tx"], r["tz"])].append(r)
    index = []
    for (tx, tz), rs in tiles.items():
        origin = np.array([tx * TILE, tz * TILE])
        index.append(dict(key=f"{tx}_{tz}", data=pack_tile(origin, rs), d=math.hypot(*(origin + TILE / 2))))
        index[-1]["info"] = {str(r["gid"]): r["info"] for r in rs if r["info"]}
    index.sort(key=lambda t: t["d"])
    packs, n_packs, tile_meta = [], 8, []
    per = -(-len(index) // n_packs)
    for k in range(n_packs):
        chunk = index[k * per:(k + 1) * per]
        if not chunk: break
        name, blob, pinfo = f"pack{k}.bin", bytearray(), {}
        for t in chunk:
            pinfo.update(t["info"])
            tile_meta.append(dict(file=t["key"], pack=name, offset=len(blob), length=len(t["data"])))
            blob += t["data"]
        (OUT / name).write_bytes(bytes(blob)); packs.append(name)
        (OUT / f"info{k}.json").write_text(json.dumps(pinfo, ensure_ascii=False, separators=(",", ":")))

    # Places: local coordinates for the viewer
    for p in power["places"]:
        x, y = TO_LB.transform(p["lng"], p["lat"])
        (p["x"], p["z"]), = to_local(np.array([[x, y]])).tolist()
    bpos = {r["gid"]: [round(r["x"], 1), round(r["z"], 1), r["hm"], r["r"]] for r in rows if r["gid"] in bldg_places}
    culture = []
    for r in rows:
        w = (r["info"].get("wd") or {})
        if w.get("cls"):
            culture.append({"gid": r["gid"], "n": w["name"], "k": w["cls"][0], "img": bool(w.get("photo")), "x": round(r["x"], 1), "z": round(r["z"], 1), "h": r["hm"], "r": r["r"]})
    culture.sort(key=lambda c: (not c["img"], c["n"] or ""))
    years = [r["year"] for r in rows if r["year"]]
    hull = shapely.concave_hull(shapely.MultiPoint([(r["cx"], r["cy"]) for r in rows]), ratio=0.04).buffer(120).simplify(20)
    boundary = np.round(to_local(shapely.get_coordinates(hull.exterior)), 1).tolist()
    water, green = landcover(hull)
    city = dict(origin=ORIGIN.tolist(), tileSize=TILE, buildings=len(rows), tiles=tile_meta, packs=packs,
                cats=CAT_INDEX, buildingPlaces={str(k): v for k, v in bldg_places.items()},
                buildingPos={str(k): v for k, v in bpos.items()}, boundary=boundary, water=water, green=green,
                culture=culture, dated=len(years),
                home=dict(x=-350, z=150, azimuth=205, elevation=36, span=5200))
    (OUT / "city.json").write_text(json.dumps(city, separators=(",", ":")))
    json.dump(power, open(power_path, "w"), ensure_ascii=False, separators=(",", ":"))
    print(f"  wrote {len(tile_meta)} tiles in {len(packs)} packs, {sum((OUT / p).stat().st_size for p in packs) / 1e6:.1f} MB")


def pack_tile(origin, rows):
    gid, power, year, cat, hm, bits, part_start = [], [], [], [], [], [], [0]
    heights, ring_start, vert_start, holes, verts = [], [0], [0], [], []
    for b in rows:
        gid.append(b["gid"]); power.append(b["power"]); year.append(b["year"]); cat.append(b["cat"]); hm.append(b["hm"]); bits.append(b["bits"])
        for h, geom in b["parts"]:
            for poly in getattr(geom, "geoms", [geom]):          # every polygon is its own part
                if poly.is_empty or poly.geom_type != "Polygon": continue
                n0 = len(holes)
                for ring, hole in [(poly.exterior, 0)] + [(r, 1) for r in poly.interiors]:
                    c = shapely.get_coordinates(ring)[:-1]
                    if len(c) < 3:
                        if hole == 0: break
                        continue
                    v = np.round((to_local(c) - origin) * 10).astype(np.int16)
                    verts.append(v); holes.append(hole); vert_start.append(vert_start[-1] + len(v))
                if len(holes) > n0:
                    heights.append(h); ring_start.append(len(holes))
        part_start.append(len(heights))
    V = np.concatenate(verts) if verts else np.zeros((0, 2), np.int16)
    out = struct.pack("<5I2f", MAGIC, len(gid), len(heights), len(holes), len(V), *origin)
    out += pad4(np.array(gid, "<u4").tobytes()) + pad4(np.array(power, "<i2").tobytes()) + pad4(np.array(year, "<i2").tobytes())
    out += pad4(np.array(cat, "u1").tobytes()) + pad4(np.array(hm, "u1").tobytes())
    out += pad4(np.array(bits, "<u4").tobytes()) + pad4(np.array(part_start, "<u4").tobytes())
    out += pad4(np.array(heights, "<f4").tobytes()) + pad4(np.array(ring_start, "<u4").tobytes())
    out += pad4(np.array(vert_start, "<u4").tobytes()) + pad4(np.array(holes, "u1").tobytes())
    out += pad4(V.astype("<i2").tobytes())
    return out


def landcover(hull):
    """Water, parks and woods from OpenStreetMap (Overpass), clipped to the city, as local-metre rings."""
    q = ('[out:json][timeout:120];(way["natural"="water"]({b});relation["natural"="water"]({b});'
         'way["leisure"="park"]({b});relation["leisure"="park"]({b});way["landuse"="forest"]({b});'
         'relation["landuse"="forest"]({b});way["natural"="wood"]({b}););out geom;').replace("{b}", "50.76,4.24,50.92,4.48")
    cache = Path(__file__).resolve().parent / "cache" / "osm_land.json"
    if not cache.exists():
        r = requests.post("https://overpass-api.de/api/interpreter", data={"data": q}, timeout=300,
                          headers={"User-Agent": "BrusselsByPower/1.0 (build script)"})
        r.raise_for_status(); cache.write_bytes(r.content)
    els = json.loads(cache.read_text())["elements"]
    def lb(geom): return [TO_LB.transform(pt["lon"], pt["lat"]) for pt in geom]
    out = {"water": [], "green": []}
    for e in els:
        t = e.get("tags", {})
        kind = "water" if t.get("natural") == "water" else "green"
        polys = []
        if e["type"] == "way" and len(e.get("geometry", [])) >= 4 and e["geometry"][0] == e["geometry"][-1]:
            polys = [shapely.Polygon(lb(e["geometry"]))]
        elif e["type"] == "relation":
            outers = [shapely.LineString(lb(m["geometry"])) for m in e.get("members", []) if m.get("role") == "outer" and len(m.get("geometry", [])) >= 2]
            inners = [shapely.LineString(lb(m["geometry"])) for m in e.get("members", []) if m.get("role") == "inner" and len(m.get("geometry", [])) >= 2]
            o = shapely.union_all(list(shapely.polygonize(outers).geoms)) if outers else None
            if o is not None and not o.is_empty:
                if inners:
                    i = shapely.union_all(list(shapely.polygonize(inners).geoms))
                    if not i.is_empty: o = o.difference(i)
                polys = list(getattr(o, "geoms", [o]))
        for poly in polys:
            if not poly.is_valid: poly = poly.buffer(0)
            poly = poly.intersection(hull).simplify(1.5)
            for g in getattr(poly, "geoms", [poly]):
                if g.geom_type != "Polygon" or g.area < 600: continue
                rings = [np.round(to_local(shapely.get_coordinates(g.exterior)[:-1]), 1).tolist()]
                rings += [np.round(to_local(shapely.get_coordinates(h)[:-1]), 1).tolist() for h in g.interiors if shapely.Polygon(h).area > 200]
                out[kind].append(rings)
    print(f"  landcover: {len(out['water'])} water, {len(out['green'])} green polygons")
    return out["water"], out["green"]


def region_boundary():
    """Outline of the Brussels-Capital Region (OpenStreetMap via Nominatim), in local metres."""
    try:
        r = requests.get("https://nominatim.openstreetmap.org/search", timeout=60,
                         params={"q": "Brussels-Capital Region", "polygon_geojson": 1, "format": "json", "limit": 1,
                                 "polygon_threshold": 0.0003},
                         headers={"User-Agent": "BrusselsByPower/1.0 (build script)"})
        geo = r.json()[0]["geojson"]
        ring = geo["coordinates"][0] if geo["type"] == "Polygon" else max(geo["coordinates"], key=lambda p: len(p[0]))[0]
        xy = np.array([TO_LB.transform(lon, lat) for lon, lat in ring])
        return np.round(to_local(xy), 1).tolist()
    except Exception as e:
        print("  boundary unavailable:", e); return None


if __name__ == "__main__":
    main()
