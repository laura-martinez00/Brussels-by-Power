// Brussels, by power. Rendering approach (binary tiles extruded in workers, one attribute texture per
// tile, GPU picking, the drop-in entrance) adapted from alexbarakov/amsterdam-by-building (MIT).
import * as THREE from './vendor/three.module.js';
import { MapControls } from './vendor/MapControls.js';

THREE.ColorManagement.enabled = false;

const SKY = '#e5e8ed', LAND = '#f4f3ef', WATER = '#b7c7d4', GREEN = '#e1e7d8', MAQUETTE = '#f0efea';
const BLUE = '#1c3f94', IRIS = '#f2c200';
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
  uLayerAt: { value: 0 }, uTL: { value: 0 },
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
  uniform vec3 uMaquette, uBlue, uIris;
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

    vec3 c = uMaquette;
    bool rise = false;
    if (uMode < 0.5) {
      if (power >= 0.0 && uCatOn[cat] > 0.5) { c = mix(uMaquette, uCat[cat], 0.3 + 0.7 * power / 100.0); rise = true; }
    } else if (uMode < 1.5) {
      if (b.y > 0.0) { c = mix(vec3(0.80, 0.85, 0.93), uBlue, b.y / 100.0); rise = true; }
    } else {
      c = heightRamp(a.z);
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
  tileData.push({ data, tex });
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
  if (!phone.matches && pinnedGid >= 0) target.add(new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize().multiplyScalar(distance * 0.16));
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
function applySector() {
  for (const gid of placedGids) {
    let s = 0;
    for (const p of placesIn(gid)) s = Math.max(s, p.sec?.[sector] || 0);
    setAttr(gid, 5, s);
  }
  flushAttr();
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
  return `<ol class="rank">${list.map((p, i) => `<li><button data-place="${esc(p.id)}">
    <span class="pos">${i + 1}</span>
    <span class="nm"><b title="${esc(p.n)}">${esc(p.n)}</b><span class="bar"><i style="width:${val(p)}%;background:${color || CATS[p.c].color}"></i></span></span>
    <span class="val">${Math.round(val(p))}</span></button></li>`).join('')}</ol>`;
}
function renderPanel() {
  if (mode === 0) {
    const counts = {}; for (const p of places) counts[p.c] = (counts[p.c] || 0) + 1;
    panelBody.innerHTML = `
      <h2>Who has power</h2>
      <p class="hint">Coloured buildings hold an EU institution, a member state's mission or one of the ${fmtNum(P.orgs.length)} most influential registered lobbies. The stronger the colour, the higher the power score.</p>
      <ul class="legend">${CAT_KEYS.map((k, i) => counts[k] ? `<li><button data-cat="${i}" aria-pressed="${!!catOn[i]}">
        <span class="sw" style="background:${CATS[k].color}"></span><span>${esc(CATS[k].label)}</span><span class="n">${counts[k]}</span></button></li>` : '').join('')}</ul>
      <h2 class="section">Most powerful</h2>
      ${rankHtml(ranked(), p => p.power)}`;
  } else if (mode === 1) {
    const s = P.sectors[sector];
    const list = places.filter(p => p.sec?.[sector]).sort((a, b) => b.sec[sector] - a.sec[sector]).slice(0, 30);
    panelBody.innerHTML = `
      <h2>Commission access by policy area</h2>
      <div class="sectors">${sectorKeys.map(k => `<button data-sector="${k}" aria-pressed="${k === sector}">${esc(P.sectors[k].label)}</button>`).join('')}</div>
      <p class="hint">Meetings since ${fmtDate(t0)} with ${esc(s.dgs.map(d => 'DG ' + d).join(', '))} and the cabinet${s.cabs.length > 1 ? 's' : ''} of ${esc(s.cabs.join(' and '))}. Darker blue, more access.</p>
      ${rankHtml(list, p => p.sec[sector], BLUE)}`;
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
  const s = e.target.closest('[data-sector]');
  if (s) { sector = s.dataset.sector; applySector(); uniforms.uLayerAt.value = now(); renderPanel(); return; }
  const p = e.target.closest('[data-place]');
  if (p) focusPlace(p.dataset.place);
});
panelBody.addEventListener('pointerover', e => {
  const p = e.target.closest('[data-place]');
  if (p && pinnedGid < 0) uniforms.uHover.value = byId[p.dataset.place]?.gid ?? -1;
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
  uniforms.uMode.value = m;
  uniforms.uLayerAt.value = now();
  document.querySelectorAll('.modes [data-mode]').forEach(b => b.setAttribute('aria-pressed', String(+b.dataset.mode === m)));
  if (m === 1) applySector();
  renderPanel();
}

// ---------- Cards ----------
const card = $('#card');
let pinnedGid = -1, hoverGid = -1, cardPlace = null;
const basisLabel = { formal: 'Formal authority', council: 'Council voting weight', influence: 'Measured influence' };
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
  return `<div class="score"><b>${Math.round(p.power)}</b><span>${sub}</span></div>`;
}
function cardHtml(gid, pinned, placeId) {
  const ps = placesIn(gid);
  const h = heightOf(gid);
  if (!ps.length) return `<div class="kind">A building of the city</div><h3>About ${Math.round(h || 0)} m tall</h3>
    <div class="addr">No mapped institution or registered organisation here</div>`;
  const p = (placeId && ps.find(q => q.id === placeId)) || ps[0];
  const others = ps.filter(q => q !== p);
  const head = `${pinned ? '<button class="card-close" aria-label="Close">×</button>' : ''}
    <div class="kind"><span class="sw" style="background:${CATS[p.c].color}"></span>${esc(CATS[p.c].label)}</div>
    <h3>${esc(p.n)}</h3><div class="addr">${esc(p.a)}</div>${scoreHtml(p)}`;
  if (!pinned) return head + (others.length ? `<p class="more">and ${others.length} more in this building. Click for details.</p>` : `<p class="more">Click for details.</p>`);
  let body = '';
  if (p.d) body += `<p>${esc(p.d)}</p>`;
  if (p.why) body += `<p class="why">${esc(p.why)}</p>`;
  if (p.org) {
    const o = p.org, W = P.weights;
    const row = (label, raw, part, w) => `<li><span>${label}</span><b>${raw}</b><span class="bar"><i style="width:${part ?? 0}%"></i></span></li>`;
    body += `<h4>Influence index ${o.inf} of 100, built from</h4><ul class="metrics">
      ${row('Meetings with Commissioners and cabinets', fmtNum(o.top), o.parts.top, W.top)}
      ${row('Meetings with senior Commission staff', fmtNum(o.dg), o.parts.dg, W.dg)}
      ${row('Declared lobbying costs', fmtSpend(o.spend) || (o.budget ? 'Budget ' + fmtSpend([o.budget, o.budget]) : 'Not declared'), o.parts.spend, W.spend)}
      ${row('Lobbyists, full-time', o.fte, o.parts.fte, W.fte)}
      ${row('Parliament badges', o.ep, o.parts.ep, W.ep)}</ul>`;
    if (o.who?.length) body += `<h4>Most met</h4><p style="margin:0">${o.who.map(([w, n]) => `${esc(w)} (${n})`).join(', ')}</p>`;
    const secs = Object.entries(o.secN || {}).sort((a, b) => b[1] - a[1]);
    if (secs.length) body += `<h4>Meetings by policy area</h4><div class="chips">${secs.map(([k, n]) => `<span>${esc(P.sectors[k].label)} ${n}</span>`).join('')}</div>`;
  }
  if (others.length) body += `<div class="others">Also in this building: ${others.map(q => `<button data-other="${esc(q.id)}">${esc(q.n)}</button>`).join(', ')}</div>`;
  body += `<div id="wiki"></div>`;
  const links = [];
  if (p.org) links.push(`<a href="https://transparency-register.europa.eu/searchregister-or-update/organisation-detail_en?id=${encodeURIComponent(p.org.id)}" target="_blank" rel="noopener">Transparency Register</a>`);
  if (p.org?.web) links.push(`<a href="${esc(/^https?:/.test(p.org.web) ? p.org.web : 'https://' + p.org.web)}" target="_blank" rel="noopener">Website</a>`);
  links.push(`<a href="https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lng}#map=19/${p.lat}/${p.lng}" target="_blank" rel="noopener">Map</a>`);
  return head + body + `<div class="links">${links.join('')}</div>`;
}
function placeCard(x, y) {
  if (phone.matches && card.classList.contains('pinned')) return;
  const r = card.getBoundingClientRect();
  card.style.left = Math.max(12, Math.min(x + 18, innerWidth - r.width - 12)) + 'px';
  card.style.top = Math.max(12, Math.min(y + 18, innerHeight - r.height - 12)) + 'px';
}
function showCard(gid, x, y) {
  if (pinnedGid >= 0 || phone.matches) return;
  if (gid < 0) { card.hidden = true; hoverGid = -1; return; }
  if (gid !== hoverGid || card.hidden) {
    hoverGid = gid;
    card.innerHTML = cardHtml(gid, false);
    card.classList.remove('pinned');
    card.hidden = false;
  }
  placeCard(x, y);
}
const wikiCache = {};
async function loadWiki(title) {
  try {
    wikiCache[title] ||= await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`).then(r => r.ok ? r.json() : null);
    const d = wikiCache[title], box = card.querySelector('#wiki');
    if (d?.extract && box) box.innerHTML = `<h4>From Wikipedia</h4><p class="wiki">${esc(d.extract)} <a href="${esc(d.content_urls?.desktop?.page || '#')}" target="_blank" rel="noopener">Read more</a></p>`;
  } catch {}
}
function pinCard(gid, x, y, placeId) {
  pinnedGid = gid; hoverGid = -1;
  uniforms.uSelected.value = gid;
  uniforms.uHover.value = -1;
  if (gid < 0) { card.hidden = true; card.classList.remove('pinned'); history.replaceState(null, '', location.pathname); return; }
  card.innerHTML = cardHtml(gid, true, placeId);
  card.classList.add('pinned');
  card.hidden = false;
  card.scrollTop = 0;
  const p = placesIn(gid).find(q => q.id === placeId) || placesIn(gid)[0];
  cardPlace = p?.id || null;
  if (p) history.replaceState(null, '', `#place=${encodeURIComponent(p.id)}`);
  if (p?.w) loadWiki(p.w);
  card.querySelector('.card-close').onclick = () => pinCard(-1);
  card.querySelectorAll('[data-other]').forEach(b => b.onclick = () => pinCard(gid, x, y, b.dataset.other));
  if (phone.matches) setCollapsed(true);
  placeCard(x, y);
}
addEventListener('keydown', e => { if (e.key === 'Escape') { pinCard(-1); } });
function focusPlace(id) {
  const p = byId[id]; if (!p || p.gid == null) return;
  const b = city.buildingPos[p.gid];
  pinnedGid = p.gid;
  flyTo(b[0], b[1], 950 + (b[2] || 20) * 6, () => pinCard(p.gid, innerWidth - 400, 110, id));
  pinCard(p.gid, innerWidth - 400, 110, id);
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
function drawHist() {
  const dpr = Math.min(devicePixelRatio, 2), w = hist.clientWidth, h = hist.clientHeight;
  if (hist.width !== w * dpr) { hist.width = w * dpr; hist.height = h * dpr; }
  hctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  hctx.clearRect(0, 0, w, h);
  const max = Math.max(...P.weekly), bw = w / N_WEEKS;
  for (let i = 0; i < N_WEEKS; i++) {
    const bh = Math.max(1, (h - 8) * P.weekly[i] / max);
    hctx.fillStyle = i <= week ? BLUE : '#c3cad4';
    hctx.fillRect(i * bw + 0.5, h - bh, Math.max(1, bw - 1), bh);
  }
  const x = (week + 0.5) * bw;
  hctx.fillStyle = '#0e1a2b';
  hctx.fillRect(x - 1, 0, 2, h);
  hctx.beginPath(); hctx.arc(x, 4, 4, 0, Math.PI * 2); hctx.fill();
}
let scrubbing = false;
const weekAt = x => Math.max(0, Math.min(N_WEEKS - 1, Math.floor(x / hist.clientWidth * N_WEEKS)));
hist.addEventListener('pointerdown', e => { scrubbing = true; stopPlay(); hist.setPointerCapture(e.pointerId); week = weekAt(e.offsetX); applyWeek(); });
hist.addEventListener('pointermove', e => { if (scrubbing) { week = weekAt(e.offsetX); applyWeek(); } });
hist.addEventListener('pointerup', () => { scrubbing = false; });
$('#play').addEventListener('click', () => playing ? stopPlay() : startPlay());
function startPlay() {
  playing = true; playFrom = week >= N_WEEKS - 1 ? 0 : week; playT0 = performance.now();
  $('#play-icon').setAttribute('d', 'M4 2.5h3v11H4zM9 2.5h3v11H9z');
  if (mode === 2) setMode(0);
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
    <p>All ${fmtNum(P.registrants)} organisations in the EU Transparency Register with a Brussels office get an influence index from: meetings with Commissioners and cabinets since ${fmtDate(t0)} (${Math.round(W.top * 100)}%), meetings with senior Commission staff (${Math.round(W.dg * 100)}%), declared lobbying costs (${Math.round(W.spend * 100)}%), full-time lobbyists (${Math.round(W.fte * 100)}%) and Parliament badges (${Math.round(W.ep * 100)}%). Each is compared with the most active organisation on a square-root scale. NGOs report a budget rather than lobbying costs and are scored on the other four. The index is scaled so the strongest outside interest reaches ${P.lobbyCeiling}: a lobby cannot adopt a law. The ${fmtNum(P.orgs.length)} highest are mapped.</p>
    <h3>The timeline</h3>
    <p>Bars show published lobby meetings with the Commission each week of the current term. Play it, and each lobby's building grows with the meetings it has had so far.</p>
    <h3>What this does not capture</h3>
    <p>Published meetings cover Commissioners, cabinets and senior management only; contacts with junior officials, MEPs and national governments are missing, and lobbying costs are self-declared. Access and money measure effort, not success.</p>
    <h3>Data</h3>
    <ul>
      <li>Buildings and heights: UrbIS 3D Constructions, paradigm.brussels.</li>
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
function cityReady() {
  $('#loading').hidden = true;
  uniforms.uLayerAt.value = now() + 0.4;
  const v = homeView();
  flight = { t0: performance.now(), dur: reduced ? 1 : 2600, from: { t: controls.target.clone(), p: camera.position.clone() }, to: { t: v.target, p: v.pos } };
  applyWeek();
  const [k, val] = decodeURIComponent(location.hash.slice(1)).split('=');
  if (k === 'place' && byId[val]) setTimeout(() => focusPlace(val), 2700);
  if (k === 'route') setTimeout(() => startRoute(val), 2700);
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
