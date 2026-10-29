#!/usr/bin/env python3
"""
Brussels policy events scraper.

Reads sources.csv, fetches each organisation's events page with the method
recorded for it, normalises everything to one event schema and writes:
  output/events.json  - feed for your website
  output/events.ics   - same events as an iCal calendar
  output/run_log.csv  - per-source result (events found / errors)

Methods (column `method` in sources.csv):
  tribe    WordPress "The Events Calendar" REST API (/wp-json/tribe/events/v1/events)
  jsonld   schema.org Event objects embedded in the page (<script type="application/ld+json">)
  ical     an .ics feed linked from the page
  html     plain HTML -> LLM extraction (needs ANTHROPIC_API_KEY), else skipped
  html_js  JavaScript-rendered page -> rendered with Playwright, then like `html`

Usage:
  python scraper.py                       # all enabled sources
  python scraper.py --only tribe,jsonld,ical
  python scraper.py --name "Bruegel"      # one source (substring match)
  python scraper.py --limit 20
"""
import argparse, csv, datetime as dt, hashlib, json, os, re, sys, time
import urllib.robotparser
from html import unescape
from urllib.parse import urljoin, urlparse

import requests
from zoneinfo import ZoneInfo
from bs4 import BeautifulSoup

UA = os.environ.get("SCRAPER_UA", "BrusselsByPowerEvents/1.0 (+https://brussels-by-power.vercel.app)")
HEADERS = {"User-Agent": UA, "Accept": "text/html,application/json,text/calendar;q=0.9,*/*;q=0.8"}
DELAY = float(os.environ.get("SCRAPER_DELAY", "2"))   # seconds between requests to the same host
TODAY = dt.date.today()
HORIZON_DAYS = int(os.environ.get("HORIZON_DAYS", "120"))
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "output")

BRUSSELS = ZoneInfo("Europe/Brussels")
_last_hit, _robots = {}, {}


# ---------------------------------------------------------------- fetching
def allowed(url):
    host = "{0.scheme}://{0.netloc}".format(urlparse(url))
    if host not in _robots:
        rp = urllib.robotparser.RobotFileParser()
        try:
            r = requests.get(host + "/robots.txt", headers=HEADERS, timeout=15)
            rp.parse(r.text.splitlines() if r.status_code == 200 else [])
        except Exception:
            rp.parse([])
        _robots[host] = rp
    return _robots[host].can_fetch(UA, url)


import threading, collections
_locks = collections.defaultdict(threading.Lock)


def fetch(url, timeout=30):
    host = urlparse(url).netloc
    with _locks[host]:                                   # sites are scraped in parallel, each one politely
        wait = DELAY - (time.time() - _last_hit.get(host, 0))
        if wait > 0:
            time.sleep(wait)
        _last_hit[host] = time.time()
    r = requests.get(url, headers=HEADERS, timeout=timeout)
    r.raise_for_status()
    return r


def render(url):
    """Fetch a JavaScript-rendered page with Playwright (pip install playwright; playwright install chromium)."""
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page(user_agent=UA)
        pg.goto(url, wait_until="domcontentloaded", timeout=60000)
        pg.wait_for_timeout(5000)
        html = pg.content()
        b.close()
    return html


# ---------------------------------------------------------------- schema
def make_event(src, title, start, end=None, url=None, location=None, online=None, description=None):
    title = re.sub(r"\s+", " ", unescape(title or "")).strip()
    if not title or not start:
        return None
    start_s = str(start)[:19].replace(" ", "T")
    end = str(end)[:19].replace(" ", "T") if end else None
    return {
        "id": hashlib.sha1(f"{src['name']}|{title.lower()}|{start_s[:10]}".encode()).hexdigest()[:16],
        "title": title,
        "organiser": src["name"],
        "group": src["group"],
        "start": start_s,
        "end": end,
        "location": (location or "").strip() or None,
        "online": online,
        "url": url or src["events_url"],
        "description": (re.sub(r"<[^>]+>", " ", description or "")[:500]).strip() or None,
        "source_url": src["events_url"],
        "source_method": src["method"],
        "scraped_at": dt.datetime.now(dt.timezone.utc).replace(tzinfo=None).isoformat(timespec="seconds") + "Z",
    }


# ---------------------------------------------------------------- adapters
def scrape_tribe(src):
    base = "{0.scheme}://{0.netloc}".format(urlparse(src["events_url"]))
    api = f"{base}/wp-json/tribe/events/v1/events?per_page=50&start_date={TODAY.isoformat()}"
    out = []
    while api and len(out) < 300:
        data = fetch(api).json()
        for e in data.get("events", []):
            venue = e.get("venue") or {}
            loc = ", ".join(x for x in [venue.get("venue"), venue.get("city")] if x) if isinstance(venue, dict) else None
            out.append(make_event(src, e.get("title"), e.get("start_date"), e.get("end_date"),
                                  e.get("url"), loc, e.get("is_virtual"), e.get("description")))
        api = data.get("next_rest_url")
    return out


