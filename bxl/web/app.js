// Brussels, by power. Rendering approach (binary tiles extruded in workers, one attribute texture per
// tile, GPU picking, the drop-in entrance) adapted from alexbarakov/amsterdam-by-building (MIT).
import * as THREE from './vendor/three.module.js';
import { MapControls } from './vendor/MapControls.js';

THREE.ColorManagement.enabled = false;

const SKY = '#e5e8ed', LAND = '#f4f3ef', WATER = '#b7c7d4', GREEN = '#e1e7d8', MAQUETTE = '#f0efea';
const BLUE = '#1c3f94', IRIS = '#f2c200', CULTURE = '#d6336c';
// Construction periods for the Heritage mode
const PERIODS = [
  { to: 1700, label: 'Before 1700', note: 'Medieval and Spanish Netherlands', color: '#5b1f1a' },
  { to: 1830, label: '1700–1830', note: 'Austrian, French and Dutch rule', color: '#8f3420' },
  { to: 1880, label: '1830–1880', note: 'Capital of the new Belgium', color: '#c4602a' },
  { to: 1914, label: '1880–1914', note: 'Belle Époque and Art Nouveau', color: '#e3a33f' },
  { to: 1945, label: '1914–1945', note: 'Art Deco and the wars', color: '#86b0a5' },
  { to: 1975, label: '1945–1975', note: 'Expo 58 and Brusselisation', color: '#3f7fa6' },
  { to: 9999, label: 'Since 1975', note: 'The European capital', color: '#26357f' },
];
const periodOf = y => PERIODS.findIndex(p => y < p.to);
const ATTR_W = 256;
const WORKERS = Math.min(4, navigator.hardwareConcurrency || 2);
const LOBBY = new Set(['corp', 'assoc', 'consult', 'union', 'ngo', 'think', 'public']);

