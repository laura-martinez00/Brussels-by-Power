#!/usr/bin/env python3
"""
Brussels, by power: agenda.

Collects upcoming Brussels policy events directly from the organisers' own websites (never from aggregators):
  1. finds each organiser's events page (from its website in the EU Transparency Register, or organisers.json)
  2. reads events with the most reliable method the site offers:
     The Events Calendar API -> iCal feed -> schema.org Event data -> event pages (title, date, time, place)
  3. keeps events in the next 60 days that are in Brussels or online, tags topic and format,
     and links each organiser to its building on the map
  4. adds the European Parliament's plenary calendar (open-data API)

Writes ../web/data/agenda.json. Respects robots.txt and identifies itself. Run daily.
Usage: python build_agenda.py [--top 120]
"""
import json, re, sys, time, html, datetime as dt, collections, email.utils
from pathlib import Path
from urllib.parse import urljoin, urlparse
from urllib import robotparser
from concurrent.futures import ThreadPoolExecutor
import requests

HERE = Path(__file__).resolve().parent
WEB = HERE.parent / "web" / "data"
CACHE = HERE / "cache" / "agenda"; CACHE.mkdir(parents=True, exist_ok=True)
UA = {"User-Agent": __import__("os").environ.get("SCRAPER_UA", "BrusselsByPowerAgenda/1.0 (+https://brussels-by-power.vercel.app)")}
DAYS = 60
EVENT_PATHS = ["/events", "/events/", "/en/events", "/en/events/", "/event", "/agenda", "/en/agenda", "/news-events/events",
               "/news-and-events/events", "/events/upcoming", "/upcoming-events", "/en/news-events/events", "/evenements"]
TOPICS = {  # keyword -> topic, in priority order (first match wins on the title, then on the text)
    "Defence & Security": r"defen[cs]e|security|military|nato|(?<!trade )wars?\\b|hybrid (?:threat|war|attack)|ukraine|peace",
    "Energy & Climate": r"energy|climate|hydrogen|gas\b|electric|renewable|solar|wind|carbon|net[- ]zero|emission|nuclear|heat",
    "Digital & Tech": r"digital|\bai\b|artificial intelligence|data\b|tech|cyber|platform|semiconductor|chips|online safety|telecom",
    "Economy & Finance": r"econom|trade|tariff|finance|financial|bank|budget|tax|market|competitive|industr|invest|single market|euro\b|monetary|china",
    "Agriculture & Food": r"agri|farm|food|soil|fisher|cap\b|rural|meat|seafood",
    "Health & Science": r"health|medic|pharma|cancer|disease|science|research|innovation|patient",
    "Transport": r"transport|mobility|aviation|rail|shipping|maritime|automotive|road",
    "Environment": r"environment|biodiversity|nature|water|circular|waste|pollution|plastic|chemical",
    "Social & Rights": r"social|rights|rule of law|democra|migration|equality|gender|youth|education|skills|employment|work",
    "EU Institutions": r"\beu\b|europe|commission|parliament|council|presidency|enlargement|institution|governance",
}
BRUSSELS = r"brussel|bruxelles|brüssel|bxl|1000 |1040 |1050 |1210 |etterbeek|ixelles|schuman|luxembourg square|place du luxembourg"
ONLINE = r"online|virtual|webinar|zoom|livestream|live stream|livestreamed|teams meeting|web ?conference|digital event"
HYBRID = r"\bhybrid\b(?! (?:threat|war|attack))|in-person and online|on site or online|in person & online"
MONTHS = {m: i for i, m in enumerate(["january", "february", "march", "april", "may", "june", "july", "august", "september",
                                      "october", "november", "december"], 1)}
MONTHS.update({m[:3]: i for m, i in list(MONTHS.items())})
MONTHS.update({"janvier": 1, "février": 2, "fevrier": 2, "mars": 3, "avril": 4, "mai": 5, "juin": 6, "juillet": 7, "août": 8,
               "septembre": 9, "octobre": 10, "novembre": 11, "décembre": 12, "sept": 9})


