# Brussels, by power

Every building in Brussels in 3D, and the institutions, member-state missions and lobbies inside them,
scored by how much say they have over EU decisions.

## Publish it
Upload the `web/` folder to any static host (GitHub Pages, Netlify, Cloudflare Pages, your own server).
It must be served over http(s); opening `index.html` straight from disk will not load the data.
To try it locally: `python3 -m http.server 8642 --directory web`, then open http://localhost:8642

## Refresh the data
```
cd pipeline
pip install lxml pandas openpyxl requests shapely pyproj numpy
python build_power_data.py --refresh          # lobby register, Commission meetings, scores -> web/data/power.json + meetings.json
                                              # (add --retry-geocode to retry addresses that failed last time)
python build_enrich.py --refresh              # heritage inventory, protected heritage, Wikidata + photo credits
python build_city.py UrbISBuildings3D_04000.gpkg ../web/data/power.json   # buildings + enrichment -> web/data
python build_agenda.py --top 260               # upcoming events from organisers' own websites -> web/data/agenda.json
```
The lobby data changes daily; rerun the first step weekly or monthly. The buildings change slowly: rerun the
second step a few times a year. Download the 3D buildings (GeoPackage, whole region, "04000", ~490 MB zipped) from
https://datastore.brussels/web/urbis-download (UrbIS - 3D Constructions). Always run the steps in this order.

## Adjust
- Score weights, lobby cap (60), number of organisations (150) and policy areas: top of `pipeline/build_power_data.py`.
- Institution scores, landmark texts, routes and which curated places count as culture (`CULTURE_IDS`): `pipeline/curated.json`.
- Colours and type: `web/styles.css`; map colours: top of `web/app.js`.

## Agenda
`pipeline/build_agenda.py` reads upcoming events from the organisers' own websites (event feeds, structured data or
event pages) and the European Parliament's open-data calendar. It respects robots.txt and never uses aggregators.
Add or fix an organiser in `pipeline/organisers.json` (name, site, and optionally the exact events page).
Each run lists in agenda.json which organisers returned events and how, so you can see which sites need attention.

## Automatic refresh
Copy `github-workflow-refresh.yml` to `.github/workflows/refresh.yml` at the top of your repository. It rebuilds the
agenda every morning and everything else every Monday, and commits the new data; Vercel then redeploys by itself.