const [city, P] = await Promise.all([
  fetch('data/city.json').then(r => r.json()),
  fetch('data/power.json').then(r => r.json()),
]);
// Stations, squares and parks are not buildings: keep them off the model
const NOT_BUILDINGS = new Set(['schuman', 'luxstation', 'maelbeek', 'midi', 'airport', 'plux', 'jourdan', 'leopold', 'cinquantenaire']);
for (const p of P.places) if (NOT_BUILDINGS.has(p.id)) p.gid = null;
for (const [g, ids] of Object.entries(city.buildingPlaces)) {
  const keep = ids.filter(id => !NOT_BUILDINGS.has(id));
  if (keep.length) city.buildingPlaces[g] = keep; else delete city.buildingPlaces[g];
}
const CATS = P.cats;                       // key -> {label, color}
const CAT_KEYS = city.cats;                // index -> key (0 = none)
const places = P.places.filter(p => p.gid != null);
const byId = Object.fromEntries(P.places.map(p => [p.id, p]));
const placesIn = gid => (city.buildingPlaces[gid] || []).map(id => byId[id]).filter(Boolean);
const N_WEEKS = P.weekly.length;
const t0 = new Date(P.termStart + 'T00:00:00');
const weekDate = w => new Date(t0.getTime() + w * 7 * 864e5);
const fmtDate = d => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const fmtNum = n => Number(n).toLocaleString('en-GB');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = s => document.querySelector(s);
const phone = matchMedia('(max-width: 760px)');
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
function prettyName(n) {
  if (!n || n !== n.toUpperCase() || n.length < 7) return n;
  return n.toLowerCase().replace(/\b([a-zà-ÿ])([a-zà-ÿ']{3,})/g, (_, a, b) => a.toUpperCase() + b).replace(/^./, c => c.toUpperCase());
}
for (const p of P.places) p.n = prettyName(p.n);

// ---------- Scene ----------
const canvas = $('#scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setClearColor(SKY);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(35, 1, 5, 60000);
const controls = new MapControls(camera, canvas);
controls.enableDamping = true;
controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
controls.rotateSpeed = 0.6;
controls.maxPolarAngle = Math.PI * 0.47;
controls.minDistance = 60;
controls.maxDistance = 26000;

function homeView(span = city.home.span) {
  const h = city.home, az = THREE.MathUtils.degToRad(h.azimuth), el = THREE.MathUtils.degToRad(h.elevation);
  return { target: new THREE.Vector3(h.x, 0, h.z),
    pos: new THREE.Vector3(h.x + span * Math.cos(el) * Math.sin(az), span * Math.sin(el), h.z + span * Math.cos(el) * Math.cos(az)) };
}
{ const v = homeView(city.home.span * 2.4); controls.target.copy(v.target); camera.position.copy(v.pos); controls.update(); }

// Land, parks and water: flat shapes in the local frame (x east, z south, metres)
function flatMesh(polys, color, y) {
  const shapes = [];
  for (const rings of polys) {
    const s = new THREE.Shape(rings[0].map(([x, z]) => new THREE.Vector2(x, z)));
    for (const h of rings.slice(1)) s.holes.push(new THREE.Path(h.map(([x, z]) => new THREE.Vector2(x, z))));
    shapes.push(s);
  }
  const g = new THREE.ShapeGeometry(shapes);
  g.rotateX(Math.PI / 2);
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -y, polygonOffsetUnits: -y }));
  m.position.y = y * 0.02;
  return m;
}
const flat = new THREE.Group();
if (city.boundary) flat.add(flatMesh([[city.boundary]], LAND, 1));
flat.add(flatMesh(city.green || [], GREEN, 2));
flat.add(flatMesh(city.water || [], WATER, 3));
scene.add(flat);

// ---------- Building material ----------
const col = c => new THREE.Color(c);
const catColors = CAT_KEYS.map(k => col(CATS[k]?.color || MAQUETTE));
const catOn = CAT_KEYS.map(k => (k === 'none' || CATS[k]?.off) ? 0 : 1);
const uniforms = {
  uMode: { value: 0 }, uHover: { value: -1 }, uSelected: { value: -1 }, uNow: { value: 0 },
  uLayerAt: { value: 0 }, uTL: { value: 0 }, uCultureOn: { value: 1 }, uCulture: { value: new THREE.Color(CULTURE) },
  uPeriod: { value: PERIODS.map(p => new THREE.Color(p.color)) }, uPeriodTo: { value: PERIODS.map(p => p.to) },
  uPeriodOn: { value: PERIODS.map(() => 1) },
  uCat: { value: catColors }, uCatOn: { value: catOn },
  uMaquette: { value: col(MAQUETTE) }, uBlue: { value: col(BLUE) }, uIris: { value: col(IRIS) },
  uFogColor: { value: col(SKY) }, uFog: { value: new THREE.Vector2(9000, 24000) },
};

const VERT = /* glsl */`
  in float bld;
  uniform sampler2D uAttr;
  uniform float uMode, uHover, uSelected, uNow, uBorn, uLayerAt, uTL;
  uniform vec3 uCat[16];
  uniform float uCatOn[16];
  uniform vec3 uMaquette, uBlue, uIris, uCulture;
  uniform float uCultureOn;
  uniform vec3 uPeriod[${PERIODS.length}];
  uniform float uPeriodTo[${PERIODS.length}];
  uniform float uPeriodOn[${PERIODS.length}];
  out vec3 vColor;
  out vec3 vWorld;
  out float vGid;

  vec3 heightRamp(float h) {
    float t = clamp(log(max(h, 2.0) / 2.0) / log(60.0), 0.0, 1.0);
    vec3 a = vec3(0.91, 0.92, 0.93), b = vec3(0.66, 0.73, 0.86), c = vec3(0.24, 0.35, 0.64), d = vec3(0.07, 0.11, 0.30);
    return t < 0.33 ? mix(a, b, t / 0.33) : t < 0.66 ? mix(b, c, (t - 0.33) / 0.33) : mix(c, d, (t - 0.66) / 0.34);
  }

  void main() {
    int i = int(bld + 0.5);
    ivec2 tc = ivec2(2 * (i % ${ATTR_W}), i / ${ATTR_W});
    vec4 a = texelFetch(uAttr, tc, 0);
    vec4 b = texelFetch(uAttr, tc + ivec2(1, 0), 0);
    float power = a.x;
    int cat = int(a.y + 0.5);
    vGid = a.w;
    vec3 p = position;
    float seed = fract(sin(a.w * 12.9898) * 43758.5453);

    // Entrance: each building drops in from its own side of the sky as its tile arrives.
    float arrive = clamp((uNow - uBorn) / 0.9 - seed * 0.35, 0.0, 1.0);
    float fly = 1.0 - arrive;
    if (fly > 0.0) {
      float e = fly * fly * fly, ang = seed * 6.2831853;
      p += vec3(cos(ang), 0.0, sin(ang)) * (1800.0 + 1600.0 * fract(seed * 7.13)) * e;
      p.y += (2600.0 + 2400.0 * fract(seed * 3.71)) * e;
    }

    int flags = int(b.x + 0.5);
    bool culture = ((flags >> 20) & 1) == 1;
    bool protectedSite = ((flags >> 21) & 1) == 1;
    float year = b.w;
    vec3 c = uMaquette;
    bool rise = false;
    if (uMode < 0.5) {
      if (power >= 0.0 && uCatOn[cat] > 0.5) { c = mix(uMaquette, uCat[cat], 0.3 + 0.7 * power / 100.0); rise = true; }
    } else if (uMode < 1.5) {
      if (b.y > 0.0) { c = mix(vec3(0.80, 0.85, 0.93), uBlue, b.y / 100.0); rise = true; }
    } else if (uMode < 2.5) {
      c = heightRamp(a.z);
    } else if (culture && uCultureOn > 0.5) {
      c = mix(uMaquette, uCulture, 0.85); rise = true;
    } else if (year > 0.0) {
      for (int k = 0; k < ${PERIODS.length}; k++) {
        if (year < uPeriodTo[k]) {
          if (uPeriodOn[k] > 0.5) { c = uPeriod[k]; if (protectedSite) c = mix(c, vec3(0.0), 0.18); rise = true; }
          break;
        }
      }
    }
    // The timeline: each lobby's building grows with the meetings it has had so far this term.
    if (uTL > 0.5 && uMode < 1.5 && cat >= 5 && cat <= 11 && power >= 0.0) {
      p.y *= mix(0.05, 1.0, b.z);
      c = mix(uMaquette, c, b.z);
    }
    // Switching what is shown: the buildings that matter rise out of the ground, overshoot a little, settle.
    if (rise) {
      float k = clamp((uNow - uLayerAt) / 0.55 - seed * 0.6, 0.0, 1.0);
      float q = k - 1.0;
      p.y *= 1.0 + 2.70158 * q * q * q + 1.70158 * q * q;
    }
    if (vGid == uSelected) c = mix(c, uIris, 0.8);
    else if (vGid == uHover) c = mix(c, vec3(0.0), 0.32);
    vColor = c;
    vec4 w = modelMatrix * vec4(p, 1.0);
    vWorld = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;
const FRAG = /* glsl */`
  precision highp float;
  uniform vec3 uFogColor;
  uniform vec2 uFog;
  in vec3 vColor;
  in vec3 vWorld;
  in float vGid;
  out vec4 outColor;
  void main() {
    #ifdef PICK
      float id = vGid + 1.0;
      outColor = vec4(mod(id, 256.0), mod(floor(id / 256.0), 256.0), floor(id / 65536.0), 255.0) / 255.0;
    #else
      vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
      float sun = max(dot(n, normalize(vec3(-0.5, 0.6, 0.62))), 0.0);
      float light = n.y > 0.9 ? 1.04 : 0.66 + 0.34 * sun;
      float foot = mix(0.84, 1.0, clamp(vWorld.y / 12.0, 0.0, 1.0));
      vec3 c = vColor * light * foot;
      c = mix(c, uFogColor, smoothstep(uFog.x, uFog.y, length(vWorld - cameraPosition)));
      outColor = vec4(c, 1.0);
    #endif
  }
`;
function makeMaterial(tex, pick, born) {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3, uniforms: { ...uniforms, uAttr: { value: tex }, uBorn: born },
    vertexShader: VERT, fragmentShader: FRAG, defines: pick ? { PICK: 1 } : {}, side: THREE.DoubleSide,
  });
}

// ---------- Tiles ----------
const meshes = [], tileData = [];
const gidTile = new Int32Array(city.buildings).fill(-1), gidIdx = new Uint32Array(city.buildings);
const placedGids = Object.keys(city.buildingPlaces).map(Number);
let loaded = 0;
const queue = [...city.tiles];
const pool = Array.from({ length: WORKERS }, () => new Worker('worker.js', { type: 'module' }));

function addTile(m) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(m.pos, 3));
  g.setAttribute('bld', new THREE.BufferAttribute(m.bld, 1));
  g.setIndex(new THREE.BufferAttribute(m.idx, 1));
  const rows = Math.max(1, Math.ceil(m.nB / ATTR_W));
  const data = new Float32Array(ATTR_W * 2 * rows * 4);
  data.set(m.attr);
  const tex = new THREE.DataTexture(data, ATTR_W * 2, rows, THREE.RGBAFormat, THREE.FloatType);
  tex.needsUpdate = true;
  const t = tileData.length;
  tileData.push({ data, tex, key: city.tiles.find(t => t.file === m.id).pack.replace('pack', 'info').replace('.bin', '.json') });
  for (let b = 0; b < m.nB; b++) { const gid = m.attr[b * 8 + 3]; gidTile[gid] = t; gidIdx[gid] = b; }
  const born = { value: reduced ? -10 : performance.now() / 1000 };
  const mesh = new THREE.Mesh(g, makeMaterial(tex, false, born));
  mesh.userData = { draw: mesh.material, pick: makeMaterial(tex, true, born) };
  mesh.scale.setScalar(0.1);
  mesh.position.set(m.origin[0], 0, m.origin[1]);
  scene.add(mesh);
  meshes.push(mesh);
}
function setAttr(gid, slot, value) {
  const t = gidTile[gid]; if (t < 0) return;
  tileData[t].data[gidIdx[gid] * 8 + slot] = value;
  tileData[t].dirty = true;
}
function flushAttr() { for (const t of tileData) if (t.dirty) { t.tex.needsUpdate = true; t.dirty = false; } }
const heightOf = gid => gidTile[gid] >= 0 ? tileData[gidTile[gid]].data[gidIdx[gid] * 8 + 2] : null;

const packs = Object.fromEntries(city.packs.map(name => [name, fetch(`data/${name}`).then(r => r.arrayBuffer())]));
for (const w of pool) {
  const next = async () => {
    const t = queue.shift();
    if (!t) return;
    const buf = (await packs[t.pack]).slice(t.offset, t.offset + t.length);
    w.postMessage({ buf, id: t.file }, [buf]);
  };
  w.onmessage = ({ data }) => {
    addTile(data);
    loaded++;
    $('#progress').textContent = Math.round(100 * loaded / city.tiles.length);
    if (loaded === city.tiles.length) cityReady();
    next();
  };
  next();
}

// ---------- Picking ----------
const pickTarget = new THREE.WebGLRenderTarget(1, 1);
const pickPixel = new Uint8Array(4);
function pick(x, y) {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  camera.setViewOffset(w, h, x, y, 1, 1);
  for (const m of meshes) m.material = m.userData.pick;
  flat.visible = false;
  renderer.setRenderTarget(pickTarget);
  renderer.setClearColor(0x000000, 0);
  renderer.clear();
  renderer.render(scene, camera);
  renderer.readRenderTargetPixels(pickTarget, 0, 0, 1, 1, pickPixel);
  renderer.setRenderTarget(null);
  renderer.setClearColor(SKY);
  for (const m of meshes) m.material = m.userData.draw;
  flat.visible = true;
  camera.clearViewOffset();
  return pickPixel[0] + pickPixel[1] * 256 + pickPixel[2] * 65536 - 1;
}

// ---------- Camera flights ----------
let flight = null;
function flyTo(x, z, distance = 520, done = null) {
  const dir = camera.position.clone().sub(controls.target).normalize();
  if (dir.y < 0.45) { dir.y = 0.6; dir.normalize(); }
  const target = new THREE.Vector3(x, 0, z);
  flight = { t0: performance.now(), dur: reduced ? 1 : 1400, from: { t: controls.target.clone(), p: camera.position.clone() },
    to: { t: target, p: target.clone().add(dir.multiplyScalar(distance)) }, done };
}
function stepFlight(now) {
  if (!flight) return;
  const k = Math.min(1, (now - flight.t0) / flight.dur), e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
  controls.target.lerpVectors(flight.from.t, flight.to.t, e);
  camera.position.lerpVectors(flight.from.p, flight.to.p, e);
  if (k >= 1) { const d = flight.done; flight = null; d?.(); }
}
controls.addEventListener('start', () => { flight = null; });

// ---------- Live attributes: policy-area scores and timeline growth ----------
const sectorKeys = Object.keys(P.sectors);
let sector = sectorKeys[0];
let office = null, officeList = null;
function applySector() {
  const officeScore = {};
  if (office && officeList) {
    const max = officeList[0]?.[1] || 1;
    for (const [pid, n] of officeList) { const g = byId[pid]?.gid; if (g != null) officeScore[g] = Math.max(officeScore[g] || 0, 100 * Math.sqrt(n / max)); }
  }
  for (const gid of placedGids) {
    let s = 0;
    if (office) s = officeScore[gid] || 0;
    else for (const p of placesIn(gid)) s = Math.max(s, p.sec?.[sector] || 0);
    setAttr(gid, 5, s);
  }
  flushAttr();
}
// Lazily loaded meeting details: recent meetings, who each office meets, card details
let meetPromise = null, meetData = null;
const getMeet = () => meetPromise ||= fetch('data/meetings.json').then(r => r.json()).then(d => (meetData = d));
async function showOffice(name) {
  const d = await getMeet();
  office = name; officeList = d.offices[name] || [];
  pinCard(-1);
  setMode(1);
}
// Cumulative meetings per building, week by week, for the lobbies inside it
const growth = new Map();
for (const gid of placedGids) {
  const lob = placesIn(gid).filter(p => p.org);
  if (!lob.length) continue;
  const cum = new Float32Array(N_WEEKS);
  let run = 0;
  for (let w = 0; w < N_WEEKS; w++) { for (const p of lob) run += p.org.wk?.[w] || 0; cum[w] = run; }
  growth.set(gid, cum);
}
const totalCum = []; P.weekly.reduce((a, v, i) => (totalCum[i] = a + v), 0);
let week = N_WEEKS - 1;
function applyWeek() {
  for (const [gid, cum] of growth) { const end = cum[N_WEEKS - 1]; setAttr(gid, 6, end ? cum[week] / end : 0); }
  flushAttr();
  uniforms.uTL.value = week < N_WEEKS - 1 || playing ? 1 : 0;
  updateTally();
  drawHist();
}

// ---------- Panel ----------
let mode = 0;
const panelBody = $('#panel-body');
const ranked = () => places.filter(p => p.power != null && catOn[CAT_KEYS.indexOf(p.c)])
  .sort((a, b) => b.power - a.power).slice(0, 40);
function rankHtml(list, val, color) {
  return `<ol class="prl">${list.map((p, i) => `<li><button class="pr" data-place="${esc(p.id)}" style="--tc:${color || CATS[p.c].color}">
    <span class="pr-rank">${i + 1}</span>
    <span class="pr-nm"><b title="${esc(p.n)}">${esc(p.n)}</b><span>${esc(CATS[p.c].label)}</span></span>
    <span class="pr-score">${Math.round(val(p))}</span></button></li>`).join('')}</ol>`;
}
function renderPanel() {
  if (mode === 0) {
    const counts = {}; for (const p of places) counts[p.c] = (counts[p.c] || 0) + 1;
    panelBody.innerHTML = `
      <input class="search" id="find" type="search" placeholder="Find an organisation or institution" aria-label="Find an organisation or institution" value="${esc(findQuery)}">
      <ol class="rank" id="found"></ol>
      <h2 style="margin-top:12px">Who has power</h2>
      <p class="hint">Coloured buildings hold an EU institution, a member state's mission or one of ${fmtNum(P.orgCount)} registered lobbies with a Brussels office. The stronger the colour, the higher the power score; a building takes the colour of its most powerful occupant.</p>
      <div class="ptiles"><div class="ptile"><b>${fmtNum(places.filter(p => !p.org).length)}</b><span>institutions &amp; missions</span></div>
        <div class="ptile"><b>${fmtNum(places.filter(p => p.org).length)}</b><span>registered lobbies</span></div></div>
      <h2 class="section">Show on the map <span class="n">tap to switch off</span></h2>
      <div class="lchips">${CAT_KEYS.map((k, i) => counts[k] ? `<button data-cat="${i}" aria-pressed="${!!catOn[i]}" style="--tc:${CATS[k].color}">${esc(CATS[k].label)}<span class="n">${fmtNum(counts[k])}</span></button>` : '').join('')}</div>
      <h2 class="section">Most powerful</h2>
      ${rankHtml(ranked(), p => p.power)}`;
  } else if (mode === 4) {
    panelBody.innerHTML = agendaHtml();
  } else if (mode === 1 && office) {
    const list = (officeList || []).slice(0, 40);
    const max = list[0]?.[1] || 1;
    panelBody.innerHTML = `
      <button class="back-link" data-office-clear>All policy areas</button>
      <h2>Who meets ${esc(office)}</h2>
      <p class="hint">Mapped organisations by number of meetings with ${esc(office)} since ${fmtDate(t0)}. Darker blue, more meetings.</p>
      <ol class="rank">${list.map(([pid, n], i) => { const p = byId[pid]; return p ? `<li><button data-place="${esc(pid)}">
        <span class="pos">${i + 1}</span><span class="nm"><b title="${esc(p.n)}">${esc(p.n)}</b><span class="bar"><i style="width:${100 * n / max}%;background:${BLUE}"></i></span></span>
        <span class="val">${n}</span></button></li>` : ''; }).join('')}</ol>`;
  } else if (mode === 1) {
    const s = P.sectors[sector];
    const list = places.filter(p => p.sec?.[sector]).sort((a, b) => b.sec[sector] - a.sec[sector]).slice(0, 30);
    panelBody.innerHTML = `
      <h2>Commission access by policy area</h2>
      <div class="sectors">${sectorKeys.map(k => `<button data-sector="${k}" aria-pressed="${k === sector}">${esc(P.sectors[k].label)}</button>`).join('')}</div>
      <p class="hint">Meetings since ${fmtDate(t0)} with ${esc(s.dgs.map(d => 'DG ' + d).join(', '))} and the cabinet${s.cabs.length > 1 ? 's' : ''} of ${esc(s.cabs.join(' and '))}. Darker blue, more access.</p>
      ${rankHtml(list, p => p.sec[sector], BLUE)}`;
  } else if (mode === 3) {
    panelBody.innerHTML = `
      <h2>When it was built</h2>
      <p class="hint">${fmtNum(city.dated)} buildings have a construction date in the Brussels heritage inventory or Wikidata. Darker shades are protected heritage.</p>
      <ul class="legend"><li><button data-culture aria-pressed="${!!uniforms.uCultureOn.value}"><span class="sw" style="background:${CULTURE}"></span><span>Culture <span class="n">museums, theatres, churches…</span></span><span class="n">${city.culture.length}</span></button></li>${PERIODS.map((p, i) => `<li><button data-period="${i}" aria-pressed="${!!uniforms.uPeriodOn.value[i]}">
        <span class="sw" style="background:${p.color}"></span><span>${p.label} <span class="n">${esc(p.note)}</span></span><span class="n">${periodCounts ? fmtNum(periodCounts[i]) : ''}</span></button></li>`).join('')}</ul>
      <h2 class="section">Culture</h2>
      <p class="hint">Museums, theatres, churches, palaces and other cultural places from Wikidata, shown in pink in Power mode.</p>
      <ol class="rank">${city.culture.slice(0, 60).map((c, i) => `<li><button data-gid="${c.gid}">
        <span class="pos">${i + 1}</span><span class="nm"><b title="${esc(c.n)}">${esc(c.n)}</b><span class="n">${esc(c.k)}</span></span><span class="val"></span></button></li>`).join('')}</ol>`;
  } else {
    panelBody.innerHTML = `
      <h2>Building height</h2>
      <p class="hint">Measured from the Brussels Region's 3D model of all ${fmtNum(city.buildings)} buildings.</p>
      <div class="ramp" style="background:linear-gradient(90deg,#e8eaed,#a8bbdb,#3d5aa3,#121c4d)"></div>
      <div class="ramp-labels"><span>2 m</span><span>15 m</span><span>40 m</span><span>120 m</span></div>
      <h2 class="section">Tallest with power</h2>
      ${rankHtml(places.filter(p => p.power != null).map(p => ({ ...p, h: heightOf(p.gid) || 0 })).sort((a, b) => b.h - a.h).slice(0, 15), p => Math.min(100, p.h))}`;
  }
}
panelBody.addEventListener('click', e => {
  const c = e.target.closest('[data-cat]');
  if (c) { const i = +c.dataset.cat; catOn[i] = catOn[i] ? 0 : 1; uniforms.uLayerAt.value = now(); renderPanel(); return; }
  if (e.target.closest('[data-culture]')) { uniforms.uCultureOn.value = uniforms.uCultureOn.value ? 0 : 1; uniforms.uLayerAt.value = now(); renderPanel(); return; }
  const pr = e.target.closest('[data-period]');
  if (pr) { const i = +pr.dataset.period; uniforms.uPeriodOn.value[i] = uniforms.uPeriodOn.value[i] ? 0 : 1; uniforms.uLayerAt.value = now(); renderPanel(); return; }
  const gb = e.target.closest('[data-gid]');
  if (gb) { focusGid(+gb.dataset.gid); return; }
  const ag = e.target.closest('[data-ag]');
  if (ag) { const [k, v] = ag.dataset.ag.split('='); agf[k] = v; applyAgenda(); renderPanel(); return; }
  const ev = e.target.closest('[data-event]');
  if (ev) { const x = agenda.events[+ev.dataset.event]; if (byId[x.place]?.gid != null) focusPlace(x.place); return; }
  if (e.target.closest('[data-office-clear]')) { office = null; applySector(); uniforms.uLayerAt.value = now(); renderPanel(); return; }
  const s = e.target.closest('[data-sector]');
  if (s) { office = null; sector = s.dataset.sector; applySector(); uniforms.uLayerAt.value = now(); renderPanel(); return; }
  const p = e.target.closest('[data-place]');
  if (p) focusPlace(p.dataset.place);
});
let findQuery = '';
panelBody.addEventListener('change', e => {
  if (e.target.id === 'ag-topic') { agf.topic = e.target.value; applyAgenda(); renderPanel(); }
});
panelBody.addEventListener('input', e => {
  if (e.target.id !== 'find') return;
  findQuery = e.target.value;
  const q = findQuery.trim().toLowerCase();
  const hits = q.length < 2 ? [] : places.filter(p => (p.n + ' ' + (p.a || '')).toLowerCase().includes(q))
    .sort((a, b) => (b.power ?? -1) - (a.power ?? -1)).slice(0, 12);
  $('#found').innerHTML = hits.map(p => `<li><button data-place="${esc(p.id)}"><span class="pos"><span class="sw" style="display:inline-block;background:${CATS[p.c].color}"></span></span>
    <span class="nm"><b title="${esc(p.n)}">${esc(p.n)}</b><span class="n">${esc(p.a || '')}</span></span><span class="val">${p.power != null ? Math.round(p.power) : ''}</span></button></li>`).join('')
    || (q.length >= 2 ? '<li class="n" style="padding:4px 0">No match</li>' : '');
});
panelBody.addEventListener('pointerover', e => {
  const p = e.target.closest('[data-place]');
  if (p && pinnedGid < 0) uniforms.uHover.value = byId[p.dataset.place]?.gid ?? -1;
  const evh = e.target.closest('[data-event]');
  if (evh && pinnedGid < 0) uniforms.uHover.value = byId[agenda?.events[+evh.dataset.event]?.place]?.gid ?? -1;
  const g = e.target.closest('[data-gid]');
  if (g && pinnedGid < 0) uniforms.uHover.value = +g.dataset.gid;
});
panelBody.addEventListener('pointerleave', () => { if (pinnedGid < 0) uniforms.uHover.value = -1; });
$('.sheet-handle').addEventListener('click', () => setCollapsed(!$('#panel').classList.contains('collapsed')));
function setCollapsed(c) {
  $('#panel').classList.toggle('collapsed', c);
  $('.sheet-handle').textContent = c ? 'Show legend' : 'Hide legend';
  $('.sheet-handle').setAttribute('aria-expanded', String(!c));
}

document.querySelectorAll('.modes [data-mode]').forEach(b => b.addEventListener('click', () => setMode(+b.dataset.mode)));
function setMode(m) {
  mode = m;
  uniforms.uMode.value = m === 4 ? 1 : m;
  $('#panel').classList.toggle('wide', m === 4);
  if (m === 4) { getAgenda().then(() => { applyAgenda(); renderPanel(); }); }
  uniforms.uLayerAt.value = now();
  document.querySelectorAll('.modes [data-mode]').forEach(b => b.setAttribute('aria-pressed', String(+b.dataset.mode === m)));
  if (m === 1) applySector();
  if (m === 4 && agenda) applyAgenda();
  renderPanel();
}

// ---------- Agenda: upcoming Brussels policy events, read from the organisers' own websites ----------
let agenda = null, agendaPromise = null;
const getAgenda = () => agendaPromise ||= fetch('data/agenda.json').then(r => r.ok ? r.json() : { events: [] }).then(d => (agenda = d)).catch(() => (agenda = { events: [] }));
const agf = { day: 'today', format: 'all', topic: 'all', dur: 'all' };
const bxlNow = () => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Brussels', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date()).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
};
const addDays = (iso, n) => new Date(Date.parse(iso + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const mins = t => t ? +t.slice(0, 2) * 60 + +t.slice(3, 5) : null;
function agendaList() {
  if (!agenda) return [];
  const now = bxlNow(), t = now.date;
  const range = { today: [t, t], tomorrow: [addDays(t, 1), addDays(t, 1)], week: [t, addDays(t, 6)], all: [t, '9999'] }[agf.day];
  return agenda.events.map((e, i) => ({ ...e, i })).filter(e => {
    const last = e.endDate || e.date;
    if (last < range[0] || e.date > range[1]) return false;
    if (agf.format !== 'all' && e.format !== agf.format) return false;
    if (agf.topic !== 'all' && e.topic !== agf.topic) return false;
    const d = e.start && e.end ? mins(e.end) - mins(e.start) : null;
    if (agf.dur === 'short' && !(d != null && d <= 120)) return false;
    if (agf.dur === 'long' && !(e.endDate || (d != null && d > 120))) return false;
    return true;
  });
}
function liveNow(e) {
  const n = bxlNow();
  if (e.date > n.date || (e.endDate || e.date) < n.date) return false;
  if (e.endDate && e.date < n.date) return true;
  return e.start && e.end && mins(n.time) >= mins(e.start) && mins(n.time) < mins(e.end);
}
function applyAgenda() {
  const hosts = {};
  for (const e of agendaList()) { const g = byId[e.place]?.gid; if (g != null) hosts[g] = 100; }
  for (const gid of placedGids) setAttr(gid, 5, hosts[gid] || 0);
  flushAttr();
}
function agendaHtml() {
  if (!agenda) return '<p class="hint">Loading the agenda…</p>';
  const list = agendaList(), now = bxlNow();
  const title = { today: `Today, ${fmtDate(new Date(now.date + 'T12:00:00'))}`, tomorrow: `Tomorrow, ${fmtDate(new Date(addDays(now.date, 1) + 'T12:00:00'))}`,
    week: 'The next 7 days', all: `Until ${fmtDate(new Date(agenda.to + 'T12:00:00'))}` }[agf.day];
  const chip = (k, v, label) => `<button class="chip${agf[k] === v ? ' on' : ''}" data-ag="${k}=${v}">${label}</button>`;
  let lastDay = null;
  const items = list.map(e => {
    const head = agf.day !== 'today' && agf.day !== 'tomorrow' && e.date !== lastDay ? `<li class="ag-day">${fmtDate(new Date(e.date + 'T12:00:00'))}</li>` : '';
    lastDay = e.date;
    const mapped = byId[e.place]?.gid != null;
    const time = e.start ? `${e.start}${e.end ? '–' + e.end : ''}` : (e.endDate ? `until ${fmtDate(new Date(e.endDate + 'T12:00:00'))}` : 'Time on the event page');
    return head + `<li class="ag-item"><div class="ag-org">${mapped ? `<button data-event="${e.i}" title="Show on the map">${esc(e.org)}</button>` : esc(e.org)}${liveNow(e) ? '<span class="live">Live now</span>' : ''}</div>
      <a class="ag-title" href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.title)}</a>
      <div class="ag-meta"><span>${esc(time)}</span><span>${esc(e.topic)}</span><span class="fmt fmt-${e.format.replace(' ', '').toLowerCase()}">${esc(e.format)}</span></div></li>`;
  }).join('');
  return `<h2>${esc(title)}</h2><p class="hint">${list.length} event${list.length === 1 ? '' : 's'}. Organisers with a building on the map are lit up; tap a name to fly there.</p>
    <div class="sectors">${chip('day', 'today', 'Today')}${chip('day', 'tomorrow', 'Tomorrow')}${chip('day', 'week', '7 days')}${chip('day', 'all', 'All upcoming')}</div>
    <div class="sectors">${chip('format', 'all', 'All')}${chip('format', 'In person', 'In person')}${chip('format', 'Online', 'Online')}${chip('format', 'Hybrid', 'Hybrid')}</div>
    <div class="ag-row"><select id="ag-topic" aria-label="Topic"><option value="all">All topics</option>${(agenda.topics || []).map(t => `<option ${agf.topic === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>
      ${chip('dur', 'all', 'Any length')}${chip('dur', 'short', 'Up to 2 h')}${chip('dur', 'long', 'Longer')}</div>
    <ol class="ag-list">${items || '<li class="hint">No events match these filters.</li>'}</ol>
    <p class="hint" style="margin-top:10px">Collected daily from ${agenda.sources?.filter(s => s.events).length || 0} organisers' own websites and the European Parliament's calendar. Times are Brussels time; check the event page before you go.</p>`;
}

// ---------- Lobby meetings: consistent, ordered presentation ----------
const MON = new Intl.DateTimeFormat('en-GB', { month: 'short' });
const WD = new Intl.DateTimeFormat('en-GB', { weekday: 'short' });
const levelOf = who => /^DG |^SG$|^Secretariat/.test(who) ? 'Senior staff' : 'Commissioner or cabinet';
// Newest first, one row per meeting: date block, who they met (and at what level), what about
function meetingRows(rec, { limit = 4, showOrg = false } = {}) {
  const rows = rec.map(([d, who, subj, org], k) => {
    const dt = new Date(d + 'T12:00:00');
    return `<li class="mt${k >= limit ? ' extra' : ''}"><div class="mt-date"><b>${dt.getDate()}</b><span>${MON.format(dt)}<br>${WD.format(dt)}</span></div>
      <div class="mt-body">${showOrg ? `<div class="mt-org">${esc(prettyName(org || ''))}</div>` : ''}
        <button class="mt-who" data-office="${esc(who)}" title="See who else meets ${esc(who)}">${esc(who)}</button>
        <span class="mt-level">${levelOf(who)}</span>
        ${subj ? `<p class="mt-subj">${esc(subj)}</p>` : '<p class="mt-subj n">No subject published</p>'}</div></li>`;
  }).join('');
  return `<ol class="mtl${rec.length > limit ? ' folded' : ''}">${rows}</ol>${rec.length > limit ? `<button class="show-all" data-unfold>Show all ${rec.length}</button>` : ''}`;
}
// Ranked rows with a bar, largest first; optional data attribute makes each row a button
function rankRows(pairs, { attr = null, color = BLUE, label = x => x } = {}) {
  if (!pairs.length) return '';
  return `<ol class="rkl">${pairs.map(([k, n], i) => {
    const c = typeof color === 'function' ? color(k) : color;
    const inner = `<span class="rk-i">${i + 1}</span><span class="rk-n" title="${esc(label(k))}">${esc(label(k))}</span><span class="rk-c">${fmtNum(n)}</span>`;
    return `<li style="--tc:${c}">${attr && !String(k).startsWith('~') ? `<button class="rkr" ${attr}="${esc(k)}">${inner}</button>` : `<div class="rkr">${inner}</div>`}</li>`;
  }).join('')}</ol>`;
}
// Counts as tinted chips (types of lobby, policy areas)
function countChips(pairs, { color = () => BLUE, label = x => x } = {}) {
  return `<div class="cchips">${pairs.map(([k, n]) => `<span style="--tc:${color(k)}">${esc(label(k))}<b>${fmtNum(n)}</b></span>`).join('')}</div>`;
}

// ---------- Cards ----------
const card = $('#card');
let pinnedGid = -1, hoverGid = -1, cardPlace = null;
const basisLabel = { formal: 'Formal authority', council: 'Council voting weight', influence: 'Measured influence' };
// Per-building facts (heritage inventory, protection, Wikidata), loaded per tile on demand
const infoFiles = {}, infoLoaded = {};
function infoFor(gid) {
  const t = gidTile[gid]; if (t < 0) return Promise.resolve(null);
  const key = tileData[t].key;
  infoFiles[key] ||= fetch(`data/${key}`).then(r => r.ok ? r.json() : {}).catch(() => ({})).then(d => (infoLoaded[key] = d));
  return infoFiles[key].then(d => d[gid] || null);
}
const infoNow = gid => { const t = gidTile[gid]; return t < 0 ? null : (infoLoaded[tileData[t].key] || {})[gid] || null; };
function fmtSpend(s) {
  if (!s) return null;
  const m = v => v >= 1e6 ? `€${(v / 1e6).toFixed(v % 1e6 ? 1 : 0)}m` : `€${Math.round(v / 1e3)}k`;
  if (s[0] >= 1e7 && s[1] <= s[0]) return '€10m or more';
  return s[0] === s[1] ? m(s[0]) : `${m(s[0])}–${m(s[1] + 1)}`;
}
function scoreHtml(p) {
  if (p.power == null) return '';
  let sub = basisLabel[p.basis];
  if (p.basis === 'influence') sub += `<br>ranked ${fmtNum(p.org.rank)} of ${fmtNum(P.registrants)} in Brussels`;
  if (p.basis === 'council') sub += `<br>${p.rep.share}% of the EU population`;
  return `<div class="score"><b>${Math.round(p.power)}</b><span>Power score<br>${sub}</span></div>`;
}
function posOf(gid) {
  const b = city.buildingPos[gid]; if (b) return { x: b[0], z: b[1], h: b[2], r: b[3] || 25 };
  const c = city.culture.find(q => q.gid === gid); return c ? { x: c.x, z: c.z, h: c.h, r: c.r || 25 } : null;
}
// Aerial photo of the building from the Brussels Region's orthophoto service (UrbIS, paradigm.brussels)
function aerialUrl(gid) {
  const p = posOf(gid); if (!p) return null;
  const X = city.origin[0] + p.x, Y = city.origin[1] - p.z, hy = Math.max(30, p.r * 1.5), hx = hy * 4 / 3;
  return `https://geoservices-urbis.irisnet.be/geoserver/urbisgrid/ows?service=WMS&version=1.3.0&request=GetMap&layers=Ortho&styles=&crs=EPSG:31370&bbox=${(X - hx).toFixed(1)},${(Y - hy).toFixed(1)},${(X + hx).toFixed(1)},${(Y + hy).toFixed(1)}&width=640&height=480&format=image/jpeg`;
}
const latLngOf = (gid, p) => p?.lat ? [p.lat, p.lng] : (q => q ? [50.8427 - q.z / 111320, 4.3808 + q.x / (111320 * Math.cos(50.8427 * Math.PI / 180))] : null)(posOf(gid));
function photoOf(f, gid) {
  const w = f?.wd?.photo, inv = f?.inv;
  if (w?.thumb) return { src: w.thumb, credit: `Photo: ${w.credit || 'Wikimedia Commons'}`, link: w.page, tag: 'Street' };
  if (inv?.img) return { src: inv.img, credit: 'Photo: urban.brussels, heritage inventory', link: inv.url, tag: 'Street' };
  const a = aerialUrl(gid);
  return a ? { src: a, credit: 'Aerial photo: UrbIS, paradigm.brussels', link: null, tag: 'From above' } : null;
}
const cap = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
function cardHtml(gid, pinned, placeId) {
  const ps = placesIn(gid), f = infoNow(gid), h = heightOf(gid);
  const p = (placeId && ps.find(q => q.id === placeId)) || ps[0] || null;
  const others = ps.filter(q => q !== p);
  const inv = f?.inv, wd = f?.wd, prot = f?.prot;
  const year = inv?.year || wd?.year;
  const title = p?.n || wd?.name || inv?.name || inv?.addr || `A ${Math.round(h || 0)} m building`;
  const addr = p?.a || inv?.addr || '';
  const photo = photoOf(f, gid);
  const detail = p ? meetData?.detail?.[p.id] : null;
  let html = pinned ? '<button class="card-close" aria-label="Close">×</button>' : '';
  if (photo) html += `<figure class="photo"><div class="ph"><img src="${esc(photo.src)}" alt="" loading="lazy"><span class="tag">${photo.tag}</span></div><figcaption>${photo.link && pinned ? `<a href="${esc(photo.link)}" target="_blank" rel="noopener">${esc(photo.credit)}</a>` : esc(photo.credit)}</figcaption></figure>`;
  html += `<div class="body"><h3>${esc(title)}</h3>${addr ? `<div class="addr">${esc(addr)}</div>` : ''}`;
  if (year) {
    const pi = periodOf(year);
    html += `<div class="year"><b>${year}</b><span><i class="sw" style="background:${PERIODS[pi].color}"></i>${esc(inv?.style || PERIODS[pi].note)}</span></div>`;
  }
  if (p) html += scoreHtml(p);
  const layers = [];
  if (p) layers.push([CATS[p.c].color, CATS[p.c].label, p.power != null ? `power ${Math.round(p.power)}` : '']);
  if (others.length) layers.push(['#c3cad4', `${others.length} more organisation${others.length > 1 ? 's' : ''}`, 'in this building']);
  if (wd?.cls?.length) layers.push([CULTURE, 'Culture', wd.cls.join(', ')]);
  if (prot) layers.push(['#3b2a20', 'Protected heritage', [prot.as, prot.date?.slice(0, 4)].filter(Boolean).join(', ')]);
  else if (inv?.listed) layers.push(['#3b2a20', 'Protected heritage', '']);
  if (inv) layers.push(['#8c7a68', 'Heritage inventory', cap(inv.type || '')]);
  if (layers.length) html += `<h4>In layers</h4><ul class="inlayers">${layers.map(([c, a, b]) => `<li><span class="sw" style="background:${c}"></span><b>${esc(a)}</b> ${esc(b)}</li>`).join('')}</ul>`;
  const facts = [];
  if (h) facts.push(['Height', `${Math.round(h)} m`]);
  if (h) facts.push(['Storeys', `about ${Math.max(1, Math.round(h / 3.2))}`]);
  const arch = inv?.arch || (wd?.arch || []).join(', ');
  if (arch && pinned) facts.push(['Architects', arch.replace(/\s*\(\d{4}(-\d{4})?\)/g, '')]);
  if (inv?.type && pinned) facts.push(['Type', cap(inv.type)]);
  if (inv?.unesco) facts.push(['UNESCO', 'World Heritage']);
  const factsHtml = facts.length ? `<dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : '';
  const deferFacts = pinned && !!p?.org;          // for organisations, meetings come before building facts
  if (!deferFacts) html += factsHtml;
  if (!pinned) return html + `<p class="more">${others.length ? `${others.length + 1} organisations in this building. ` : ''}Click to see details</p></div>`;

  if (p?.d) html += `<p>${esc(p.d)}</p>`;
  else if (wd?.desc) html += `<p>${esc(cap(wd.desc))}.</p>`;
  if (p?.why) html += `<p class="why">${esc(p.why)}</p>`;
  if (p?.org) {
    const o = p.org;
    const rec = meetData?.recent?.[p.id] || [];
    // 1. Commission meetings first: what lobbyists look for
    html += `<section class="meet-sec"><h4 class="sec-h">Commission meetings this term</h4>`;
    if (o.top + o.dg) {
      html += `<div class="meet-sum"><div><b>${fmtNum(o.top + o.dg)}</b><span>meetings in total</span></div><div><b>${fmtNum(o.top)}</b><span>with Commissioners or cabinets</span></div>
        <div><b>${fmtNum(o.dg)}</b><span>with senior staff</span></div></div>`;
      if (o.last) html += `<p class="n" style="margin:6px 0 0">Latest published meeting: ${fmtDate(new Date(o.last + 'T12:00:00'))}</p>`;
      if (rec.length) html += `<h4>Latest meetings <span class="n">newest first</span></h4>${meetingRows(rec)}`;
      else if (!meetData) html += `<p class="n">Loading meetings…</p>`;
      if (detail?.who?.length) html += `<h4>Who they meet most <span class="n">tap to see who else meets them</span></h4>${rankRows(detail.who, { attr: 'data-office' })}`;
      const secs = Object.entries(o.secN || {}).sort((a, b) => b[1] - a[1]);
      if (secs.length) html += `<h4>By policy area</h4>${rankRows(secs, { label: k => P.sectors[k].label })}`;
    } else html += `<p class="n">No published meetings with the Commission's top level since ${fmtDate(t0)}.</p>`;
    html += `</section>`;
    // 2. Upcoming events from the agenda
    const up = agenda?.events.filter(e => e.place === p.id).slice(0, 4) || [];
    if (up.length) html += `<h4 class="sec-h">Upcoming events</h4><ul class="meets">${up.map(e => `<li><span class="n">${fmtDate(new Date(e.date + 'T12:00:00'))}${e.start ? ', ' + e.start : ''}, ${esc(e.format.toLowerCase())}</span><br><a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.title)}</a></li>`).join('')}</ul>`;
    // 3. How the influence score is built
    const row = (label, raw, part) => `<li><span>${label}</span><b>${raw}</b><span class="bar"><i style="width:${part ?? 0}%"></i></span></li>`;
    html += `<h4 class="sec-h">Influence index ${o.inf} of 100, built from</h4><ul class="metrics">
      ${row('Meetings with Commissioners and cabinets', fmtNum(o.top), detail?.parts?.top)}
      ${row('Meetings with senior Commission staff', fmtNum(o.dg), detail?.parts?.dg)}
      ${row('Declared lobbying costs', fmtSpend(o.spend) || (detail?.budget ? 'Budget ' + fmtSpend([detail.budget, detail.budget]) : 'Not declared'), detail?.parts?.spend)}
      ${row('Lobbyists, full-time', o.fte, detail?.parts?.fte)}
      ${row('Parliament badges', o.ep, detail?.parts?.ep)}</ul>`;
  }
  if (deferFacts && factsHtml) html += `<h4 class="sec-h">The building</h4>${factsHtml}`;
  if (others.length) {
    const all = [p, ...others].sort((a, b) => (b.power ?? -1) - (a.power ?? -1));
    html += `<h4>${all.length} organisations in this building</h4><ol class="occupants${all.length > 8 ? ' folded' : ''}">${all.map(q => `<li class="${q === p ? 'on' : ''}"><button data-other="${esc(q.id)}">
      <span class="sw" style="background:${CATS[q.c].color}"></span><span class="nm">${esc(q.n)}</span><b>${q.power != null ? Math.round(q.power) : ''}</b></button></li>`).join('')}</ol>
      ${all.length > 8 ? `<button class="show-all">Show all ${all.length}</button>` : ''}`;
  }
  html += `<div id="wiki"></div>`;
  const links = [];
  if (inv?.url) links.push(`<a href="${esc(inv.url)}" target="_blank" rel="noopener">Heritage record</a>`);
  if (p?.org) links.push(`<a href="https://transparency-register.europa.eu/searchregister-or-update/organisation-detail_en?id=${encodeURIComponent(p.org.id)}" target="_blank" rel="noopener">Transparency Register</a>`);
  if (p?.org?.web) links.push(`<a href="${esc(/^https?:/.test(p.org.web) ? p.org.web : 'https://' + p.org.web)}" target="_blank" rel="noopener">Website</a>`);
  if (wd?.wiki) links.push(`<a href="https://en.wikipedia.org/wiki/${esc(wd.wiki)}" target="_blank" rel="noopener">Wikipedia</a>`);
  const ll = latLngOf(gid, p);
  if (ll) links.push(`<a href="https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${ll[0].toFixed(6)},${ll[1].toFixed(6)}" target="_blank" rel="noopener">Street View</a>`);
  if (wd?.qid) links.push(`<a href="https://www.wikidata.org/wiki/${esc(wd.qid)}" target="_blank" rel="noopener">Wikidata</a>`);
  return html + `<div class="links">${links.join('')}</div></div>`;
}
function placeCard(x, y) {
  if (phone.matches && card.classList.contains('pinned')) return;
  const r = card.getBoundingClientRect();
  card.style.left = Math.max(12, Math.min(x + 18, innerWidth - r.width - 12)) + 'px';
  card.style.top = Math.max(12, Math.min(y + 18, innerHeight - r.height - 12)) + 'px';
}
function renderHover(gid) {
  card.innerHTML = cardHtml(gid, false);
  card.querySelector('img')?.addEventListener('load', () => pointer && placeCard(...pointer));
}
function showCard(gid, x, y) {
  if (pinnedGid >= 0 || phone.matches) return;
  if (gid < 0) { card.hidden = true; hoverGid = -1; return; }
  if (gid !== hoverGid || card.hidden) {
    hoverGid = gid;
    renderHover(gid);
    card.classList.remove('pinned');
    card.hidden = false;
    if (!infoNow(gid)) infoFor(gid).then(() => { if (hoverGid === gid && pinnedGid < 0) { renderHover(gid); if (pointer) placeCard(...pointer); } });
  }
  placeCard(x, y);
}
const wikiCache = {};
async function loadWiki(title) {
  try {
    wikiCache[title] ||= await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`).then(r => r.ok ? r.json() : null);
    const d = wikiCache[title], box = card.querySelector('#wiki');
    if (d?.extract && box) box.innerHTML = `<h4>From Wikipedia</h4><p class="wiki">${esc(d.extract)}</p>`;
  } catch {}
}
function pinCard(gid, x, y, placeId) {
  pinnedGid = gid; hoverGid = -1;
  uniforms.uSelected.value = gid;
  uniforms.uHover.value = -1;
  if (gid < 0) { card.hidden = true; card.classList.remove('pinned'); history.replaceState(null, '', location.pathname); return; }
  const draw = () => {
    if (pinnedGid !== gid) return;
    card.innerHTML = cardHtml(gid, true, placeId);
    card.classList.add('pinned');
    card.hidden = false;
    const p = placesIn(gid).find(q => q.id === placeId) || placesIn(gid)[0];
    const f = infoNow(gid);
    cardPlace = p?.id || null;
    history.replaceState(null, '', p ? `#place=${encodeURIComponent(p.id)}` : `#building=${gid}`);
    const wiki = p?.w || f?.wd?.wiki;
    if (wiki) loadWiki(decodeURIComponent(wiki));
    card.querySelector('.card-close').onclick = () => pinCard(-1);
    card.querySelectorAll('[data-other]').forEach(b => b.onclick = () => pinCard(gid, x, y, b.dataset.other));
    card.querySelectorAll('[data-office]').forEach(b => b.onclick = () => showOffice(b.dataset.office));
    card.querySelectorAll('.show-all').forEach(btn => btn.addEventListener('click', ev => { ev.target.previousElementSibling?.classList.remove('folded'); ev.target.remove(); }));
    card.querySelector('img')?.addEventListener('load', () => placeCard(x, y));
    placeCard(x, y);
  };
  draw();
  card.scrollTop = 0;
  if (!infoNow(gid)) infoFor(gid).then(draw);
  if (!meetData && placesIn(gid).some(q => q.org)) getMeet().then(draw);
  if (!agenda) getAgenda().then(draw);
  if (phone.matches) setCollapsed(true);
}
addEventListener('keydown', e => { if (e.key === 'Escape') { pinCard(-1); } });
function focusPlace(id) {
  const p = byId[id]; if (!p || p.gid == null) return;
  const b = city.buildingPos[p.gid];
  pinnedGid = p.gid;
  flyTo(b[0], b[1], 950 + (b[2] || 20) * 6, () => pinCard(p.gid, innerWidth - 400, 110, id));
  pinCard(p.gid, innerWidth - 400, 110, id);
}
function focusGid(gid) {
  const c = city.culture.find(q => q.gid === gid); if (!c) return;
  pinnedGid = gid;
  flyTo(c.x, c.z, 800 + (c.h || 15) * 6, () => pinCard(gid, innerWidth - 400, 110));
  pinCard(gid, innerWidth - 400, 110);
}