def _walk_jsonld(obj):
    if isinstance(obj, list):
        for x in obj:
            yield from _walk_jsonld(x)
    elif isinstance(obj, dict):
        t = obj.get("@type")
        t = t if isinstance(t, list) else [t]
        if any(str(x).endswith("Event") for x in t):
            yield obj
        for k in ("@graph", "itemListElement", "item", "subEvent"):
            if k in obj:
                yield from _walk_jsonld(obj[k])


def scrape_jsonld(src, html=None):
    html = html or fetch(src["events_url"]).text
    soup = BeautifulSoup(html, "html.parser")
    out = []
    for s in soup.find_all("script", type="application/ld+json"):
        try:
            data = json.loads(s.string or "")
        except Exception:
            continue
        for e in _walk_jsonld(data):
            loc = e.get("location")
            online = None
            if isinstance(loc, list):
                loc = loc[0] if loc else None
            if isinstance(loc, dict):
                online = loc.get("@type") == "VirtualLocation"
                addr = loc.get("address")
                loc = loc.get("name") or (addr.get("addressLocality") if isinstance(addr, dict) else addr)
            out.append(make_event(src, e.get("name"), e.get("startDate"), e.get("endDate"),
                                  e.get("url"), loc if isinstance(loc, str) else None, online, e.get("description")))
    return out


def scrape_ical(src):
    page = fetch(src["events_url"]).text
    m = re.search(r'href="([^"]+?(?:\.ics|ical=1|outlook-ical=1)[^"]*)"', page, re.I) or \
        re.search(r'(webcal://[^"\s]+)', page, re.I)
    if not m:
        return []
    ics_url = urljoin(src["events_url"], unescape(m.group(1)).replace("webcal://", "https://"))
    ics = fetch(ics_url).text
    out = []
    for block in re.findall(r"BEGIN:VEVENT(.*?)END:VEVENT", ics, re.S):
        block = re.sub(r"\r?\n[ \t]", "", block)  # unfold lines

        def f(k):
            mm = re.search(rf"^{k}[^:\n]*:(.*)$", block, re.M)
            return mm.group(1).strip().replace("\\,", ",").replace("\\n", " ") if mm else None
        def d(v):
            if not v:
                return None
            if v.endswith("Z"):   # UTC -> Brussels local time
                t = dt.datetime.strptime(v, "%Y%m%dT%H%M%SZ").replace(tzinfo=dt.timezone.utc)
                return t.astimezone(BRUSSELS).strftime("%Y-%m-%dT%H:%M:%S")
            return f"{v[0:4]}-{v[4:6]}-{v[6:8]}" + (f"T{v[9:11]}:{v[11:13]}:00" if "T" in v else "")
        out.append(make_event(src, f("SUMMARY"), d(f("DTSTART")), d(f("DTEND")), f("URL"), f("LOCATION"), None, f("DESCRIPTION")))
    return out


LLM_PROMPT = """You extract upcoming events from an organisation's events web page.
Today is {today}. Return ONLY a JSON array; each item:
{{"title":str,"start":"YYYY-MM-DD" or "YYYY-MM-DDTHH:MM","end":same or null,"location":str or null,
"online":true/false/null,"url":absolute URL of the event page or null}}
Include only real, dated events (no news articles, no past events older than today). If none, return [].
Page URL: {url}
Page text and links:
{text}"""


def scrape_html_free(src, html):
    """No API key: follow links that look like single events and read each page's title, date, time and place
    (shared with ../build_agenda.py)."""
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    import build_agenda as ba
    host = urlparse(src["events_url"]).netloc.removeprefix("www.")
    out = []
    for e in ba.from_pages(src["events_url"], html, host, src["name"]):
        if not e.get("start") or not e.get("title"): continue
        mode = (e.get("where") or "") + " " + (e.get("title") or "")
        out.append(make_event(src, e["title"], e["start"].replace("T00:00", ""), e.get("end"), e.get("url"),
                              None, bool(re.search(ba.ONLINE, mode, re.I)) or None))
    return out


def scrape_html(src, html=None):
    key = os.environ.get("ANTHROPIC_API_KEY")
    html = html or fetch(src["events_url"]).text
    # cheap win first: many CMS pages still embed JSON-LD
    ev = [e for e in scrape_jsonld(src, html) if e]
    if ev:
        return ev
    if not key:
        return scrape_html_free(src, html)
    soup = BeautifulSoup(html, "html.parser")
    for t in soup(["script", "style", "noscript", "svg", "header", "footer", "nav"]):
        t.decompose()
    for a in soup.find_all("a", href=True):
        a.append(f" <{urljoin(src['events_url'], a['href'])}>")
    text = re.sub(r"\n\s*\n+", "\n", soup.get_text("\n"))[:40000]
    r = requests.post("https://api.anthropic.com/v1/messages", timeout=120, headers={
        "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"},
        json={"model": os.environ.get("LLM_MODEL", "claude-haiku-4-5"), "max_tokens": 4000,
              "messages": [{"role": "user", "content": LLM_PROMPT.format(today=TODAY, url=src["events_url"], text=text)}]})
    r.raise_for_status()
    raw = r.json()["content"][0]["text"]
    m = re.search(r"\[.*\]", raw, re.S)
    items = json.loads(m.group(0)) if m else []
    return [make_event(src, i.get("title"), i.get("start"), i.get("end"), i.get("url"),
                       i.get("location"), i.get("online")) for i in items]


