# Credits and licences

**Rendering approach.** `web/worker.js` and parts of `web/app.js` (binary tiles extruded in web workers,
per-tile attribute textures, GPU picking, the drop-in entrance and rise animations) are adapted from
[amsterdam-by-building](https://github.com/alexbarakov/amsterdam-by-building) by Alex Barakov:

> MIT License. Copyright (c) 2026 alexbarakov. Permission is hereby granted, free of charge, to any person
> obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software
> without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute,
> sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so,
> subject to the following conditions: The above copyright notice and this permission notice shall be included in
> all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.

That project was itself inspired by Sasha Bogachev's *Paris, building by building*.

**three.js** (`web/vendor/`), MIT License, © 2010–2026 three.js authors.

**Data**
- Buildings and heights: UrbIS 3D Constructions, paradigm.brussels (Brussels-Capital Region open data).
- Construction years, architects, styles, building photos and protected status: urban.brussels heritage inventory
  (Irismonument) and protected heritage register. Photos are linked from urban.brussels, not copied.
- Cultural places and photos: Wikidata (CC0) and Wikimedia Commons (each photo under its own licence, credited in the app).
- Aerial photos: UrbIS orthophotos, paradigm.brussels (loaded live from the Region's map service).
- Water, parks, woods: © OpenStreetMap contributors, ODbL.
- Lobbying: EU Transparency Register and European Commission meetings with interest representatives (open data).
- Population: Eurostat. Addresses: UrbIS geocoder. Summaries loaded live from Wikipedia (CC BY-SA).
