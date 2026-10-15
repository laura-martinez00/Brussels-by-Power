#!/usr/bin/env python3
"""
Brussels, by power: building enrichment.

Downloads, for every building it can match:
  - the Brussels heritage inventory (urban.brussels, Irismonument): year built, architects, style, type, photo, record link
  - classified / protected heritage (urban.brussels)
  - Wikidata places with coordinates in the Brussels-Capital Region: name, description, photo (Wikimedia Commons,
    with author and licence), inception, architect, Wikipedia article; cultural places become their own map layer

Writes enrich.json (per-building facts) for build_city.py to pack per tile.
Usage:  python build_enrich.py [--refresh]
"""
import json, re, sys, time, collections
from pathlib import Path
import requests

HERE = Path(__file__).resolve().parent
CACHE = HERE / "cache"; CACHE.mkdir(exist_ok=True)
UA = {"User-Agent": "BrusselsByPower/1.0 (open-data map; build script)"}
WFS = "https://gis.urban.brussels/geoserver/ows"

# Wikidata classes that make a place part of the culture layer (matched through subclass-of)
CULTURE = {
    "Q33506": "Museum", "Q207694": "Art museum", "Q1007870": "Art gallery", "Q24354": "Theatre", "Q153562": "Opera house",
    "Q1060829": "Concert hall", "Q1329623": "Cultural centre", "Q2190251": "Arts centre", "Q7075": "Library",
    "Q41253": "Cinema", "Q16970": "Church", "Q2977": "Cathedral", "Q32815": "Mosque", "Q34627": "Synagogue",
    "Q16560": "Palace", "Q23413": "Castle", "Q4989906": "Monument", "Q57821": "Fortification", "Q12280": "Bridge",
    "Q1752346": "Parliament building", "Q483453": "Fountain", "Q11315": "Shopping arcade",
}


def cached(name, fn, refresh):
    p = CACHE / name
    if p.exists() and not refresh: return json.loads(p.read_text())
    data = fn(); p.write_text(json.dumps(data, ensure_ascii=False)); return data


def wfs_all(layer, page=10000):
    feats, start = [], 0
    while True:
        r = requests.get(WFS, params={"service": "WFS", "version": "2.0.0", "request": "GetFeature", "typeNames": layer,
                                      "outputFormat": "application/json", "count": page, "startIndex": start,
                                      "srsName": "EPSG:31370", "sortBy": "ID_BATI_DMS" if "Irismonument" in layer else "ID"},
                         headers=UA, timeout=300)
        r.raise_for_status()
        f = r.json()["features"]; feats += f; start += page
        print(f"    {layer}: {len(feats)}", flush=True)
        if len(f) < page: return feats


def sparql(q):
    for attempt in range(4):
        r = requests.get("https://query.wikidata.org/sparql", params={"query": q, "format": "json"}, headers=UA, timeout=300)
        if r.ok: return r.json()["results"]["bindings"]
        time.sleep(10 * (attempt + 1))
    r.raise_for_status()


def wikidata():
    vals = " ".join("wd:" + k for k in CULTURE)
    q = f"""
    SELECT ?item ?itemLabel ?itemDescription ?coord ?img ?inception ?archLabel ?article ?cls WHERE {{
      ?item wdt:P131+ wd:Q240 ; wdt:P625 ?coord .
      OPTIONAL {{ ?item wdt:P18 ?img }}
      OPTIONAL {{ ?item wdt:P571 ?inception }}
      OPTIONAL {{ ?item wdt:P84 ?arch }}
      OPTIONAL {{ ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> }}
      OPTIONAL {{ VALUES ?cls {{ {vals} }} ?item wdt:P31/wdt:P279* ?cls }}
      SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en,fr,nl" }}
    }}"""
    rows = sparql(q)
    items = {}
    for r in rows:
        qid = r["item"]["value"].rsplit("/", 1)[1]
        it = items.setdefault(qid, {"qid": qid, "name": r.get("itemLabel", {}).get("value"), "desc": r.get("itemDescription", {}).get("value"),
                                    "coord": r["coord"]["value"], "img": None, "year": None, "arch": set(), "wiki": None, "cls": set()})
        if "img" in r: it["img"] = r["img"]["value"].rsplit("/", 1)[1]
        if "inception" in r and not it["year"]:
            m = re.match(r"(-?\d{1,4})", r["inception"]["value"].lstrip("+")); it["year"] = int(m.group(1)) if m else None
        if "archLabel" in r: it["arch"].add(r["archLabel"]["value"])
        if "article" in r: it["wiki"] = r["article"]["value"].rsplit("/", 1)[1]
        if "cls" in r: it["cls"].add(CULTURE[r["cls"]["value"].rsplit("/", 1)[1]])
    out = []
    for it in items.values():
        if re.match(r"^Q\d+$", it["name"] or ""): continue
        m = re.match(r"Point\(([-\d.]+) ([-\d.]+)\)", it["coord"])
        if not m: continue
        it["lng"], it["lat"] = float(m.group(1)), float(m.group(2))
        it["arch"] = sorted(it["arch"]); it["cls"] = sorted(it["cls"])
        out.append(it)
    return out


