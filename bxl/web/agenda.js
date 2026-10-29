// Agenda: upcoming Brussels policy events, read daily from the organisers' own websites (pipeline/build_agenda.py).
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const TZ = 'Europe/Brussels';
const dayFmt = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
const longFmt = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const shortFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const asDate = iso => new Date(iso + 'T12:00:00Z');
const addDays = (iso, n) => new Date(asDate(iso).getTime() + n * 864e5).toISOString().slice(0, 10);
const mins = t => t ? +t.slice(0, 2) * 60 + +t.slice(3, 5) : null;
function brusselsNow() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date()).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

// Filters live in the URL so any view can be shared or bookmarked
const params = new URLSearchParams(location.search);
const f = { day: params.get('day') || 'today', format: params.get('format') || 'all', topic: params.get('topic') || 'all',
  dur: params.get('dur') || 'all', q: params.get('q') || '', group: params.get('group') || 'all' };
function syncUrl() {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v && v !== 'all' && !(k === 'day' && v === 'today')) p.set(k, v);
  history.replaceState(null, '', p.toString() ? `?${p}` : location.pathname);
}

let data = { events: [], topics: [], sources: [] };
const res = await fetch('data/agenda.json').catch(() => null);
if (res?.ok) data = await res.json();
data.events.forEach((e, i) => (e.i = i));

function inRange(e, range) { const last = e.endDate || e.date; return !(last < range[0] || e.date > range[1]); }
function rangeOf(day) {
  const t = brusselsNow().date;
  return { today: [t, t], tomorrow: [addDays(t, 1), addDays(t, 1)], week: [t, addDays(t, 6)], all: [t, '9999-12-31'] }[day];
}
function matches(e, skip = '') {
  if (skip !== 'format' && f.format !== 'all' && e.format !== f.format) return false;
  if (skip !== 'topic' && f.topic !== 'all' && e.topic !== f.topic) return false;
  if (f.group !== 'all' && (e.group || 'Other organisers') !== f.group) return false;
  const d = e.start && e.end ? mins(e.end) - mins(e.start) : null;
  if (f.dur === 'short' && !(d != null && d <= 120)) return false;
  if (f.dur === 'long' && !(e.endDate || (d != null && d >= 180))) return false;
  if (f.q) { const q = f.q.toLowerCase(); if (!(`${e.title} ${e.org} ${e.topic}`.toLowerCase().includes(q))) return false; }
  return true;
}
function isLive(e) {
  const n = brusselsNow();
  if (e.date > n.date || (e.endDate || e.date) < n.date) return false;
  if (e.endDate && e.date < n.date) return true;
  return !!(e.start && e.end && mins(n.time) >= mins(e.start) && mins(n.time) < mins(e.end));
}
const isPast = e => { const n = brusselsNow(); return (e.endDate || e.date) === n.date && e.end && !e.endDate && mins(e.end) <= mins(n.time); };

function ics(e) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
  const d = e.date.replace(/-/g, '');
  const when = e.start
    ? `DTSTART;TZID=${TZ}:${d}T${e.start.replace(':', '')}00\r\nDTEND;TZID=${TZ}:${(e.endDate || e.date).replace(/-/g, '')}T${(e.end || e.start).replace(':', '')}00`
    : `DTSTART;VALUE=DATE:${d}\r\nDTEND;VALUE=DATE:${addDays(e.endDate || e.date, 1).replace(/-/g, '')}`;
  const clean = s => String(s).replace(/[\\;,]/g, m => '\\' + m).replace(/\n/g, ' ');
  const body = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Brussels by power//Agenda//EN', 'BEGIN:VEVENT',
    `UID:${d}-${e.i}@brussels-by-power`, `DTSTAMP:${stamp}`, when, `SUMMARY:${clean(e.title)}`,
    `DESCRIPTION:${clean(`${e.org}, ${e.format}. ${e.url}`)}`, `URL:${e.url}`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([body], { type: 'text/calendar' }));
  a.download = `${e.date}-${e.title.slice(0, 40).replace(/[^\w]+/g, '-')}.ics`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function eventHtml(e) {
  const time = e.start ? `<b>${e.start}</b>${e.end ? `<span>until ${e.end}</span>` : ''}`
    : e.endDate ? `<b>All day</b><span>until ${shortFmt.format(asDate(e.endDate))}</span>` : `<b>Time</b><span>on event page</span>`;
  const fmt = e.format.replace(/ /g, '').toLowerCase();
  const fmtLabel = e.format === 'Not stated' ? 'Format not stated' : e.format;
  return `<li class="ev${isPast(e) ? ' past' : ''}">
    <div class="time">${time}</div>
    <div class="body">
      <div class="org"><span translate="no">${esc(e.org)}</span>
        ${e.place ? `<a class="onmap" href="./#place=${encodeURIComponent(e.place)}">On the map</a>` : ''}
        ${isLive(e) ? '<span class="live">Live now</span>' : ''}</div>
      <h3><a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.title)}</a></h3>
      <div class="meta"><button type="button" class="tag topic" data-topic="${esc(e.topic)}" aria-label="Show only ${esc(e.topic)}">${esc(e.topic)}</button>
        <span class="tag fmt fmt-${fmt}">${esc(fmtLabel)}</span>${e.where ? `<span class="tag where">${esc(e.where.slice(0, 60))}</span>` : ''}</div>
    </div>
    <div class="actions"><a class="btn primary" href="${esc(e.url)}" target="_blank" rel="noopener">Event Page</a>
      <button type="button" class="btn" data-ics="${e.i}">Add to Calendar</button></div>
  </li>`;
}

