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
python build_power_data.py --refresh          # lobby register, Commission meetings, scores -> web/data/power.json
python build_city.py UrbISBuildings3D_04000.gpkg ../web/data/power.json   # buildings -> web/data tiles
```
The lobby data changes daily; rerun the first step weekly or monthly. The buildings change slowly: rerun the
second step a few times a year. Download the 3D buildings (GeoPackage, whole region, "04000", ~490 MB zipped) from
https://datastore.brussels/web/urbis-download (UrbIS - 3D Constructions). Always run step 2 after step 1.

## Adjust
- Score weights, lobby cap (60), number of organisations (150) and policy areas: top of `pipeline/build_power_data.py`.
- Institution scores, landmark texts and routes: `pipeline/curated.json`.
- Colours and type: `web/styles.css`; map colours: top of `web/app.js`.
