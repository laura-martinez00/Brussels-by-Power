# Brussels policy events scraper

Collects upcoming events from the 473 Brussels organisations researched in
`Brussels_meetings_and_events_sources.xlsx` and publishes them as one feed
(`output/events.json` + `output/events.ics`) that your website can read.

## How the sources were found (so the process can be repeated)

1. **The Bubble's organisers.** The Bubble agenda (the-bubble.org/agenda) loads all its events when you type in its
   search box. The page was rendered in headless Chromium, a letter was typed in the box, and the
   organiser name and link of each loaded event were read from the page (≈905 events, ≈250 organisers).
   *Do not* query The Bubble's backend database directly; an attempt to do that was blocked as out of bounds.
2. **Gap-filling from knowledge + web search.** Added EU institutions/DGs/agencies, EP groups, European parties and
   foundations, think tanks, trade associations, NGOs, unions, regional offices, Perm Reps, media/event organisers,
   international organisations and communities that The Bubble does not track.
3. **Agence Europe.** `agenceurope.eu/en/calendar.html` (institutions) and `/en/calendar-extra.html`
   (other organisers, free). Its `aeur.eu/f/...` short links were resolved to find each organiser's site.
4. **URL verification.** Every URL was tested with `curl`, then failures re-tested in a real headless browser.
   For 404s, the site's homepage was loaded and links containing
   event/agenda/évènement/Veranstaltung/calendar were ranked to find the events page; leftovers were fixed by web search.
5. **Method detection.** Each page was probed for machine-readable data → column `method` in `sources.csv`.

| method | sources | how it's scraped | reliability |
|---|---|---|---|
| `tribe` | 17 | WordPress *The Events Calendar* REST API `/wp-json/tribe/events/v1/events` | high |
| `ical` | 9 | `.ics` feed linked from the page (incl. the whole Commission events portal) | high |
| `jsonld` | 6 | schema.org `Event` JSON-LD in the page | high |
| `html` | ~420 | page text → LLM extracts events as JSON | medium – spot-check |
| `html_js` | 15 | rendered with Playwright, then like `html` | medium |

Tested on 29 Oct 2026: the structured methods returned **106 upcoming events from 16 of 29 sources** in one run
(the other 13 simply had no upcoming events or empty feeds). The `html` LLM step is written but was not run
here (no API key in this environment): test it on 10–20 sources first and compare with the real pages.

## Setup

```bash
pip install requests beautifulsoup4 playwright
playwright install chromium          # only for html_js sources
export ANTHROPIC_API_KEY=...         # only for html / html_js sources
export SCRAPER_UA="YourSiteEventsBot/1.0 (+mailto:you@yoursite.eu)"   # identify yourself

python scraper.py --only tribe,jsonld,ical   # free, fast, reliable
python scraper.py --limit 20                 # try the LLM sources on a sample
python scraper.py                            # everything
```

Outputs in `output/`: `events.json` (feed), `events.ics` (calendar), `run_log.csv` (events/errors per source).

Event schema: `id, title, organiser, group, start, end, location, online, url, description, source_url, source_method, scraped_at`.
`id` = hash of organiser + title + date, so re-runs don't duplicate.

## Run it automatically

**GitHub Actions (free):** put this folder in a repo, add `ANTHROPIC_API_KEY` as a repository secret; the included
`.github/workflows/scrape.yml` runs daily at 05:17 UTC and commits `output/`. Your site then reads
`https://raw.githubusercontent.com/<you>/<repo>/main/output/events.json` (or enable GitHub Pages).

Other options: a cron job on your web server (`17 5 * * * cd /path && python scraper.py`), or a scheduled cloud function.

## Feeding your website

- **Any site / JavaScript:** fetch `events.json`, filter by `group`/date, render a list or calendar.
- **WordPress:** use *The Events Calendar* + its iCal importer (or WP All Import) pointed at `events.ics` / `events.json`.
- **Webflow / Wix / Squarespace:** subscribe to `events.ics`, or push `events.json` to the CMS via its API.
- **Google Calendar embed:** subscribe a public Google Calendar to the `events.ics` URL.

## Rules of the road (important)

- The script checks `robots.txt`, waits 2 s between requests to the same site and sends an identifying User-Agent. Keep it that way.
- Scrape **organisers' own pages**, not other aggregators' curated lists (The Bubble, EU Agenda, Agence Europe Calendar Extra):
  republishing their compiled listings can breach their terms/database rights. Use them only to *discover* new organisers.
- Publish facts (title, date, place, link back to the organiser). Don't copy long descriptions or images.
- Bot-protected sites (Cloudflare etc.): leave them out or ask the organiser for a feed – don't try to get around the protection.

## Maintenance

- Check `run_log.csv` weekly: sources with errors or 0 events for weeks → page moved; fix `events_url`.
- When a source adds a feed, switch its `method` to `ical`/`tribe`/`jsonld` (cheaper, more reliable).
- New organiser? Add a row to `sources.csv` (`enabled=yes`, choose `method`).
- Monthly: look at The Bubble / Agence Europe Calendar Extra / EU Agenda for organisers you don't have yet.
