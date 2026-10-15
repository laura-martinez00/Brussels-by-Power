#!/usr/bin/env python3
"""
Brussels Power Map – data build.

Downloads the official open data, scores every Brussels-based organisation in the
EU Transparency Register, geocodes the top ones with the Brussels Region's UrbIS
geocoder, and writes the result into the map's HTML template.

Sources (all official, all open):
  - EU Transparency Register, full export (XML), updated daily
  - European Commission meetings with interest representatives:
      Commissioners & cabinets (2024-2029 term) and Directors-General / senior management
  - Eurostat tps00001, population on 1 January (Council voting weights)
  - UrbIS geocoder, Brussels Capital Region (paradigm.brussels)

Usage:
  pip install lxml pandas openpyxl requests
  python build_power_data.py              # uses cached downloads if < 1 day old
  python build_power_data.py --refresh    # force fresh downloads
Outputs:
  power.json                      the dataset on its own
  ../web/data/power.json          the dataset merged with curated places, for the viewer
"""
import json, math, os, re, sys, time, collections, datetime as dt
import requests, pandas as pd
from lxml import etree

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, "cache"); os.makedirs(CACHE, exist_ok=True)
UA = {"User-Agent": "BrusselsPowerMap/1.0 (open-data build script)"}

TERM_START = "2024-12-01"   # von der Leyen II Commission took office
TOP_N = 150                 # how many registrants to place on the map
LOBBY_CEILING = 60          # editorial: max overall power an outside interest can reach

# Influence index weights (sum to 1)
WEIGHTS = {
    "top":   0.35,  # meetings with Commissioners and their cabinets this term
    "dg":    0.15,  # meetings with Directors-General and senior management this term
    "spend": 0.25,  # declared annual EU lobbying costs (range midpoint)
    "fte":   0.15,  # lobbyists, full-time equivalent
    "ep":    0.10,  # European Parliament access badges
}

# Policy sectors: Commission departments and the cabinets that oversee them
SECTORS = {
    "digital":     ("Digital & tech",                 ["CNECT", "DIGIT"],          ["Virkkunen"]),
    "energy":      ("Energy & climate",               ["ENER", "CLIMA"],           ["Jørgensen", "Hoekstra"]),
    "environment": ("Environment & circular economy", ["ENV"],                     ["Roswall"]),
    "industry":    ("Industry & single market",       ["GROW"],                    ["Séjourné"]),
    "finance":     ("Finance, tax & economy",         ["FISMA", "TAXUD", "ECFIN"], ["Albuquerque", "Dombrovskis"]),
    "trade":       ("Trade",                          ["TRADE"],                   ["Šefčovič"]),
    "competition": ("Competition",                    ["COMP"],                    ["Ribera"]),
    "agrifood":    ("Agriculture, food & fisheries",  ["AGRI", "MARE"],            ["Hansen", "Kadis"]),
    "health":      ("Health",                         ["SANTE", "HERA"],           ["Várhelyi"]),
    "transport":   ("Transport",                      ["MOVE"],                    ["Tzitzikostas"]),
    "defence":     ("Defence & space",                ["DEFIS"],                   ["Kubilius"]),
    "research":    ("Research & innovation",          ["RTD"],                     ["Zaharieva"]),
}

TYPE_MAP = {  # Transparency Register category -> map layer
    "Companies & groups": "corp", "Companies  groups": "corp",
    "Trade and business associations": "assoc",
    "Professional consultancies": "consult", "Law firms": "consult", "Self-employed individuals": "consult",
    "Trade unions and professional associations": "union",
    "Non-governmental organisations, platforms and networks and similar": "ngo",
    "Organisations representing churches and religious communities": "ngo",
    "Think tanks and research institutions": "think", "Academic institutions": "think",
    "Associations and networks of public authorities": "public",
    "Other organisations, public or mixed entities": "public",
    "Entities, offices or networks established by third countries": "public",
}

# Organisations always included (already on the map's curated layers)
PINNED = {
    "3978240953-79": "businesseurope", "5265780509-97": "amcham", "64270747023-20": "digitaleurope",
}
PINNED_NAMES = [  # matched against registered names when the ID isn't known
    ("etuc", r"^european trade union confederation"),
    ("copa", r"^copa\b|^copa-cogeca|^copa ?\(|european farmers"),
    ("beuc", r"^bureau europ[ée]en des unions de consommateurs|^beuc\b"),
    ("tieu", r"^transparency international liaison office to the eu|^transparency international eu"),
    ("ceo",  r"^corporate europe observatory"),
    ("bruegel", r"^bruegel"),
    ("ceps", r"^centre for european policy studies|^ceps\b"),
    ("epc",  r"^european policy centre"),
    ("carnegie", r"^carnegie europe"),
    ("friends", r"^friends of europe"),
    ("egmont", r"^egmont"),
]