def commons_credits(files):
    """Author and licence for each Commons file, 50 at a time."""
    out = {}
    files = sorted(set(f for f in files if f))
    for i in range(0, len(files), 50):
        batch = files[i:i + 50]
        js = None
        for attempt in range(5):
            try:
                r = requests.post("https://commons.wikimedia.org/w/api.php", headers=UA, timeout=120, data={
                    "action": "query", "format": "json", "prop": "imageinfo", "iiprop": "extmetadata|url", "iiurlwidth": 640,
                    "titles": "|".join("File:" + requests.utils.unquote(f) for f in batch)})
                js = r.json(); break
            except Exception:
                time.sleep(5 * (attempt + 1))
        if js is None:
            print(f"    skipped a batch of {len(batch)} files (Commons unavailable)"); continue
        for page in js.get("query", {}).get("pages", {}).values():
            ii = (page.get("imageinfo") or [{}])[0]; em = ii.get("extmetadata", {})
            artist = re.sub(r"<[^>]+>", "", em.get("Artist", {}).get("value", "")).strip()
            lic = em.get("LicenseShortName", {}).get("value", "")
            title = page.get("title", "")[5:]
            out[title.replace(" ", "_")] = {"thumb": ii.get("thumburl"), "page": ii.get("descriptionurl"),
                                            "credit": ", ".join(x for x in (artist[:80], lic) if x)}
        time.sleep(0.3)
        if i % 500 == 0: print(f"    commons credits {i}/{len(files)}", flush=True)
    return out


def main():
    refresh = "--refresh" in sys.argv
    print("1/4 Heritage inventory (urban.brussels)")
    inv = cached("inventory.json", lambda: wfs_all("URBAN_DCH_IBH:Irismonument_inventory"), refresh)
    print("2/4 Protected heritage")
    prot = cached("protected.json", lambda: wfs_all("URBAN_DCH_IBH:Classified_or_protected_built_heritage"), refresh)
    print("3/4 Wikidata")
    wd = cached("wikidata.json", wikidata, refresh)
    print(f"    {len(wd)} Wikidata places, {sum(1 for w in wd if w['cls'])} cultural")
    print("4/4 Wikimedia Commons credits")
    credits = cached("commons.json", lambda: commons_credits([w["img"] for w in wd]), refresh)

    inventory = []
    for f in inv:
        p, g = f["properties"], f["geometry"]
        if not g: continue
        x, y = g["coordinates"][:2]
        year = re.match(r"\d{4}", p.get("BULT") or "")
        inventory.append({"x": x, "y": y, "name": p.get("NOM_FR") or p.get("NOM_NL") or "",
                          "addr": f'{p.get("STREET_FR", "")} {p.get("NUMBER", "")}'.strip(), "year": int(year.group(0)) if year else None,
                          "style": p.get("STYLE_FR") or "", "type": p.get("TYPO_FR") or "", "arch": p.get("INTERVENANTS") or "",
                          "img": p.get("FIRSTIMAGE") or "", "url": p.get("URL_FR") or "", "listed": bool(p.get("LISTED")),
                          "unesco": bool(p.get("UNESCO"))})
    protected = [{"geom": f["geometry"], "name": f["properties"].get("BENAMING_FR"), "as": f["properties"].get("BESCHERMD_ALS_FR"),
                  "type": f["properties"].get("TYPE_VRIJWARING_FR"), "date": f["properties"].get("DATUM_AG2") or f["properties"].get("DATUM_AG1")}
                 for f in prot if f.get("geometry")]
    for w in wd:
        c = credits.get((w["img"] or "").replace(" ", "_")) if w["img"] else None
        w["photo"] = c
    json.dump({"inventory": inventory, "protected": protected, "wikidata": wd},
              open(HERE / "cache" / "enrich_raw.json", "w"), ensure_ascii=False)
    print(f"Done: {len(inventory)} inventoried buildings, {len(protected)} protected, {len(wd)} Wikidata places.")


if __name__ == "__main__":
    main()