def scrape_html_js(src):
    return scrape_html(src, render(src["events_url"]))


ADAPTERS = {"tribe": scrape_tribe, "jsonld": scrape_jsonld, "ical": scrape_ical,
            "html": scrape_html, "html_js": scrape_html_js}


# ---------------------------------------------------------------- output
def in_window(e):
    try:
        d = dt.date.fromisoformat(e["start"][:10])
    except Exception:
        return False
    end = dt.date.fromisoformat(e["end"][:10]) if e.get("end") and re.match(r"\d{4}-\d\d-\d\d", e["end"]) else d
    return end >= TODAY and d <= TODAY + dt.timedelta(days=HORIZON_DAYS)


def write_ics(events, path):
    def ics_dt(s):
        return s.replace("-", "").replace(":", "")[:15] if "T" in s else s.replace("-", "")[:8]
    esc = lambda s: (s or "").replace("\\", "\\\\").replace(",", "\\,").replace(";", "\\;").replace("\n", " ")
    lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Brussels Events//EN"]
    for e in events:
        lines += ["BEGIN:VEVENT", f"UID:{e['id']}@brussels-events", f"DTSTART:{ics_dt(e['start'])}"]
        if e.get("end"):
            lines.append(f"DTEND:{ics_dt(e['end'])}")
        lines += [f"SUMMARY:{esc(e['title'])} ({esc(e['organiser'])})", f"URL:{e['url']}",
                  f"LOCATION:{esc(e.get('location'))}", "END:VEVENT"]
    lines.append("END:VCALENDAR")
    open(path, "w").write("\r\n".join(lines))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sources", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "sources.csv"))
    ap.add_argument("--only", help="comma list of methods")
    ap.add_argument("--name")
    ap.add_argument("--limit", type=int)
    ap.add_argument("--part", help="k/n: run every n-th source starting at k (for short machines), then --merge")
    ap.add_argument("--merge", action="store_true", help="combine output/parts/*.json into the final outputs")
    a = ap.parse_args()
    if a.merge:
        events, log = {}, []
        import glob
        for f in sorted(glob.glob(os.path.join(OUT, "parts", "*.json"))):
            d = json.load(open(f))
            for e in d["events"]: events.setdefault(e["id"], e)
            log += d["log"]
        return write_outputs(events, log)

    srcs = [s for s in csv.DictReader(open(a.sources, encoding="utf-8")) if s["enabled"] == "yes"]
    if a.only:
        srcs = [s for s in srcs if s["method"] in a.only.split(",")]
    if a.name:
        srcs = [s for s in srcs if a.name.lower() in s["name"].lower()]
    seen_urls, uniq = set(), []
    for s in srcs:                       # several DG rows share one Commission URL
        if s["events_url"] not in seen_urls:
            seen_urls.add(s["events_url"]); uniq.append(s)
    srcs = uniq[: a.limit] if a.limit else uniq

    if a.part:
        k, n = map(int, a.part.split("/"))
        srcs = srcs[k - 1::n]
    os.makedirs(OUT, exist_ok=True)
    events, log = {}, []

    def run(s):
        n, err, got = 0, "", []
        try:
            if not allowed(s["events_url"]):
                raise RuntimeError("disallowed by robots.txt")
            for e in ADAPTERS[s["method"]](s):
                if e and in_window(e):
                    got.append(e); n += 1
        except Exception as ex:
            err = str(ex)[:200]
        return s, n, err, got

    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(int(os.environ.get("SCRAPER_WORKERS", "16"))) as ex:
        for s, cnt, err, got in ex.map(run, srcs):
            for e in got: events.setdefault(e["id"], e)
            log.append({"name": s["name"], "method": s["method"], "events": cnt, "error": err})
            print(f"{cnt:4d}  {s["method"]:7s} {s["name"][:50]}  {err[:80]}", flush=True)

    if a.part:                                           # partial run: save and stop; --merge combines the parts
        os.makedirs(os.path.join(OUT, "parts"), exist_ok=True)
        json.dump({"events": list(events.values()), "log": log}, open(os.path.join(OUT, "parts", f"part{k}of{n}.json"), "w"))
        print(f"part {k}/{n}: {len(events)} events"); return
    write_outputs(events, log)


def write_outputs(events, log):
    evs = sorted(events.values(), key=lambda e: e["start"])
    json.dump({"generated_at": dt.datetime.now(dt.timezone.utc).replace(tzinfo=None).isoformat(timespec="seconds") + "Z",
               "count": len(evs), "events": evs}, open(os.path.join(OUT, "events.json"), "w"), ensure_ascii=False, indent=1)
    write_ics(evs, os.path.join(OUT, "events.ics"))
    with open(os.path.join(OUT, "run_log.csv"), "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["name", "method", "events", "error"]); w.writeheader(); w.writerows(log)
    print(f"\n{len(evs)} upcoming events from {sum(1 for l in log if l['events'])}/{len(log)} sources -> {OUT}")


if __name__ == "__main__":
    main()