def pick_topic(title, text):
    """Topic with the most keyword hits in the title (counted double) and description; ties go to the earlier topic."""
    score = {k: 2 * len(re.findall(rx, title, re.I)) + len(re.findall(rx, text[:1500], re.I)) for k, rx in TOPICS.items()}
    best = max(score.values())
    return next(k for k, v in score.items() if v == best) if best else "EU Institutions"


def today():
    """Real current date from an HTTP Date header (container clocks can drift)."""
    try:
        d = requests.head("https://europa.eu", timeout=15, headers=UA).headers["Date"]
        return email.utils.parsedate_to_datetime(d).date()
    except Exception:
        return dt.date.today()


_robots = {}
def allowed(url):
    host = urlparse(url).scheme + "://" + urlparse(url).netloc
    if host not in _robots:
        rp = robotparser.RobotFileParser()
        try:
            r = requests.get(host + "/robots.txt", headers=UA, timeout=8)
            rp.parse(r.text.splitlines() if r.ok else [])
        except Exception:
            rp.parse([])
        _robots[host] = rp
    return _robots[host].can_fetch(UA["User-Agent"], url)


import threading
_host_lock, _host_last = collections.defaultdict(threading.Lock), {}
DELAY = float(__import__("os").environ.get("SCRAPER_DELAY", "2"))   # seconds between requests to the same site


def get(url, **kw):
    if not allowed(url): return None
    host = urlparse(url).netloc
    with _host_lock[host]:
        wait = DELAY - (time.time() - _host_last.get(host, 0))
        if wait > 0: time.sleep(wait)
        _host_last[host] = time.time()
    try:
        r = requests.get(url, headers=UA, timeout=kw.pop("timeout", 12), **kw)
        return r if r.ok else None
    except Exception:
        return None


def clean(s): return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", s or ""))).strip()


def parse_dt(s):
    """ISO or common written dates -> (date, 'HH:MM' or None)."""
    if not s: return None, None
    m = re.search(r"(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?", s)
    if m:
        d = dt.date(int(m[1]), int(m[2]), int(m[3])); return d, (f"{m[4]}:{m[5]}" if m[4] else None)
    t = s.lower()
    m = re.search(r"(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-zéû]{3,9})\.?,?\s+(\d{4})", t) or \
        re.search(r"([a-zéû]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})", t)
    if m:
        a, b, y = m.groups()
        day, mon = (a, b) if a.isdigit() else (b, a)
        if mon in MONTHS:
            try: d = dt.date(int(y), MONTHS[mon], int(day))
            except ValueError: return None, None
            tm = re.search(r"\b(\d{1,2})[:h.](\d{2})\b", t[m.end():m.end() + 60])
            return d, (f"{int(tm[1]):02d}:{tm[2]}" if tm and int(tm[1]) < 24 else None)
    m = re.search(r"\b(\d{1,2})[/.](\d{1,2})[/.](\d{4})\b", t)
    if m:
        try: return dt.date(int(m[3]), int(m[2]), int(m[1])), None
        except ValueError: pass
    return None, None


def times_in(text):
    m = re.search(r"\b(\d{1,2})[:h.](\d{2})\s*(?:-|–|to|until)\s*(\d{1,2})[:h.](\d{2})\b", text)
    return (f"{int(m[1]):02d}:{m[2]}", f"{int(m[3]):02d}:{m[4]}") if m and int(m[1]) < 24 and int(m[3]) < 25 else (None, None)


def ld_events(text, base):
    out = []
    for blob in re.findall(r'<script[^>]+application/ld\+json[^>]*>(.*?)</script>', text, re.S | re.I):
        try: data = json.loads(blob.strip())
        except Exception: continue
        stack = data if isinstance(data, list) else [data]
        while stack:
            o = stack.pop()
            if isinstance(o, dict):
                if "@graph" in o: stack += o["@graph"]
                ty = o.get("@type"); ty = ty if isinstance(ty, list) else [ty]
                if any(isinstance(x, str) and x.endswith("Event") for x in ty):
                    loc = o.get("location") or {}
                    locs = loc if isinstance(loc, list) else [loc]
                    where = " ".join(clean(json.dumps(l, ensure_ascii=False)) if isinstance(l, dict) else str(l) for l in locs)
                    out.append({"title": clean(o.get("name")), "start": o.get("startDate"), "end": o.get("endDate"),
                                "url": urljoin(base, o.get("url") or base), "where": where,
                                "mode": o.get("eventAttendanceMode", "")})
            elif isinstance(o, list): stack += o
    return out