function render() {
  const range = rangeOf(f.day), now = brusselsNow();
  const pool = data.events.filter(e => inRange(e, range));
  const list = pool.filter(e => matches(e));
  // Headline
  $('#eyebrow').textContent = { today: 'Today', tomorrow: 'Tomorrow', week: 'This week', all: 'All upcoming' }[f.day];
  $('#title').textContent = f.day === 'today' ? longFmt.format(asDate(now.date))
    : f.day === 'tomorrow' ? longFmt.format(asDate(addDays(now.date, 1)))
    : f.day === 'week' ? `${shortFmt.format(asDate(range[0]))} to ${shortFmt.format(asDate(range[1]))}`
    : `Until ${longFmt.format(asDate(data.to || range[0]))}`;
  const live = list.filter(isLive).length;
  $('#count').textContent = `${list.length} event${list.length === 1 ? '' : 's'}${live ? `, ${live} live now` : ''}${list.length !== pool.length ? ` (of ${pool.length} before filters)` : ''}`;
  // Controls
  document.querySelectorAll('[data-k]').forEach(b => b.setAttribute('aria-pressed', String(f[b.dataset.k] === b.dataset.v)));
  $('#topic').value = f.topic; $('#dur').value = f.dur; $('#group').value = f.group;
  if (document.activeElement !== $('#q')) $('#q').value = f.q;
  // Events, grouped by day, in time order (all-day and untimed last within a day)
  const byDay = new Map();
  const shown = e => e.date < range[0] ? range[0] : e.date;     // ongoing multi-day events appear on the first day shown
  for (const e of list.sort((a, b) => shown(a).localeCompare(shown(b)) || (a.start || '99').localeCompare(b.start || '99') || a.org.localeCompare(b.org))) {
    const d = shown(e);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(e);
  }
  $('#events').innerHTML = byDay.size ? [...byDay].map(([d, evs]) => `<li class="day"><h2><b>${d === now.date ? 'Today' : d === addDays(now.date, 1) ? 'Tomorrow' : dayFmt.format(asDate(d))}</b>
      ${d === now.date || d === addDays(now.date, 1) ? dayFmt.format(asDate(d)) : ''}<span class="n">${evs.length} event${evs.length === 1 ? '' : 's'}</span></h2>
      <ol class="events">${evs.map(eventHtml).join('')}</ol></li>`).join('')
    : `<li class="empty"><b>No events match.</b>${pool.length ? 'Try a different topic, format or length.' : 'Nothing is listed for this period yet.'}
      ${f.day !== 'all' ? '<br><button type="button" class="btn" data-k="day" data-v="all">See All Upcoming Events</button>' : ''}</li>`;
  // Sidebar: topics within the day range (ignoring the topic filter) and most active organisers
  const tcount = {};
  for (const e of pool.filter(e => matches(e, 'topic'))) tcount[e.topic] = (tcount[e.topic] || 0) + 1;
  const tmax = Math.max(1, ...Object.values(tcount));
  $('#topics').innerHTML = Object.entries(tcount).sort((a, b) => b[1] - a[1]).map(([t, n]) => `<li><button type="button" data-topic="${esc(t)}" aria-pressed="${f.topic === t}">
      <span>${esc(t)}</span><span class="n">${n}</span><span class="bar"><i style="width:${100 * n / tmax}%"></i></span></button></li>`).join('') || '<li class="n">Nothing in this period.</li>';
  const ocount = {};
  for (const e of list) ocount[e.org] = (ocount[e.org] || 0) + 1;
  $('#orgs').innerHTML = Object.entries(ocount).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([o, n]) => `<li><span translate="no">${esc(o)}</span><span class="n">${n}</span></li>`).join('') || '<li class="n">None yet.</li>';
  const nsrc = data.sources?.filter(s => s.events).length || 0;
  if (nsrc || data.scraperSources) $('#sources').innerHTML = `Read every morning from ${data.scraperSources || nsrc} organisers’ own websites and the European Parliament’s calendar. Times are Brussels time; always check the event page before you go.`;
  syncUrl();
}

// Events
document.addEventListener('click', e => {
  const k = e.target.closest('[data-k]');
  if (k) { f[k.dataset.k] = k.dataset.v; render(); return; }
  const t = e.target.closest('[data-topic]');
  if (t) { f.topic = f.topic === t.dataset.topic ? 'all' : t.dataset.topic; render(); $('#events').focus({ preventScroll: true }); return; }
  const c = e.target.closest('[data-ics]');
  if (c) ics(data.events[+c.dataset.ics]);
});
$('#topic').innerHTML = '<option value="all">All Topics</option>' + (data.topics || []).map(t => `<option>${esc(t)}</option>`).join('');
$('#topic').addEventListener('change', e => { f.topic = e.target.value; render(); });
const groups = [...new Set(data.events.map(e => e.group || 'Other organisers'))].sort();
$('#group').innerHTML = '<option value="all">All Organisers</option>' + groups.map(g => `<option>${esc(g)}</option>`).join('');
$('#group').addEventListener('change', e => { f.group = e.target.value; render(); });
$('#dur').addEventListener('change', e => { f.dur = e.target.value; render(); });
let qTimer;
$('#q').addEventListener('input', e => { clearTimeout(qTimer); qTimer = setTimeout(() => { f.q = e.target.value.trim(); render(); }, 150); });
render();
setInterval(render, 60000);   // keep "Live now" current