# Permanent representations of the 27 member states (addresses: EEAS contact list,
# updated from the representations' own sites where they have moved)
PERMREPS = [
    ("AT","Austria","Avenue de Cortenbergh 30","1040"), ("BE","Belgium","Rue Belliard 65","1040"),
    ("BG","Bulgaria","Square Marie-Louise 49","1000"), ("HR","Croatia","Rue d'Arlon 108","1000"),
    ("CY","Cyprus","Avenue de Cortenbergh 61","1000"), ("CZ","Czechia","Rue Caroly 15","1050"),
    ("DK","Denmark","Rue d'Arlon 73","1040"), ("EE","Estonia","Rue Guimard 11","1040"),
    ("FI","Finland","Avenue de Cortenbergh 80","1000"), ("FR","France","Place de Louvain 14","1000"),
    ("DE","Germany","Rue Jacques de Lalaing 8","1040"), ("EL","Greece","Rue Jacques de Lalaing 19","1040"),
    ("HU","Hungary","Rue de Trèves 92","1040"), ("IE","Ireland","Rue Froissart 50","1040"),
    ("IT","Italy","Rue du Marteau 9","1000"), ("LV","Latvia","Avenue des Arts 23","1000"),
    ("LT","Lithuania","Rue Belliard 41","1040"), ("LU","Luxembourg","Avenue de Cortenbergh 75","1040"),
    ("MT","Malta","Rue Archimède 25","1000"), ("NL","the Netherlands","Rue de Trèves 31","1040"),
    ("PL","Poland","Rue Stevin 139","1000"), ("PT","Portugal","Avenue de Cortenbergh 12","1040"),
    ("RO","Romania","Rue Montoyer 12","1000"), ("SK","Slovakia","Avenue de Cortenbergh 79","1000"),
    ("SI","Slovenia","Boulevard du Régent 45","1000"), ("ES","Spain","Boulevard du Régent 52","1000"),
    ("SE","Sweden","Square de Meeûs 30","1000"),
]

URLS = {
    "tr.xml": "https://transparency-register.europa.eu/odplastorganisationxml_en",
    "cab.xlsx": "https://ec.europa.eu/transparency-initiative/meetings/data/meetings/dataxlsx?name=meetingscommissionrepresentatives2429",
    "dg.xlsx": "https://ec.europa.eu/transparency-initiative/meetings/data/meetings/dataxlsx?name=meetingsdirectorgenerals",
    "pop.json": "https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/tps00001?format=JSON&lang=EN&sinceTimePeriod=2023",
}

def fetch(name, refresh=False):
    path = os.path.join(CACHE, name)
    if not refresh and os.path.exists(path) and time.time() - os.path.getmtime(path) < 86400:
        return path
    print(f"  downloading {name}…", flush=True)
    r = requests.get(URLS[name], headers=UA, timeout=600); r.raise_for_status()
    open(path, "wb").write(r.content)
    return path

def brussels_postcode(pc):
    m = re.match(r"\s*(?:B-?)?(\d{4})", str(pc or ""))
    return m and 1000 <= int(m.group(1)) <= 1210 and m.group(1)

def text(el, path):
    v = el.findtext(path); return v.strip() if v else ""