def from_tribe(base, t0, t1):
    r = get(base + "/wp-json/tribe/events/v1/events", params={"per_page": 50, "start_date": t0.isoformat(), "end_date": t1.isoformat()})
    try: evs = r.json().get("events") if r else None
    except Exception: evs = None
    if evs is None: return None
    out = []
    for e in evs:
        v = e.get("venue") or {}
        v = v if isinstance(v, dict) else {}
        out.append({"title": clean(e.get("title")), "start": e.get("start_date"), "end": e.get("end_date"), "url": e.get("url"),
                    "where": " ".join(str(v.get(k, "")) for k in ("venue", "address", "city")), "mode": "online" if e.get("is_virtual") else ""})
    return out


def from_ical(url):
    r = get(url)
    if not r or "BEGIN:VCALENDAR" not in r.text[:300]: return None
    out = []
    for blk in r.text.replace("\r\n ", "").split("BEGIN:VEVENT")[1:]:
        f = lambda k: (re.search(rf"^{k}[^:\n]*:(.*)$", blk, re.M) or [None, ""])[1].strip()
        st = f("DTSTART"); en = f("DTEND")
        iso = lambda s: f"{s[:4]}-{s[4:6]}-{s[6:8]}" + (f"T{s[9:11]}:{s[11:13]}" if len(s) >= 13 else "") if re.match(r"\d{8}", s) else s
        out.append({"title": f("SUMMARY").replace("\\,", ",").replace("\\;", ";"), "start": iso(st), "end": iso(en),
                    "url": f("URL") or url, "where": f("LOCATION").replace("\\,", ","), "mode": ""})
    return out


def listing_rows(page_url, text, host):
    """Events read straight from a listing page whose rows hold the event link and its date (table rows, list items, cards)."""
    from bs4 import BeautifulSoup
    soup = BeautifulSoup(text, "html.parser")
    out, seen = [], set()
    for a in soup.find_all("a", href=True):
        u = urljoin(page_url, a["href"]); p = urlparse(u)
        if p.netloc.removeprefix("www.") != host or u in seen: continue
        if not re.search(r"/(events?|agenda|evenements?|veranstaltung\w*)/", p.path, re.I) or re.search(r"/(page|category|tag|past|archive)/", p.path): continue
        title = clean(a.get_text(" "))
        if len(title) < 12 or re.search(r"jobsite|newsletter|subscribe|sign up|cookie", title, re.I): continue
        row = a.find_parent(["tr", "li", "article"]) or a.parent
        d, hhmm = parse_dt(clean(row.get_text(" ")) if row else "")
        if not d:
            m = re.search(r"\b(\d{1,2})-(\d{1,2})-(\d{4})\b", clean(row.get_text(" ")) if row else "")
            if m:
                try: d = dt.date(int(m[3]), int(m[2]), int(m[1]))
                except ValueError: d = None
        if not d: continue
        seen.add(u)
        out.append({"title": title, "start": f"{d.isoformat()}T{hhmm or '00:00'}", "end": None, "url": u,
                    "where": clean(row.get_text(" "))[:300] if row else "", "mode": ""})
    return out