// Hover and click on the model
let pointer = null, downAt = null;
canvas.addEventListener('pointermove', e => { pointer = [e.clientX, e.clientY]; });
canvas.addEventListener('pointerdown', e => { downAt = [e.clientX, e.clientY]; if (pinnedGid < 0) card.hidden = true; });
canvas.addEventListener('pointerup', e => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) return;
  const gid = pick(e.clientX, e.clientY);
  pinCard(gid === pinnedGid ? -1 : gid, e.clientX, e.clientY);
});
canvas.addEventListener('pointerleave', () => { pointer = null; if (pinnedGid < 0) { card.hidden = true; uniforms.uHover.value = -1; } });

// ---------- Tally ----------
function updateTally() {
  if (uniforms.uTL.value > 0.5) {
    $('#tally-big').textContent = fmtDate(weekDate(week));
    $('#tally-small').textContent = `${fmtNum(totalCum[week])} lobby meetings so far this term`;
  } else {
    $('#tally-big').textContent = fmtNum(city.buildings);
    $('#tally-small').textContent = `buildings, ${places.length} with power mapped`;
  }
}

// ---------- Timeline ----------
const hist = $('#hist'), hctx = hist.getContext('2d');
let playing = false, playT0 = 0, playFrom = 0;
const PLAY_MS = 24000;
$('#axis-from').textContent = fmtDate(t0);
$('#axis-to').textContent = fmtDate(new Date(P.meetingsTo + 'T00:00:00'));
// Filter: all meetings, one type of lobby, or one policy area
const TYPE_KEYS = ['corp', 'assoc', 'consult', 'union', 'ngo', 'think', 'public'];
const tlSel = $('#tl-filter');
tlSel.innerHTML = `<option value="all">all</option><optgroup label="By type of lobby">${TYPE_KEYS.map(k => `<option value="t:${k}">${esc(CATS[k].label)}</option>`).join('')}</optgroup>
  <optgroup label="By policy area">${Object.entries(P.sectors).map(([k, v]) => `<option value="s:${k}">${esc(v.label)}</option>`).join('')}</optgroup>`;