def parse_register(path):
    orgs = {}; export_date = None
    for ev, el in etree.iterparse(path, events=("end",), recover=True, huge_tree=True):
        if el.tag == "exportDate": export_date = (el.text or "")[:10]
        if el.tag != "interestRepresentative": continue
        office = el.find("EUOffice")
        if office is None or text(office, "country").upper() != "BELGIUM": office = el.find("headOffice")
        if office is None or text(office, "country").upper() != "BELGIUM" or not brussels_postcode(text(office, "postCode")):
            el.clear(); continue
        cy = el.find("financialData/closedYear")
        lo = hi = None; budget = None
        no_cost_field = cy is not None and "NGO" in (cy.get("type") or "")
        if cy is not None and cy.find("totalBudget") is not None:
            b = cy.findtext("totalBudget/absoluteCost"); budget = float(b) if b else None
        if cy is not None:
            for tag in ("costs", "totalAnnualRevenue"):
                c = cy.find(tag)
                if c is None: continue
                a = c.findtext("absoluteCost") or c.findtext(".//absoluteCost")
                mn, mx = c.findtext(".//min"), c.findtext(".//max")
                if a: lo = hi = float(a)
                elif mn or mx: lo, hi = float(mn or 0), float(mx or mn or 0)
                if lo is not None: break
        oid = text(el, "identificationCode")
        orgs[oid] = {
            "id": oid, "name": text(el, "name/originalName"), "acr": text(el, "acronym"),
            "cat": text(el, "registrationCategory"),
            "street": text(office, "address"), "pc": brussels_postcode(text(office, "postCode")),
            "fte": float(text(el, "members/membersFTE") or 0),
            "ep": int(text(el, "EPAccreditedNumber") or 0),
            "spend": [lo, hi] if lo is not None else None,
            "budget": budget, "noCostField": no_cost_field,
            "web": text(el, "webSiteURL"),
            "interests": [i.text for i in el.findall("interests/interest/name") if i.text],
        }
        el.clear()
    return orgs, export_date

def sector_of(dg=None, cabinet=None):
    for k, (_, dgs, cabs) in SECTORS.items():
        if dg and dg in dgs: return k
        if cabinet and any(c in cabinet for c in cabs): return k
    return None