def from_pages(page_url, text, host, org_name=""):
    """Generic: follow links that look like individual events, read each page's title, date, time and place."""
    links = []
    for href, label in re.findall(r'<a[^>]+href="([^"#]+)"[^>]*>(.*?)</a>', text, re.S):
        u = urljoin(page_url, href)
        p = urlparse(u)
        if p.netloc.removeprefix("www.") != host or u.rstrip("/") == page_url.rstrip("/"): continue
        if re.search(r"/(events?|agenda|evenements?|veranstaltung\w*)/[^/?]{6,}", p.path, re.I) and not re.search(r"/(page|category|tag|past|archive)/", p.path):
            if u not in links: links.append(u)
    out = listing_rows(page_url, text, host)          # listing tables: each event link sits next to its date
    if len(out) >= 2: return out
    out = []
    for u in links[:20]:
        r = get(u)
        if not r: continue
        t = r.text
        evs = ld_events(t, u)
        if evs: out += evs; continue
        h1 = re.search(r"<h1[^>]*>(.*?)</h1>", t, re.S)
        og = re.search(r'<meta[^>]+property="og:title"[^>]+content="([^"]+)"', t)
        title = clean(h1[1] if h1 and len(clean(h1[1])) > 8 else (og[1] if og else ""))
        title = re.split(r"\s+[|–-]\s+(?=[^|–-]*$)", title)[0] if re.search(r"\s[|–-]\s", title) and len(title) > 30 else title
        if not title or re.fullmatch(r"(upcoming |all |our |past )?(events?|agenda)\b.*", title, re.I) or title.lower() in org_name.lower(): continue
        body = clean(re.sub(r"<(script|style|nav|footer)[^>]*>.*?</\1>", " ", t, flags=re.S | re.I))[:20000]
        d, hhmm, window = None, None, ""
        for m in re.finditer(re.escape(title[:40]), body):          # the occurrence followed most closely by a date
            w = body[m.start() + len(title[:40]): m.start() + len(title) + 320]   # a date right after the title
            d, hhmm = parse_dt(w)
            if d: window = w; break
        if not d:
            window = body[:4000]; d, hhmm = parse_dt(window)
        if not d:
            tm = re.search(r'<time[^>]+datetime="([^"]+)"', t)
            d, hhmm = parse_dt(tm[1]) if tm else (None, None)
        if not d: continue
        a, b = times_in(window[window.lower().find(str(d.year)) if str(d.year) in window else 0:][:400])
        out.append({"title": title, "start": f"{d.isoformat()}T{a or hhmm or '00:00'}", "end": f"{d.isoformat()}T{b}" if b else None,
                    "url": u, "where": window, "mode": ""})
    return out


def find_events_page(site):
    home = get(site)
    cands = []
    if home:
        for href, label in re.findall(r'<a[^>]+href="([^"#]+)"[^>]*>(.*?)</a>', home.text, re.S):
            if re.fullmatch(r"\s*(events?|agenda|upcoming events|évènements|événements|evenementen|veranstaltungen|our events)\s*", clean(label), re.I):
                cands.append(urljoin(site, href))
    cands += [site.rstrip("/") + p for p in EVENT_PATHS]
    for c in dict.fromkeys(cands):
        if urlparse(c).netloc.removeprefix("www.") != urlparse(site).netloc.removeprefix("www."): continue
        r = get(c)
        if r and len(r.text) > 3000 and re.search(r"event|agenda|évén|veranst", r.text[:200000], re.I):
            return c, r
    return None, None


def collect(org, t0, t1):
    site, host = org["site"], urlparse(org["site"]).netloc.removeprefix("www.")
    evs, how = from_tribe(site.rstrip("/"), t0, t1), "events-api"
    page = None
    if not evs:
        page, r = (org["events"], get(org["events"])) if org.get("events") else (None, None)
        if not r: page, r = find_events_page(site)
        if r:
            ical = re.search(r'href="([^"]+(?:\?ical=1|\.ics)[^"]*)"', r.text)
            evs, how = (from_ical(urljoin(page, html.unescape(ical[1]))) if ical else None), "ical"
            if not evs: evs, how = ld_events(r.text, page), "structured"
            if not evs: evs, how = from_pages(page, r.text, host, org["name"]), "pages"
    titles = collections.Counter((e.get("title") or "").lower() for e in evs or [])
    out = []
    for e in evs or []:
        if titles[(e.get("title") or "").lower()] > 1 and len({x.get("url") for x in evs if (x.get("title") or "").lower() == e["title"].lower()}) > 1:
            continue                                                  # a site-wide heading, not an event title
        d, hhmm = parse_dt(e.get("start") or "")
        if not d or not (t0 <= d <= t1) or not e.get("title"): continue
        d2, hh2 = parse_dt(e.get("end") or "")
        txt = f'{e["title"]} {e.get("where", "")} {e.get("mode", "")}'.lower()
        online = bool(re.search(ONLINE, txt)) or "online" in e.get("mode", "").lower()
        inbxl = bool(re.search(BRUSSELS, txt))
        mixed = "mixed" in e.get("mode", "").lower() or bool(re.search(HYBRID, txt)) or (online and inbxl)
        if not (online or inbxl or org.get("brussels_default")): continue
        topic = pick_topic(e["title"], txt)
        out.append({"date": d.isoformat(), "start": hhmm if hhmm and hhmm != "00:00" else None,
                    "end": hh2 if d2 == d and hh2 and hh2 != "00:00" else None, "endDate": d2.isoformat() if d2 and d2 > d else None,
                    "title": e["title"][:220], "url": e.get("url") or page or site, "org": org["name"], "place": org.get("place"),
                    "format": "Hybrid" if mixed else "Online" if online else "In person", "topic": topic})
    return org["name"], how if out else (how if evs else "none"), page, out