let tlFilter = 'all';
const seriesAt = i => tlFilter === 'all' ? P.weekly[i] : (P.weeks[i]?.[tlFilter[0]]?.[tlFilter.slice(2)] || 0);
const filterColor = () => tlFilter.startsWith('t:') ? CATS[tlFilter.slice(2)].color : BLUE;
tlSel.addEventListener('change', () => { tlFilter = tlSel.value; drawHist(); if (!$('#week').hidden) openWeek(week); });
function drawHist() {
  const dpr = Math.min(devicePixelRatio, 2), w = hist.clientWidth, h = hist.clientHeight;
  if (hist.width !== w * dpr) { hist.width = w * dpr; hist.height = h * dpr; }
  hctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  hctx.clearRect(0, 0, w, h);
  const vals = Array.from({ length: N_WEEKS }, (_, i) => seriesAt(i)), max = Math.max(1, ...vals), bw = w / N_WEEKS, col = filterColor();
  for (let i = 0; i < N_WEEKS; i++) {
    const bh = Math.max(1, (h - 8) * vals[i] / max);
    hctx.fillStyle = i === openWeekIdx ? IRIS : i <= week ? col : '#c3cad4';
    hctx.fillRect(i * bw + 0.5, h - bh, Math.max(1, bw - 1), bh);
  }
  const x = (week + 0.5) * bw;
  hctx.fillStyle = '#0e1a2b';
  hctx.fillRect(x - 1, 0, 2, h);
  hctx.beginPath(); hctx.arc(x, 4, 4, 0, Math.PI * 2); hctx.fill();
}
let scrubbing = false, downX = 0, moved = false, openWeekIdx = -1;
const weekAt = x => Math.max(0, Math.min(N_WEEKS - 1, Math.floor(x / hist.clientWidth * N_WEEKS)));
hist.addEventListener('pointerdown', e => { scrubbing = true; moved = false; downX = e.offsetX; stopPlay(); hist.setPointerCapture(e.pointerId); week = weekAt(e.offsetX); applyWeek(); });
hist.addEventListener('pointermove', e => {
  if (scrubbing) { if (Math.abs(e.offsetX - downX) > 4) moved = true; week = weekAt(e.offsetX); applyWeek(); }
  else hist.title = (i => `Week of ${fmtDate(weekDate(i))}: ${seriesAt(i)} meetings. Click for details.`)(weekAt(e.offsetX));
});
hist.addEventListener('pointerup', () => { scrubbing = false; if (!moved) openWeek(week); });