def parse_meetings(cab_path, dg_path):
    stats = collections.defaultdict(lambda: {"top": 0, "dg": 0, "sec": collections.Counter(),
                                             "who": collections.Counter(), "last": "", "wk": collections.Counter()})
    latest = ""; weekly = collections.Counter(); t0 = pd.Timestamp(TERM_START)
    def rows(path):
        x = pd.read_excel(path, header=1); x.columns = [str(c).strip() for c in x.columns]
        x["Date of meeting"] = pd.to_datetime(x["Date of meeting"], errors="coerce")
        return x[x["Date of meeting"] >= TERM_START]
    for kind, path in (("top", cab_path), ("dg", dg_path)):
        for _, r in rows(path).iterrows():
            d = r["Date of meeting"].strftime("%Y-%m-%d"); latest = max(latest, d)
            wk = int((r["Date of meeting"] - t0).days // 7); weekly[wk] += 1
            if kind == "top":
                who = str(r["Name of cabinet"]).replace("Cabinet of ", "")
                sec = sector_of(cabinet=who)
            else:
                who = f"DG {r['Name of DG/EA - acronym']}"
                sec = sector_of(dg=str(r["Name of DG/EA - acronym"]))
            ids = {i.strip() for i in str(r["Transparency register ID"]).split(",") if i.strip() and i.strip() != "nan"}
            for oid in ids:
                s = stats[oid]; s[kind] += 1; s["who"][who] += 1; s["last"] = max(s["last"], d); s["wk"][wk] += 1
                if sec: s["sec"][sec] += 1
    n = max(weekly) + 1 if weekly else 0
    return stats, latest, [weekly.get(i, 0) for i in range(n)]

def norm(v, top):
    """Square-root scaling against the most active organisation: keeps the leaders apart
    while not letting a handful of giants flatten everyone else to zero."""
    return 0 if not v or top <= 0 else min(1, math.sqrt(v / top))

STREET_WORDS = (r"(?:Rue|Avenue|Av\.?|Boulevard|Bd|Square|Place|Rond[- ]?[Pp]oint|Chauss[ée]e|Cours|Quai|Galerie|Esplanade|"
                r"Parvis|All[ée]e|Impasse|Drève|Montagne|Mont|[A-Z][\w'-]*(?:straat|laan|plein|steenweg|lei|dreef))")

def address_candidates(street):
    street = re.sub(r",\s*(?=\d)", " ", street)
    s = re.sub(r"(\d)\d(?:st|nd|rd|th)\.?\s*[Ff]loor", r"\1", street)       # "Rue X 616th floor" -> "Rue X 61"
    s = re.sub(r"(?i)\b(?:bo[iî]te|bus|box|b\.|floor|level|étage|etage|c/o)\b.*$", "", s)
    s = re.sub(r"(?<=[a-zé\d])(?=[A-Z])", " | ", s)                            # split glued address lines
    cands = []
    for m in re.finditer(STREET_WORDS + r"[^|,\d]*\d+[A-Za-z]?\b", s, re.I):
        cands.append(m.group(0))
    for m in re.finditer(r"(?<!\d)(\d+[A-Za-z]?),?\s+(" + STREET_WORDS + r"[^|,\d]*)", s, re.I):   # "4 Rue de la Science"
        cands.append(f"{m.group(2).strip()} {m.group(1)}")
    cands.append(s.replace(" | ", " "))
    out = []
    for c in cands:
        c = re.sub(r"\s*/\s*", " ", c)
        c = re.sub(r"(\d+)\s*[-–]\s*\d+", r"\1", c).replace(",", " ")
        c = re.sub(r"\s+", " ", c).strip()
        if c and c not in out: out.append(c)
    return out

def geocode(street, pc, cache):
    key = f"{street}|{pc}"
    if cache.get(key): return cache[key]
    res = None
    for q in address_candidates(street):
        for lang in ("fr", "nl"):
            try:
                r = requests.get("https://geoservices.irisnet.be/localization/Rest/Localize/getaddresses",
                                 params={"spatialReference": 4326, "language": lang, "address": f"{q} {pc}"},
                                 headers=UA, timeout=30)
                hits = r.json().get("result") or []
                if hits and hits[0].get("score", 0) >= 70 and hits[0]["qualificationCode"].get("policeNumber") == "1":
                    p = hits[0]["point"]; res = [round(p["y"], 6), round(p["x"], 6)]
            except Exception as e:
                print("   geocode error", q, e)
            time.sleep(0.1)
            if res: break
        if res: break
    cache[key] = res
    return res

def main():
    refresh = "--refresh" in sys.argv
    print("1/5 Downloading open data")
    paths = {k: fetch(k, refresh) for k in URLS}

    print("2/5 Parsing the Transparency Register (Brussels-based registrants)")
    orgs, export_date = parse_register(paths["tr.xml"])
    print(f"    {len(orgs)} registrants with a Brussels office")

    print("3/5 Counting Commission meetings since", TERM_START)
    meet, latest, weekly = parse_meetings(paths["cab.xlsx"], paths["dg.xlsx"])

    # raw metrics
    for o in orgs.values():
        m = meet.get(o["id"])
        o["top"] = m["top"] if m else 0
        o["dg"] = m["dg"] if m else 0
        o["sec"] = dict(m["sec"]) if m else {}
        o["who"] = m["who"].most_common(3) if m else []
        o["last"] = m["last"] if m else ""
        o["wk"] = dict(m["wk"]) if m else {}
        o["spend_mid"] = sum(o["spend"]) / 2 if o["spend"] else 0
    maxes = {k: max((o[f] for o in orgs.values()), default=0) for k, f in
             (("top", "top"), ("dg", "dg"), ("spend", "spend_mid"), ("fte", "fte"), ("ep", "ep"))}
    sec_max = {s: max((o["sec"].get(s, 0) for o in orgs.values()), default=0) for s in SECTORS}
    for o in orgs.values():
        parts = {"top": norm(o["top"], maxes["top"]), "dg": norm(o["dg"], maxes["dg"]),
                 "spend": norm(o["spend_mid"], maxes["spend"]), "fte": norm(o["fte"], maxes["fte"]),
                 "ep": norm(o["ep"], maxes["ep"])}
        w = dict(WEIGHTS)
        if o["noCostField"] and not o["spend"]:
            # NGO-type registrations report a total budget, not lobbying costs:
            # score them on the other four measures, re-weighted to sum to 1
            w.pop("spend"); parts.pop("spend"); t = sum(w.values()); w = {k: v / t for k, v in w.items()}
        o["parts"] = {k: round(v * 100) for k, v in parts.items()}
        o["influence"] = round(100 * sum(w[k] * parts[k] for k in w), 1)
        o["sector_scores"] = {s: round(100 * norm(o["sec"].get(s, 0), sec_max[s])) for s in SECTORS if o["sec"].get(s)}

    ranked = sorted(orgs.values(), key=lambda o: -o["influence"])
    for i, o in enumerate(ranked, 1): o["rank"] = i
    chosen = {o["id"]: o for o in ranked[:TOP_N]}
    pins = dict(PINNED)
    for key, pat in PINNED_NAMES:
        hit = next((o for o in ranked if re.search(pat, o["name"], re.I)), None)
        if hit: pins[hit["id"]] = key
        else: print(f"    note: no Brussels registration matched for '{key}'")
    for oid, key in pins.items():
        if oid in orgs: chosen[oid] = orgs[oid]; orgs[oid]["curated"] = key

    print(f"4/5 Geocoding {len(chosen)} organisations and {len(PERMREPS)} permanent representations (UrbIS)")
    cache_path = os.path.join(HERE, "geocache.json")
    cache = json.load(open(cache_path)) if os.path.exists(cache_path) else {}
    out_orgs, misses = [], []
    for o in chosen.values():
        ll = geocode(o["street"], o["pc"], cache)
        if not ll: misses.append(o["name"]); continue
        out_orgs.append({
            "id": o["id"], "n": o["name"], "acr": o["acr"], "t": TYPE_MAP.get(o["cat"], "public"), "cat": o["cat"],
            "a": f'{o["street"]}, {o["pc"]}', "lat": ll[0], "lng": ll[1], "web": o["web"],
            "inf": o["influence"], "rank": o["rank"], "parts": o["parts"],
            "top": o["top"], "dg": o["dg"], "fte": round(o["fte"], 2), "ep": o["ep"], "spend": o["spend"],
            "budget": o["budget"],
            "sec": o["sector_scores"], "secN": o["sec"], "who": o["who"], "last": o["last"], "wk": o["wk"],
            "curated": o.get("curated"),
        })

    pop = json.load(open(paths["pop.json"]))
    geo = pop["dimension"]["geo"]["category"]["index"]; tix = pop["dimension"]["time"]["category"]["index"]
    year = max(tix, key=tix.get); nt = len(tix)
    def popof(cc):
        for y in sorted(tix, key=tix.get, reverse=True):
            v = pop["value"].get(str(geo[cc] * nt + tix[y]))
            if v: return v
    pops = {cc: popof(cc) for cc, *_ in PERMREPS}; total = sum(pops.values()); mx = max(pops.values())
    out_reps = []
    for cc, name, street, pc in PERMREPS:
        ll = geocode(street, pc, cache)
        if not ll: misses.append(name); continue
        share = pops[cc] / total
        out_reps.append({"id": f"rep-{cc.lower()}", "cc": cc, "n": f"Permanent Representation of {name}",
                         "a": f"{street}, {pc}", "lat": ll[0], "lng": ll[1],
                         "share": round(100 * share, 2), "power": round(55 + 30 * pops[cc] / mx, 1)})
    json.dump(cache, open(cache_path, "w"), ensure_ascii=False, indent=0)
    if misses: print("    not geocoded:", ", ".join(misses))

    data = {
        "built": dt.date.today().isoformat(), "registerDate": export_date, "meetingsTo": latest,
        "termStart": TERM_START, "registrants": len(orgs), "lobbyCeiling": LOBBY_CEILING, "weights": WEIGHTS,
        "popYear": year, "maxes": maxes, "weekly": weekly,
        "sectors": {k: {"label": v[0], "dgs": v[1], "cabs": v[2]} for k, v in SECTORS.items()},
        "orgs": out_orgs, "reps": out_reps,
    }
    json.dump(data, open(os.path.join(HERE, "power.json"), "w"), ensure_ascii=False)
    print("5/5 Merging with curated places")
    merge_places(data)
    print(f"Done: {len(out_orgs)} organisations, {len(out_reps)} representations, meetings to {latest}.")

def merge_places(data):
    """One list of everything the viewer shows: curated landmarks, the 27 representations, organisations."""
    cur = json.load(open(os.path.join(HERE, "curated.json"), encoding="utf-8"))
    places = []
    for p in cur["PLACES"]:
        if p["id"] in cur["FORMAL"]:
            p["power"], p["why"] = cur["FORMAL"][p["id"]]; p["basis"] = "formal"
        places.append(p)
    for o in data["orgs"]:
        note = cur["NOTES"].get(o.get("curated") or "", [None, "", None])
        places.append(dict(id=o.get("curated") or "tr-" + o["id"], c=o["t"], n=note[0] or o["n"], a=o["a"],
                           lat=o["lat"], lng=o["lng"], d=note[1], w=note[2], org=o, sec=o["sec"],
                           power=round(o["inf"] * data["lobbyCeiling"] / 100, 1), basis="influence"))
    for r in data["reps"]:
        places.append(dict(id=r["id"], c="mission", n=r["n"], a=r["a"], lat=r["lat"], lng=r["lng"], rep=r,
                           power=r["power"], basis="council",
                           d="The member state's embassy to the EU. Its ambassadors sit in COREPER and its attachés follow every Council working party."))
    data["places"] = places
    data["cats"] = cur["CATS"]; data["stories"] = cur["STORIES"]
    out = os.path.join(HERE, "..", "web", "data", "power.json")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    json.dump(data, open(out, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    print(f"Done: {len(places)} places written to web/data/power.json, meetings to {data['meetingsTo']}.")

if __name__ == "__main__":
    main()