def parliament(t0, t1):
    out = []
    for y in sorted({t0.year, t1.year}):
        r = get(f"https://data.europarl.europa.eu/api/v2/meetings", params={"year": y, "format": "application/ld+json", "limit": 500, "offset": 0}, timeout=40)
        for m in (r.json().get("data", []) if r else []):
            d = dt.date.fromisoformat(m["activity_date"][:10])
            if t0 <= d <= t1 and "-PL-" in m.get("activity_id", ""):
                out.append({"date": d.isoformat(), "start": None, "end": None, "endDate": None,
                            "title": "Plenary sitting of the European Parliament", "url": "https://www.europarl.europa.eu/plenary/en/agenda.html",
                            "org": "European Parliament", "place": "ep", "format": "In person", "topic": "EU Institutions", "official": True})
    return out


def from_scraper(t0, t1, host_place):
    """Events collected by events/scraper.py from the 473 researched sources (events/sources.csv)."""
    path = HERE / "events" / "output" / "events.json"
    if not path.exists():
        print("  no events/output/events.json: run events/scraper.py first"); return [], set()
    data = json.loads(path.read_text())
    places = json.loads((WEB / "power.json").read_text())["places"]
    norm = lambda x: re.sub(r"[^a-z0-9]", "", (x or "").lower())
    by_name = {norm(p["n"]): p["id"] for p in places}
    out, hosts = [], set()
    rep = collections.Counter((e["organiser"], e["title"].lower()) for e in data["events"])
    for e in data["events"]:
        t = e["title"].strip()
        if rep[(e["organiser"], t.lower())] > 2 or norm(t) in norm(e["organiser"]) or norm(e["organiser"]) == norm(t) or \
           re.fullmatch(r"(upcoming |all |our |past )?(events?|agenda|calendar)\b.*", t, re.I) or len(t) < 8:
            continue                                               # site headings, not events
        d, hhmm = parse_dt(e["start"]); d2, hh2 = parse_dt(e.get("end") or "")
        if not d or (d2 or d) < t0 or d > t1: continue
        if d2 and (d2 - d).days > 7: continue                       # campaigns and exhibitions, not events
        loc = e.get("location") or ""
        txt = f'{e["title"]} {loc}'.lower()
        online = e.get("online") is True or bool(re.search(ONLINE, f'{loc} {e["title"]}', re.I))
        inbxl = bool(re.search(BRUSSELS, loc, re.I))
        if loc and not (online or inbxl): continue                 # elsewhere in Europe: not a Brussels event
        fmt = "Hybrid" if online and inbxl or re.search(HYBRID, txt) else "Online" if online else "In person" if inbxl else "Not stated"
        host = urlparse(e["source_url"]).netloc.removeprefix("www.")
        hosts.add(host)
        ok = lambda h: h if h and "07:00" <= h <= "22:30" else None          # times outside office hours are parse noise
        out.append({"date": d.isoformat(), "start": ok(hhmm),
                    "end": ok(hh2) if d2 == d and ok(hhmm) else None, "endDate": d2.isoformat() if d2 and d2 > d else None,
                    "title": e["title"][:220], "url": e["url"], "org": e["organiser"], "group": e.get("group"),
                    "place": host_place.get(host) or by_name.get(norm(e["organiser"])),
                    "format": fmt, "topic": pick_topic(e["title"], txt + " " + (e.get("description") or "")), "where": loc or None})
    return out, hosts