// Week details: what happened in the selected week
const weekEl = $('#week');
function bars(obj, label, color) {
  const rows = Object.entries(obj || {}).sort((a, b) => b[1] - a[1]).slice(0, 6);
  if (!rows.length) return '';
  const max = rows[0][1];
  return `<h4>${label}</h4><ul class="wbars">${rows.map(([k, n]) => `<li><span>${esc(label.includes('type') ? CATS[k]?.label || k : P.sectors[k]?.label || k)}</span><b>${n}</b>
    <span class="bar"><i style="width:${100 * n / max}%;background:${label.includes('type') ? CATS[k]?.color || BLUE : BLUE}"></i></span></li>`).join('')}</ul>`;
}
function openWeek(i) {
  const W = P.weeks[i]; if (!W) return;
  openWeekIdx = i; drawHist();
  const from = weekDate(i), to = new Date(from.getTime() + 6 * 864e5);
  const filt = tlFilter === 'all' ? '' : ` <span class="n">(${seriesAt(i)} ${esc(tlSel.selectedOptions[0].text.toLowerCase())})</span>`;
  const busiest = W.o[0];
  const agendaByDay = new Map();
  for (const x of [...W.x].sort((p, q) => p[0].localeCompare(q[0]))) { if (!agendaByDay.has(x[0])) agendaByDay.set(x[0], []); agendaByDay.get(x[0]).push(x); }
  const types = Object.entries(W.t).sort((a, b) => b[1] - a[1]);
  weekEl.innerHTML = `<button class="card-close on-dark" aria-label="Close">×</button>
    <header class="wk-head">
      <p class="wk-eyebrow">Week of ${fmtDate(from)} to ${fmtDate(to)}</p>
      <h3>${fmtNum(P.weekly[i])} lobby meetings${filt}</h3>
      <div class="wk-tiles">
        ${busiest ? `<div><span>Most active</span><b>${esc(prettyName(busiest[0]))}</b><em>${busiest[1]} meetings</em></div>` : ''}
        ${W.c[0] ? `<div><span>Busiest office</span><b>${esc(W.c[0][0])}</b><em>${W.c[0][1]} meetings</em></div>` : ''}
        ${types[0] ? `<div><span>Most common lobby</span><b>${esc(CATS[types[0][0]]?.label || types[0][0])}</b><em>${types[0][1]} meetings</em></div>` : ''}
      </div>
    </header>
    <div class="wk-body">
      <div class="wcols">
        <section><h4>Most active organisations</h4>${rankRows(W.o.map(([n, c, pid]) => [pid && byId[pid]?.gid != null ? pid : '~' + n, c]), { attr: 'data-place', label: k => k.startsWith('~') ? prettyName(k.slice(1)) : byId[k].n })}</section>
        <section><h4>Commission offices <span class="n">tap one to see who meets it</span></h4>${rankRows(W.c, { attr: 'data-office', color: '#c2255c' })}</section>
      </div>
      <h4>By type of lobby</h4>${countChips(types.slice(0, 7), { label: k => CATS[k]?.label || k, color: k => CATS[k]?.color || BLUE })}
      <h4>By policy area</h4>${countChips(Object.entries(W.s).sort((a, b) => b[1] - a[1]).slice(0, 8), { label: k => P.sectors[k]?.label || k })}
      ${agendaByDay.size ? `<h4>On the agenda <span class="n">a sample of the week's meetings</span></h4>${[...agendaByDay].map(([d, xs]) => `<div class="wday">${fmtDate(new Date(d + 'T12:00:00'))}</div>${meetingRows(xs.map(([dd, org, who, t]) => [dd, who, t, org]), { limit: 99, showOrg: true })}`).join('')}` : ''}
    </div>`;
  weekEl.hidden = false;
  weekEl.scrollTop = 0;
}
weekEl.addEventListener('click', e => {
  if (e.target.closest('.card-close')) { weekEl.hidden = true; openWeekIdx = -1; drawHist(); return; }
  const o = e.target.closest('[data-office]'); if (o) { weekEl.hidden = true; openWeekIdx = -1; drawHist(); showOffice(o.dataset.office); return; }
  const p = e.target.closest('[data-place]'); if (p && !p.dataset.place.startsWith('~')) { weekEl.hidden = true; openWeekIdx = -1; drawHist(); focusPlace(p.dataset.place); }
});
$('#play').addEventListener('click', () => playing ? stopPlay() : startPlay());
function startPlay() {
  playing = true; playFrom = week >= N_WEEKS - 1 ? 0 : week; playT0 = performance.now();
  $('#play-icon').setAttribute('d', 'M4 2.5h3v11H4zM9 2.5h3v11H9z');
  if (mode >= 2) setMode(0);
}
function stopPlay() { playing = false; $('#play-icon').setAttribute('d', 'M4 2.5v11l9-5.5z'); applyWeek(); }
function stepPlay(t) {
  if (!playing) return;
  const w = Math.min(N_WEEKS - 1, playFrom + Math.floor((t - playT0) / PLAY_MS * N_WEEKS));
  if (w !== week) { week = w; applyWeek(); }
  if (w >= N_WEEKS - 1) stopPlay();
}

// ---------- Routes ----------
const routesDlg = $('#routes'), routeEl = $('#route');
const stories = P.stories.map(s => ({ ...s, steps: s.steps.filter(st => byId[st.p]?.gid != null) })).filter(s => s.steps.length > 1);
let route = null, rstep = 0;
$('.routes-open').addEventListener('click', () => {
  $('#routes-body').innerHTML = `<h2 id="routes-title">Routes</h2><p>Guided walks through the buildings where EU decisions are made and lobbied.</p>` +
    stories.map(s => `<button class="route-card" data-route="${s.id}"><b>${esc(s.title)}</b><span>${esc(s.intro)}</span></button>`).join('');
  routesDlg.showModal();
});
$('#routes-body').addEventListener('click', e => { const b = e.target.closest('[data-route]'); if (b) { routesDlg.close(); startRoute(b.dataset.route); } });
function startRoute(id) { route = stories.find(s => s.id === id); if (!route) return; rstep = 0; history.replaceState(null, '', `#route=${id}`); renderRoute(); }
function renderRoute() {
  if (!route) { routeEl.hidden = true; return; }
  const st = route.steps[rstep], p = byId[st.p];
  routeEl.innerHTML = `<div class="step-n">${esc(route.title)}, step ${rstep + 1} of ${route.steps.length}</div>
    <h2>${esc(p.n)}</h2><p>${esc(st.t)}</p>
    <div class="nav"><button data-r="prev" ${rstep === 0 ? 'disabled' : ''}>Previous</button>
    <button data-r="next" class="primary" ${rstep === route.steps.length - 1 ? 'disabled' : ''}>Next</button>
    <button data-r="end" class="end">End route</button></div>`;
  routeEl.hidden = false;
  const b = city.buildingPos[p.gid];
  pinCard(-1);
  uniforms.uSelected.value = p.gid;
  flyTo(b[0], b[1], 950 + (b[2] || 20) * 6);
}
routeEl.addEventListener('click', e => {
  const a = e.target.closest('[data-r]')?.dataset.r;
  if (a === 'prev') { rstep--; renderRoute(); }
  if (a === 'next') { rstep++; renderRoute(); }
  if (a === 'end') { route = null; renderRoute(); uniforms.uSelected.value = -1; history.replaceState(null, '', location.pathname); }
});

// ---------- About ----------
const aboutDlg = $('#about');
$('.about-open').addEventListener('click', () => { renderAbout(); aboutDlg.showModal(); });
for (const d of [aboutDlg, routesDlg]) {
  d.querySelector('.sheet-close').addEventListener('click', () => d.close());
  d.addEventListener('click', e => { if (e.target === d) d.close(); });
}
function renderAbout() {
  const W = P.weights, reps = [...P.reps].sort((a, b) => b.power - a.power);
  $('#about-body').innerHTML = `
    <h2 id="about-title">How power is scored</h2>
    <p>All ${fmtNum(city.buildings)} buildings of the Brussels-Capital Region, and the ${places.length} institutions, member-state missions and organisations inside them that have a say over EU decisions. Every one gets a power score from 0 to 100, measured three ways.</p>
    <h3>Institutions: formal authority</h3>
    <p>An editorial rating of each institution's legal powers: the right to propose laws, to adopt or block them, to control the budget, to enforce. The reasoning is on each building's card.</p>
    <h3>Member states: Council voting weight</h3>
    <p>Each permanent representation scores 55 for its seat in COREPER and its veto on unanimity files, plus up to 30 in proportion to its share of the EU population, its weight under qualified majority voting. Eurostat, ${esc(P.popYear)}.</p>
    <table><tbody>${reps.slice(0, 4).map(r => `<tr><td>${esc(r.n.replace('Permanent Representation of ', ''))}</td><td>${r.share}%</td><td>${r.power}</td></tr>`).join('')}</tbody></table>
    <h3>Outside interests: measured influence</h3>
    <p>All ${fmtNum(P.registrants)} organisations in the EU Transparency Register with a Brussels office get an influence index from: meetings with Commissioners and cabinets since ${fmtDate(t0)} (${Math.round(W.top * 100)}%), meetings with senior Commission staff (${Math.round(W.dg * 100)}%), declared lobbying costs (${Math.round(W.spend * 100)}%), full-time lobbyists (${Math.round(W.fte * 100)}%) and Parliament badges (${Math.round(W.ep * 100)}%). Each is compared with the most active organisation on a square-root scale. NGOs report a budget rather than lobbying costs and are scored on the other four. The index is scaled so the strongest outside interest reaches ${P.lobbyCeiling}: a lobby cannot adopt a law. All ${fmtNum(P.orgCount)} whose address could be located are mapped; where several share a building, it takes the colour of the most powerful.</p>
    <h3>Heritage and culture</h3>
    <p>Construction dates come from the heritage inventory where it records one, otherwise from Wikidata. The inventory focuses on buildings of heritage interest, so recent and ordinary buildings are mostly undated. Cultural places (museums, theatres, churches, palaces and the like) are shown for context and carry no power score.</p>
    <h3>The timeline</h3>
    <p>Bars show published lobby meetings with the Commission each week of the current term. Play it, and each lobby's building grows with the meetings it has had so far.</p>
    <h3>What this does not capture</h3>
    <p>Published meetings cover Commissioners, cabinets and senior management only; contacts with junior officials, MEPs and national governments are missing, and lobbying costs are self-declared. Access and money measure effort, not success.</p>
    <h3>Data</h3>
    <ul>
      <li>Buildings and heights: UrbIS 3D Constructions, paradigm.brussels.</li>
      <li>Construction years, architects, styles and building photos: the Brussels heritage inventory (Inventaire du patrimoine architectural / Irismonument) and protected heritage register, urban.brussels. Photos are shown from urban.brussels' own server and link to their records.</li>
      <li>Cultural places, names and photos: Wikidata and Wikimedia Commons; each photo credits its author and licence.</li>
      <li>Water, parks and woods: OpenStreetMap contributors, ODbL.</li>
      <li>Lobbying: EU Transparency Register, export of ${fmtDate(new Date(P.registerDate + 'T00:00:00'))}; European Commission meetings with interest representatives, to ${fmtDate(new Date(P.meetingsTo + 'T00:00:00'))}.</li>
      <li>Population: Eurostat. Addresses: UrbIS geocoder. Summaries: Wikipedia.</li>
    </ul>
    <h3>Credits</h3>
    <p>The way the city is drawn, as binary tiles extruded in the browser with buildings dropping in as they load, is adapted from Alex Barakov's <a href="https://stop-token.com/lab/amsterdam/" target="_blank" rel="noopener">Amsterdam, building by building</a> (MIT licence), itself inspired by Sasha Bogachev's <a href="https://paris.bogachev.fr" target="_blank" rel="noopener">Paris, building by building</a>. Rendered with three.js.</p>
    <p>Data built ${fmtDate(new Date(P.built + 'T00:00:00'))}.</p>`;
}

// ---------- Boot ----------
const now = () => performance.now() / 1000;
let periodCounts = null;
function cityReady() {
  $('#loading').hidden = true;
  periodCounts = PERIODS.map(() => 0);
  for (const t of tileData) for (let i = 7; i < t.data.length; i += 8) if (t.data[i] > 0) periodCounts[periodOf(t.data[i])]++;
  if (mode === 3) renderPanel();
  uniforms.uLayerAt.value = now() + 0.4;
  const v = homeView();
  flight = { t0: performance.now(), dur: reduced ? 1 : 2600, from: { t: controls.target.clone(), p: camera.position.clone() }, to: { t: v.target, p: v.pos } };
  applyWeek();
  const [k, val] = decodeURIComponent(location.hash.slice(1)).split('=');
  if (k === 'place' && byId[val]) setTimeout(() => focusPlace(val), 2700);
  if (k === 'route') setTimeout(() => startRoute(val), 2700);
  if (k === 'building' && city.culture.some(c => c.gid === +val)) setTimeout(() => focusGid(+val), 2700);
}
function resize() {
  const w = innerWidth, h = innerHeight;
  if (!phone.matches) $('#panel').style.top = Math.round($('.masthead').getBoundingClientRect().bottom + 16) + 'px';
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  drawHist();
}
addEventListener('resize', resize);
resize();
renderPanel();
updateTally();
if (phone.matches) setCollapsed(true);

let lastPick = 0;
renderer.setAnimationLoop(t => {
  uniforms.uNow.value = t / 1000;
  stepFlight(t);
  stepPlay(t);
  controls.update();
  if (pointer && !flight && pinnedGid < 0 && t - lastPick > 40 && meshes.length) {
    lastPick = t;
    const g = pick(pointer[0], pointer[1]);
    uniforms.uHover.value = g;
    showCard(g, pointer[0], pointer[1]);
  }
  renderer.render(scene, camera);
});