def organisers(top, skip_hosts=()):
    """Organisers to follow: organisers.json (hand-curated, optional) + the most active think tanks, associations, NGOs and unions on the map."""
    power = json.loads((WEB / "power.json").read_text())
    detail = json.loads((WEB / "meetings.json").read_text())["detail"]
    orgs, seen = [], set(skip_hosts)
    cur = HERE / "organisers.json"
    host_place = {}
    for pid, d in detail.items():
        if d.get("web"): host_place.setdefault(urlparse(d["web"] if d["web"].startswith("http") else "https://" + d["web"]).netloc.removeprefix("www."), pid)
    for o in (json.loads(cur.read_text()) if cur.exists() else []):
        h = urlparse(o["site"]).netloc.removeprefix("www.")
        if h in seen: continue
        orgs.append({**o, "place": o.get("place") or host_place.get(h), "brussels_default": True}); seen.add(h)
    cands = [p for p in power["places"] if p.get("org") and p["c"] in ("think", "assoc", "ngo", "union", "public")]
    cands.sort(key=lambda p: -p["org"]["inf"])
    for p in cands:
        web = detail.get(p["id"], {}).get("web")
        if not web: continue
        site = web if web.startswith("http") else "https://" + web
        host = urlparse(site).netloc.removeprefix("www.")
        if host in seen: continue
        seen.add(host)
        orgs.append({"name": p["n"], "site": site, "place": p["id"], "brussels_default": p["c"] in ("think",)})
        if len(orgs) >= top: break
    return orgs


def main():
    top = int(sys.argv[sys.argv.index("--top") + 1]) if "--top" in sys.argv else 120
    t0 = today(); t1 = t0 + dt.timedelta(days=DAYS)
    detail = json.loads((WEB / "meetings.json").read_text())["detail"]
    host_place = {}
    for pid, d in detail.items():
        if d.get("web"): host_place.setdefault(urlparse(d["web"] if d["web"].startswith("http") else "https://" + d["web"]).netloc.removeprefix("www."), pid)
    scraped, scraped_hosts = from_scraper(t0, t1, host_place)
    srcs_csv = HERE / "events" / "sources.csv"
    if srcs_csv.exists():
        import csv
        scraped_hosts |= {urlparse(r["events_url"]).netloc.removeprefix("www.") for r in csv.DictReader(open(srcs_csv, encoding="utf-8"))}
    print(f"  {len(scraped)} Brussels or online events from events/scraper.py")
    orgs = organisers(top, scraped_hosts) if "--no-map-orgs" not in sys.argv else []
    print(f"Agenda for {t0} to {t1}: {len(orgs)} further map organisers not in sources.csv")
    events, report = [], []
    with ThreadPoolExecutor(48) as ex:
        for name, how, page, evs in ex.map(lambda o: collect(o, t0, t1), orgs):
            events += evs; report.append({"org": name, "method": how, "page": page, "events": len(evs)})
    events += scraped + parliament(t0, t1)
    seen, uniq = set(), []
    for e in sorted(events, key=lambda e: (e["date"], e["start"] or "99", e["org"])):
        k = (e["date"], re.sub(r"\W+", "", e["title"].lower())[:60])
        if k not in seen: seen.add(k); uniq.append(e)
    import csv
    log = HERE / "events" / "output" / "run_log.csv"
    nsrc = sum(1 for r in csv.DictReader(open(log)) if int(r["events"] or 0) > 0) if log.exists() else 0
    agenda = {"built": t0.isoformat(), "to": t1.isoformat(), "events": uniq, "scraperSources": nsrc + sum(1 for r in report if r["events"]),
              "sources": sorted(report, key=lambda r: -r["events"]), "topics": list(TOPICS)}
    import shutil                                               # publish the scraper's feed with the site
    for f in ("events.json", "events.ics"):
        src = HERE / "events" / "output" / f
        if src.exists(): shutil.copy(src, WEB / f)
    (WEB / "agenda.json").write_text(json.dumps(agenda, ensure_ascii=False, separators=(",", ":")))
    ok = sum(1 for r in report if r["events"])
    print(f"Done: {len(uniq)} events from {ok} of {len(orgs)} organisers + Parliament.")
    print("By method:", dict(collections.Counter(r["method"] for r in report if r["events"])))


if __name__ == "__main__":
    main()
