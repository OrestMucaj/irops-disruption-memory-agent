/* IROPS Disruption Memory — operations console.
 *
 * Plain DOM and fetch. No framework, no build step: three static files that
 * S3 serves unchanged. `npm run build` runs `node --check` over this file —
 * there is no bundler to catch a syntax error before it ships.
 *
 * API base: same-origin /api locally, or window.API_BASE (written by
 * scripts/deploy.ps1) when the page is on S3 and the API is a Lambda
 * Function URL on another origin.
 */
'use strict';

const API = (window.API_BASE || '').replace(/\/+$/, '');
const $ = (s) => document.querySelector(s);

const el = (tag, props, ...kids) => {
  const n = Object.assign(document.createElement(tag), props || {});
  for (const k of kids.flat()) {
    if (k === null || k === undefined || k === false) continue;
    n.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return n;
};

/* replaceChildren stringifies null into the literal text "null" — el() filters
   its own children but this does not, so every top-level mount goes through
   here. Conditional panels are common enough that forgetting once is certain. */
const mount = (node, ...kids) => node.replaceChildren(...kids.flat().filter(Boolean));

const svg = (tag, attrs) => {
  const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, String(v));
  return n;
};

/* Small inline icon set (Feather-style outline paths). Inlined rather than
   fetched: no CDN, no font, nothing extra to break between here and S3. */
const ICONS = {
  activity: '<polyline points="21 12 17 12 14 20 9 4 6 12 2 12"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9"/><path d="M16 3.1a4 4 0 0 1 0 7.8"/>',
  inbox: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1z"/>',
  check: '<path d="M22 11.1V12a10 10 0 1 1-5.9-9.1"/><polyline points="22 4 12 14 9 11"/>',
  star: '<polygon points="12 2 15.1 8.3 22 9.3 17 14.1 18.2 21 12 17.8 5.8 21 7 14.1 2 9.3 8.9 8.3 12 2"/>',
  db: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M20 5v14c0 1.7-3.6 3-8 3s-8-1.3-8-3V5"/><path d="M20 12c0 1.7-3.6 3-8 3s-8-1.3-8-3"/>',
};
const icon = (name) => {
  const s = svg('svg', {
    viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
  });
  s.innerHTML = ICONS[name] || '';
  return s;
};

const num = (v) => (v === null || v === undefined ? null : Number(v));
const pad = (n) => String(n).padStart(2, '0');

/** Zulu, always. Local time in an ops context is a defect. */
const zulu = (d) => {
  if (!d) return '—';
  const t = new Date(d);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}Z`;
};
const zuluTime = (d) => (d ? `${pad(new Date(d).getUTCHours())}:${pad(new Date(d).getUTCMinutes())}Z` : '—');
const short = (id) => String(id || '').slice(0, 8);

/* Numbered badge for the case-detail workflow: a new employee should see the
   order of work without training. */
const step = (n) => el('span', { className: 'stepnum' }, String(n));

/* Mirrors severityOf() in src/domain/vocabulary.ts. Display-only duplication —
   the server owns the real classification; this just colours the rail. */
const severity = (m) => (m < 60 ? 'minor' : m < 120 ? 'moderate' : m < 240 ? 'severe' : 'extreme');

let toastTimer;
function toast(message, isError) {
  const t = $('#toast');
  t.textContent = message;
  t.className = 'toast' + (isError ? ' err' : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4200);
}

async function call(path, options) {
  const res = await fetch(`${API}${path}`, {
    headers: { 'content-type': 'application/json' },
    ...options,
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { error: text }; }
  if (!res.ok) throw new Error((body && body.error) || `HTTP ${res.status}`);
  return body;
}

/* ------------------------------------------------------------------ chrome */

setInterval(() => {
  const d = new Date();
  $('#clock').innerHTML =
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}<span>Z</span>`;
}, 1000);

async function loadHealth() {
  const node = $('#sysbox');
  try {
    const h = await call('/api/health');
    mount(node,
      el('span', { className: 'dot up' }),
      el('div', {},
        el('div', {}, `embed ${h.embeddingModel}`),
        el('div', {}, `reason ${h.llmModel}`),
        h.llmProvider === 'heuristic'
          ? el('div', { className: 'provwarn' }, 'heuristic stand-in — not a model')
          : null));
  } catch (err) {
    mount(node,
      el('span', { className: 'dot down' }),
      el('div', {}, `API unreachable — ${err.message}`));
  }
}

function show(view) {
  for (const v of ['cases', 'detail', 'memory']) $(`#view-${v}`).hidden = v !== view;
  document.querySelectorAll('.nav button').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
}

document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-view]');
  if (!t) return;
  const v = t.dataset.view;
  show(v);
  if (v === 'cases') renderCases(true);
  if (v === 'memory') renderMemory();
});

/* Search: filters the caseload client-side. Typing from another view brings
   the caseload up — that is where the results are. */
let query = '';
$('#q').addEventListener('input', (e) => {
  query = e.target.value.trim().toLowerCase();
  if ($('#view-cases').hidden) show('cases');
  renderCases(false);
});

/* KPI card */
const kpi = (label, value, color, iconName, foot, suffix) =>
  el('div', { className: 'kpi' },
    el('div', { className: 'row' },
      el('span', { className: `kchip ${color}` }, icon(iconName)),
      el('div', {},
        el('div', { className: 'k' }, label),
        el('div', { className: 'v' }, String(value), suffix ? el('small', {}, suffix) : null))),
    foot ? el('div', { className: 'foot' }, foot) : null);

/* ------------------------------------------------------- view 1 · caseload */

let filter = 'all';
let caseCache = null;

async function renderCases(force = true) {
  const root = $('#view-cases');
  if (!caseCache) mount(root, el('div', { className: 'loading' }, 'loading'));

  if (force || !caseCache) {
    try {
      ({ cases: caseCache } = await call('/api/cases?status=all'));
    } catch (err) {
      mount(root, el('div', { className: 'notice err' },
        el('span', { className: 'ico' }, '!!'), `Could not load disruptions — ${err.message}`));
      return;
    }
  }
  const cases = caseCache;

  $('#tab-cases').textContent = cases.length;

  const open = cases.filter((c) => c.status === 'open').length;
  const planned = cases.filter((c) => c.status === 'planned').length;
  const resolved = cases.filter((c) => c.status === 'resolved');
  const pending = cases.reduce((s, c) => s + Number(c.pending_actions || 0), 0);
  const rated = resolved.filter((c) => c.outcome_rating !== null);
  const meanRating = rated.length
    ? (rated.reduce((s, c) => s + Number(c.outcome_rating), 0) / rated.length).toFixed(1) : '—';
  const misconnecting = cases
    .filter((c) => c.status !== 'resolved')
    .reduce((s, c) => s + Number(c.misconnect_count || 0), 0);

  const kpis = el('div', { className: 'kpis' },
    kpi('Active disruptions', open + planned, 'orange', 'activity', `${open} open · ${planned} planned`),
    kpi('Pax misconnecting', misconnecting, 'red', 'users', 'across active disruptions'),
    kpi('Awaiting review', pending, 'blue', 'inbox', 'proposed actions to decide'),
    kpi('Resolved', resolved.length, 'green', 'check',
      cases.length ? `${Math.round((resolved.length / cases.length) * 100)}% of caseload` : null),
    kpi('Mean outcome', meanRating, 'pink', 'star', `${rated.length} rated`, '/5'),
    kpi('In memory', cases.length, 'purple', 'db', 'cases embedded'),
  );

  let rows = filter === 'all' ? cases : cases.filter((c) => c.status === filter);
  if (query) {
    rows = rows.filter((c) =>
      `${c.flight_no} ${c.origin} ${c.destination} ${c.origin}${c.destination} ${c.cause} ${c.status}`
        .toLowerCase().includes(query));
  }

  const seg = el('div', { className: 'seg' },
    ...[['all', 'All'], ['open', 'Open'], ['planned', 'Planned'], ['resolved', 'Resolved']]
      .map(([k, label]) => {
        const b = el('button', { className: filter === k ? 'on' : '' }, label);
        b.onclick = () => { filter = k; renderCases(false); };
        return b;
      }));

  const head = el('div', { className: 'pagehead' },
    el('div', {},
      el('h1', {}, 'Operations overview'),
      el('div', { className: 'sub' }, 'Live disruption caseload — every resolved case becomes retrievable memory.')),
    el('div', { className: 'right' }, seg));

  const table = el('table', {},
    el('thead', {}, el('tr', {},
      el('th', { className: 'rail' }),
      ...['Flight', 'Sector', 'STD', 'Cause', 'Delay', 'Pax', 'Misconnects', 'Priority', 'Status', 'Outcome']
        .map((h, i) => el('th', { className: [4, 5, 6, 7].includes(i) ? 'num' : '' }, h)),
      el('th', { className: 'chev' }))),
    el('tbody', {}, ...rows.map(caseRow)),
  );

  mount(root,
    head,
    kpis,
    el('div', { className: 'panel' },
      el('header', {},
        el('h2', {}, 'Disruption caseload'),
        el('span', { className: 'note' },
          query ? `${rows.length} match “${query}”` : `${rows.length} shown · select a row to open it`)),
      el('div', { className: 'body flush' },
        rows.length ? table : el('div', { className: 'empty' }, 'No disruptions match.'))),
  );
}

function caseRow(c) {
  const delay = Number(c.delay_minutes || 0);
  const sev = severity(delay);
  const misconn = Number(c.misconnect_count || 0);
  const rating = num(c.outcome_rating);
  const pendingCount = Number(c.pending_actions || 0);

  const tr = el('tr', { className: 'click' },
    el('td', { className: 'rail' }, el('div', { className: `railbar ${sev}` })),
    el('td', {}, el('span', { className: 'ident' }, c.flight_no)),
    el('td', {}, el('span', { className: 'ident' }, c.origin), el('span', { className: 'dim' }, ' → '), el('span', { className: 'ident' }, c.destination)),
    el('td', { className: 'dim' }, zulu(c.scheduled_dep)),
    el('td', {}, el('span', { className: 'tag neutral plain' }, String(c.cause).replace('_', '-'))),
    el('td', { className: 'num' }, `${delay}′`),
    el('td', { className: 'num dim' }, c.pax_count),
    el('td', { className: 'num' }, misconn > 0
      ? el('span', { style: `color:${misconn >= 20 ? 'var(--critical)' : 'var(--warning)'}` }, String(misconn))
      : el('span', { className: 'dim' }, '0')),
    el('td', { className: 'num dim' }, c.priority_pax_count),
    el('td', {}, el('span', { className: `tag ${c.status}` }, c.status)),
    el('td', {}, rating !== null
      ? el('span', { className: `score s${rating}` }, el('i'), `${rating}/5`)
      : pendingCount > 0
        ? el('span', { className: 'tag proposed plain' }, `${pendingCount} to review`)
        : el('span', { className: 'dim' }, '—')),
    el('td', { className: 'chev' }, '›'),
  );
  tr.onclick = () => openCase(c.id);
  return tr;
}

/* --------------------------------------------------------- view 2 · case */

let currentCase = null;

async function openCase(id) {
  currentCase = id;
  show('detail');
  mount($('#view-detail'), el('div', { className: 'loading' }, 'loading case'));
  await renderCase();
}

async function renderCase() {
  const root = $('#view-detail');
  let d;
  try {
    d = await call(`/api/cases/${currentCase}`);
  } catch (err) {
    mount(root, el('div', { className: 'notice err' },
      el('span', { className: 'ico' }, '!!'), `Could not load case — ${err.message}`));
    return;
  }

  const { case: c, passengers, actions, precedents, lastRun, resolution } = d;
  const gaps = d.coverageGaps || [];
  const sev = severity(c.delayMinutes);

  const back = el('button', { className: 'crumb' }, '← All disruptions');
  back.onclick = () => { show('cases'); renderCases(false); };

  /* header + facts */
  const fact = (k, v, mono) =>
    el('div', { className: 'fact' }, el('div', { className: 'k' }, k),
      el('div', { className: `v ${mono ? 'mono' : ''}` }, v));

  const head = el('div', { className: 'panel' },
    el('div', { className: 'casehead' },
      el('div', {},
        el('div', { className: 'route' }, c.flightNo, el('em', {}, '·'), c.origin, el('em', {}, '→'), c.destination),
        el('div', { className: 'sub' }, `STD ${zulu(c.scheduledDep)}  ·  ${c.aircraftClass.replace('_', '-')}  ·  case ${short(c.id)}`)),
      el('div', { className: 'right' },
        el('span', { className: `tag ${c.status}` }, c.status))),
    el('div', { className: 'facts' },
      fact('Cause', String(c.cause).replace('_', '-')),
      fact('Delay', `${c.delayMinutes}′`),
      fact('Severity', sev),
      fact('Passengers', c.paxCount),
      fact('Misconnecting', c.misconnectCount),
      fact('Priority pax', c.priorityPaxCount),
      fact('Actual dep', c.actualDep ? zuluTime(c.actualDep) : 'not departed', true)),
  );

  /* agent bar — plain language: employees ask for recommendations, they do
     not "run" anything. Token counts stay in Memory → Agent runs. */
  const runBtn = el('button', { className: 'btn primary' },
    actions.length ? 'Refresh recommendations' : 'Get recommendations');
  runBtn.onclick = async () => {
    runBtn.disabled = true;
    runBtn.textContent = 'Searching past disruptions…';
    try {
      const r = await call(`/api/cases/${currentCase}/run`, { method: 'POST' });
      toast(r.error
        ? `Failed — ${r.error}`
        : `Proposed ${r.actionCount} actions, based on ${r.precedentCount} similar past disruptions`, !!r.error);
      await renderCase();
    } catch (err) {
      toast(`Failed — ${err.message}`, true);
      runBtn.disabled = false;
      runBtn.textContent = 'Get recommendations';
    }
  };

  const runMeta = lastRun
    ? el('span', { className: 'note' },
        `last run ${zulu(lastRun.created_at)} · ${(lastRun.retrieved_case_ids || []).length} similar cases retrieved · ${lastRun.latency_ms ?? '?'}ms`)
    : el('span', { className: 'note' }, 'searches past disruptions for similar cases and proposes a plan citing them');

  const agentPanel = el('div', { className: 'panel' },
    el('header', {}, step(2), el('h2', {}, 'Agent recommendation'), runMeta,
      el('div', { className: 'right' }, runBtn)),
    lastRun && lastRun.error
      ? el('div', { className: 'body' },
          el('div', { className: 'notice err' }, el('span', { className: 'ico' }, '!!'), lastRun.error))
      : null,
  );

  /* precedent column */
  const precBody = el('div', { className: 'body' });
  if (!precedents.length) {
    precBody.append(el('div', { className: 'empty' },
      'Nothing retrieved yet — use “Get recommendations” above and the agent will search past disruptions for similar cases.'));
  } else {
    const worst = Math.max(...precedents.map((p) => Number(p.distance)));
    for (const [idx, p] of precedents.entries()) {
      const rating = num(p.outcome_rating);
      const cls = rating === null ? '' : rating <= 2 ? 'bad' : rating >= 4 ? 'good' : 'mid';
      const did = Array.isArray(p.actions_taken) ? p.actions_taken : [];
      const sim = 1 - (Number(p.distance) / (worst || 1)) * 0.85;

      precBody.append(el('div', { className: `prec ${cls}` },
        el('div', { className: 'top' },
          el('span', { className: 'id' }, short(p.id)),
          idx === 0 ? el('span', { className: 'tag planned plain' }, 'closest match') : null,
          el('span', { className: 'meta' }, `${p.flight_no} · ${String(p.cause).replace('_', '-')} · ${p.delay_minutes}′ · ${zulu(p.scheduled_dep)}`),
          el('div', { className: 'sim' },
            el('span', {}, 'similarity'),
            el('span', { className: 'simbar' }, el('i', { style: `width:${Math.round(sim * 100)}%` })))),
        el('div', { className: 'txt' }, p.summary_text),
        el('div', { className: 'did' },
          el('span', { className: 'lbl' }, 'Did'),
          ...(did.length
            ? did.map((a) => el('span', { className: 'tag neutral plain' }, String(a.action_type)))
            : [el('span', { className: 'dim' }, 'nothing recorded')]),
          el('span', { className: 'lbl', style: 'margin-left:8px' }, 'Outcome'),
          rating !== null
            ? el('span', { className: `score s${rating}` }, el('i'), `${rating}/5`)
            : el('span', { className: 'dim' }, 'unrated')),
        p.outcome_notes ? el('div', { className: 'note' }, p.outcome_notes) : null));
    }
  }

  const precPanel = el('div', { className: 'panel' },
    el('header', {},
      step(3),
      el('h2', {}, 'Similar past disruptions'),
      el('span', { className: 'note' }, 'what was done, and how it turned out — red went badly')),
    precBody);

  /* actions column */
  const actBody = el('div', { className: 'body' });

  if (gaps.length) {
    actBody.append(el('div', { className: 'notice err' },
      el('span', { className: 'ico' }, '!!'),
      el('span', {},
        el('b', {}, `${gaps.length} passenger${gaps.length === 1 ? '' : 's'} unhandled. `),
        'Already missed their connection with no action to reaccommodate them: ',
        el('span', { style: 'font-family:var(--mono)' }, gaps.join(', ')),
        '. Review before approving.')));
  }

  if (!actions.length) {
    actBody.append(el('div', { className: 'empty' },
      'No recommendations yet — use “Get recommendations” above.'));
  } else {
    for (const a of actions) {
      const conf = Number(a.confidence ?? 0);
      const decided = a.status !== 'proposed';
      const node = el('div', { className: 'act' },
        el('div', { className: 'top' },
          el('span', { className: 'kind' }, a.action_type),
          a.target_pax_ref
            ? el('span', { className: 'target' }, a.target_pax_ref)
            : el('span', { className: 'dim', style: 'font-size:11px' }, 'case-level'),
          el('span', { className: `tag ${a.status}` }, a.status),
          el('div', { className: 'conf' },
            el('span', {}, `confidence ${conf >= .8 ? 'high' : conf >= .6 ? 'medium' : 'low'}`),
            el('span', { className: `confbar ${conf >= .8 ? 'hi' : conf < .6 ? 'lo' : ''}` },
              el('i', { style: `width:${Math.round(conf * 100)}%` })),
            el('span', {}, conf.toFixed(2)))),
        el('div', { className: 'why' }, a.rationale),
        el('div', { className: 'cites' },
          a.precedent_case_ids && a.precedent_case_ids.length
            ? [el('b', {}, 'cites '), a.precedent_case_ids.map(short).join('  ')]
            : el('span', {}, 'cites nothing')),
      );

      if (!decided) {
        const ctl = el('div', { className: 'ctl' });
        const decide = async (status, payload) => {
          ctl.querySelectorAll('button').forEach((b) => { b.disabled = true; });
          try {
            await call(`/api/actions/${a.id}/decision`, {
              method: 'POST',
              body: JSON.stringify(payload ? { status, edited_payload: payload } : { status }),
            });
            toast(`Action ${status}`);
            await renderCase();
          } catch (err) {
            toast(`Failed — ${err.message}`, true);
            ctl.querySelectorAll('button').forEach((b) => { b.disabled = false; });
          }
        };

        const ok = el('button', { className: 'btn ok sm' }, 'Approve');
        ok.onclick = () => decide('approved');
        const ed = el('button', { className: 'btn sm' }, 'Approve with edit');
        ed.onclick = () => {
          const note = prompt('What did you change, and why?\n\nRecorded as memory — an overrule is the strongest signal in the dataset.');
          if (note === null || !note.trim()) return;
          decide('edited', { reviewer_note: note.trim(), original_rationale: a.rationale });
        };
        const no = el('button', { className: 'btn no sm' }, 'Reject');
        no.onclick = () => decide('rejected');
        ctl.append(ok, ed, no);
        node.append(ctl);
      } else if (a.edited_payload && a.edited_payload.reviewer_note) {
        node.append(el('div', { className: 'notice warn' },
          el('span', { className: 'ico' }, '✎'),
          el('span', {}, el('b', {}, 'Reviewer edit — '), a.edited_payload.reviewer_note)));
      }

      actBody.append(node);
    }
  }

  const actPanel = el('div', { className: 'panel' },
    el('header', {},
      step(4),
      el('h2', {}, 'Proposed actions'),
      el('span', { className: 'note' }, 'approve, edit or reject each — nothing happens without your approval')),
    actBody);

  /* passengers — above the evidence panels: you check who you are dealing
     with before reading recommendations about them */
  const missedN = passengers.filter((p) => p.connectionStatus === 'missed').length;
  const riskN = passengers.filter((p) => p.connectionStatus === 'at_risk').length;
  const paxPanel = passengers.length ? el('div', { className: 'panel' },
    el('header', {}, step(1), el('h2', {}, 'Affected passengers'),
      el('span', { className: 'note' },
        `${passengers.length} tracked · ${missedN} missed · ${riskN} at risk`)),
    el('div', { className: 'body flush' },
      el('table', {},
        el('thead', {}, el('tr', {},
          ...['Reference', 'Tier', 'Connection', 'Buffer', 'Onward', 'Rebooked to', 'Special handling']
            .map((h, i) => el('th', { className: i === 3 ? 'num' : '' }, h)))),
        el('tbody', {}, ...passengers.map((p) => el('tr', {},
          el('td', {}, el('span', { className: 'ident' }, p.paxRef)),
          el('td', { className: 'dim' }, p.priorityTier),
          el('td', {}, el('span', { className: `tag ${p.connectionStatus}` }, p.connectionStatus.replace('_', ' '))),
          el('td', { className: 'num' }, p.connectionMinutes !== null ? `${p.connectionMinutes}′` : '—'),
          el('td', {}, p.onwardFlight ? el('span', { className: 'ident' }, p.onwardFlight) : el('span', { className: 'dim' }, '—')),
          el('td', {}, p.rebookedTo ? el('span', { className: 'ident' }, p.rebookedTo) : el('span', { className: 'dim' }, '—')),
          el('td', { className: 'dim' }, p.specialHandling && p.specialHandling.length ? p.specialHandling.join(', ').replace(/_/g, ' ') : '—'),
        )))))) : null;

  /* resolve / resolution */
  let closePanel;
  if (resolution) {
    const r = num(resolution.outcome_rating);
    closePanel = el('div', { className: 'panel' },
      el('header', {}, step(5), el('h2', {}, 'Resolution'),
        el('span', { className: 'note' }, 'this outcome is now memory — future disruptions can retrieve it')),
      el('div', { className: 'body' },
        el('div', { style: 'display:flex;align-items:center;gap:12px;margin-bottom:8px' },
          el('span', { className: `score s${r}` }, el('i'), `${r}/5`),
          el('span', { className: 'dim', style: 'font-family:var(--mono);font-size:11px' }, zulu(resolution.resolved_at))),
        el('div', { style: 'font-size:12.5px;line-height:1.55' }, resolution.outcome_notes)));
  } else if (c.status !== 'resolved') {
    const notes = el('textarea', { placeholder: 'What actually happened? This becomes the precedent future disruptions retrieve.' });
    let rating = 4;
    const picker = el('div', { className: 'ratepick' },
      ...[1, 2, 3, 4, 5].map((n) => {
        const b = el('button', { className: n === rating ? 'on' : '' }, String(n));
        b.onclick = () => {
          rating = n;
          picker.querySelectorAll('button').forEach((x, i) => x.classList.toggle('on', i + 1 === n));
        };
        return b;
      }));

    const submit = el('button', { className: 'btn primary' }, 'Resolve & write to memory');
    submit.onclick = async () => {
      if (!notes.value.trim()) { toast('Outcome notes are required', true); return; }
      submit.disabled = true;
      submit.textContent = 'Embedding…';
      try {
        const r = await call(`/api/cases/${currentCase}/resolve`, {
          method: 'POST',
          body: JSON.stringify({ outcome_notes: notes.value.trim(), outcome_rating: rating }),
        });
        toast(r.embedded
          ? 'Resolved and embedded — this case is now retrievable precedent'
          : 'Resolved, but embedding failed; it will be backfilled');
        await renderCase();
      } catch (err) {
        toast(`Failed — ${err.message}`, true);
        submit.disabled = false;
        submit.textContent = 'Resolve & write to memory';
      }
    };

    closePanel = el('div', { className: 'panel' },
      el('header', {}, step(5), el('h2', {}, 'Close the loop'),
        el('span', { className: 'note' }, 'record what actually happened — it becomes memory for future disruptions')),
      el('div', { className: 'body' },
        el('label', { className: 'field' }, 'Outcome notes'), notes,
        el('label', { className: 'field' }, 'Outcome rating — 1 failed, 5 excellent'), picker,
        submit));
  }

  // Order is the workflow: situation → who is affected → ask the agent →
  // review evidence and decide → close. Passengers sit above the evidence
  // panels at the author's request — you check who you are dealing with
  // before reading recommendations about them.
  mount(root, back, head, paxPanel, agentPanel,
    el('div', { className: 'cols' }, precPanel, actPanel),
    closePanel);
}

/* ------------------------------------------------------- view 3 · memory */

async function renderMemory() {
  const root = $('#view-memory');
  if (!root.children.length) mount(root, el('div', { className: 'loading' }, 'loading'));

  let d;
  try {
    d = await call('/api/memory');
  } catch (err) {
    mount(root, el('div', { className: 'notice err' },
      el('span', { className: 'ico' }, '!!'), `Could not load memory — ${err.message}`));
    return;
  }

  const s = d.stats || {};
  $('#tab-memory').textContent = Number(s.embedded_cases || 0);

  const decisions = Number(s.approved || 0) + Number(s.edited || 0) + Number(s.rejected || 0);

  const head = el('div', { className: 'pagehead' },
    el('div', {},
      el('h1', {}, 'Memory'),
      el('div', { className: 'sub' }, 'What the agent has learned — outcomes, citations, and every run it has made.')));

  const kpis = el('div', { className: 'kpis' },
    kpi('Cases embedded', s.embedded_cases || 0, 'purple', 'db', 'searchable as precedent'),
    kpi('Outcomes embedded', s.embedded_resolutions || 0, 'green', 'check', 'resolutions in memory'),
    kpi('Proposals made', s.total_proposals || 0, 'blue', 'inbox', 'by the agent, all runs'),
    kpi('Human decisions', decisions, 'orange', 'activity',
      `${s.approved || 0} approved · ${s.edited || 0} edited · ${s.rejected || 0} rejected`),
  );

  /* Outcome distribution. Bars carry a status colour AND a printed count and
     label, so colour never carries the meaning alone. */
  const buckets = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const r of d.recentResolutions || []) {
    const n = num(r.outcome_rating);
    if (n && buckets[n] !== undefined) buckets[n] += 1;
  }
  const hasDistribution = Object.values(buckets).some((n) => n > 0);

  const distPanel = el('div', { className: 'panel' },
    el('header', {}, el('h2', {}, 'Outcome distribution'),
      el('span', { className: 'note' }, `most recent ${(d.recentResolutions || []).length} resolutions`)),
    el('div', { className: 'body' },
      hasDistribution ? outcomeChart(buckets) : el('div', { className: 'empty' }, 'No resolutions yet.')));

  const donutPanel = el('div', { className: 'panel' },
    el('header', {}, el('h2', {}, 'Proposal decisions'),
      el('span', { className: 'note' }, 'rejections are kept — an overrule is the strongest signal')),
    el('div', { className: 'body' }, decisionsDonut(s)));

  /* Most-cited precedents */
  const cited = d.mostCitedPrecedents || [];
  const citedPanel = el('div', { className: 'panel' },
    el('header', {}, el('h2', {}, 'Most-cited precedent'),
      el('span', { className: 'note' }, 'which past cases the agent actually leans on')),
    el('div', { className: 'body flush' },
      cited.length
        ? el('table', {},
            el('thead', {}, el('tr', {},
              ...['Case', 'Flight', 'Cause', 'Delay', 'Outcome', 'Citations'].map((h, i) =>
                el('th', { className: i >= 3 ? 'num' : '' }, h)))),
            el('tbody', {}, ...cited.map((p) => {
              const r = num(p.outcome_rating);
              const tr = el('tr', { className: 'click' },
                el('td', {}, el('span', { className: 'ident' }, short(p.id))),
                el('td', {}, el('span', { className: 'ident' }, p.flight_no)),
                el('td', {}, el('span', { className: 'tag neutral plain' }, String(p.cause).replace('_', '-'))),
                el('td', { className: 'num dim' }, `${p.delay_minutes}′`),
                el('td', { className: 'num' }, r !== null
                  ? el('span', { className: `score s${r}` }, el('i'), `${r}/5`)
                  : el('span', { className: 'dim' }, '—')),
                el('td', { className: 'num' }, String(p.citations)));
              tr.onclick = () => openCase(p.id);
              return tr;
            })))
        : el('div', { className: 'empty' }, 'No citations yet — run the agent on a disruption.')));

  /* Recent resolutions */
  const recent = d.recentResolutions || [];
  const recentPanel = el('div', { className: 'panel' },
    el('header', {}, el('h2', {}, 'Recent resolutions'), el('span', { className: 'note' }, 'newest first')),
    el('div', { className: 'body' },
      recent.length
        ? el('div', {}, ...recent.map((r) => {
            const n = num(r.outcome_rating);
            const cls = n === null ? '' : n <= 2 ? 'bad' : n >= 4 ? 'good' : 'mid';
            return el('div', { className: `prec ${cls}` },
              el('div', { className: 'top' },
                el('span', { className: 'id' }, r.flight_no),
                el('span', { className: 'meta' }, `${String(r.cause).replace('_', '-')} · ${r.delay_minutes}′ · ${zulu(r.resolved_at)}`),
                el('div', { className: 'sim' },
                  n !== null ? el('span', { className: `score s${n}` }, el('i'), `${n}/5`) : null,
                  r.embedded ? null : el('span', { className: 'provwarn' }, 'not embedded'))),
              el('div', { className: 'note' }, r.outcome_notes));
          }))
        : el('div', { className: 'empty' }, 'Nothing resolved yet.')));

  /* Observability */
  const runs = d.recentRuns || [];
  const runPanel = el('div', { className: 'panel' },
    el('header', {}, el('h2', {}, 'Agent runs'),
      el('span', { className: 'note' }, 'every run is recorded, including failures')),
    el('div', { className: 'body flush' },
      runs.length
        ? el('table', {},
            el('thead', {}, el('tr', {},
              ...['Time', 'Model', 'Prompt', 'Completion', 'Latency', 'Result'].map((h, i) =>
                el('th', { className: i >= 2 && i <= 4 ? 'num' : '' }, h)))),
            el('tbody', {}, ...runs.map((r) => el('tr', {},
              el('td', { className: 'dim' }, zulu(r.created_at)),
              el('td', {}, el('span', { className: 'ident' }, r.model_id)),
              el('td', { className: 'num dim' }, r.prompt_tokens ?? '—'),
              el('td', { className: 'num dim' }, r.completion_tokens ?? '—'),
              el('td', { className: 'num dim' }, r.latency_ms !== null ? `${r.latency_ms}ms` : '—'),
              el('td', {}, r.error
                ? el('span', { className: 'tag rejected' }, 'failed')
                : el('span', { className: 'tag resolved' }, 'ok'))))))
        : el('div', { className: 'empty' }, 'No runs yet.')));

  mount(root, head, kpis,
    el('div', { className: 'cols' }, distPanel, donutPanel),
    citedPanel, recentPanel, runPanel);
}

/**
 * Horizontal bar chart of outcome ratings. Horizontal because the category
 * labels are words; status colours because the bars encode a state; every bar
 * carries its rating label and printed count, so colour is never the only
 * channel.
 */
function outcomeChart(buckets) {
  const rows = [
    { n: 5, label: 'Excellent', color: 'var(--good)' },
    { n: 4, label: 'Effective', color: 'var(--good)' },
    { n: 3, label: 'Acceptable', color: 'var(--warning)' },
    { n: 2, label: 'Poor', color: 'var(--serious)' },
    { n: 1, label: 'Failed', color: 'var(--critical)' },
  ];
  const max = Math.max(1, ...rows.map((r) => buckets[r.n] || 0));

  const rowH = 27, gap = 3, gutter = 106, padRight = 40, top = 6;
  const w = 560;
  const h = top + rows.length * (rowH + gap) + 22;
  const plotW = w - gutter - padRight;

  const g = svg('svg', { class: 'chart', viewBox: `0 0 ${w} ${h}`, role: 'img', 'aria-label': 'Distribution of outcome ratings' });

  for (let i = 0; i <= 4; i += 1) {
    const x = gutter + (plotW * i) / 4;
    g.append(svg('line', { class: 'grid', x1: x, y1: top, x2: x, y2: top + rows.length * (rowH + gap) }));
    const t = svg('text', { class: 'axis', x, y: h - 6, 'text-anchor': 'middle' });
    t.textContent = String(Math.round((max * i) / 4));
    g.append(t);
  }

  rows.forEach((r, i) => {
    const v = buckets[r.n] || 0;
    const y = top + i * (rowH + gap);
    const barW = Math.max(v > 0 ? 4 : 0, (plotW * v) / max);

    const cat = svg('text', { class: 'cat', x: gutter - 10, y: y + rowH / 2 + 4, 'text-anchor': 'end' });
    cat.textContent = `${r.n} · ${r.label}`;
    g.append(cat);

    if (v > 0) {
      g.append(svg('rect', {
        x: gutter, y: y + 3, width: barW, height: rowH - 6,
        rx: 5, ry: 5, fill: r.color,
      }));
    }

    const val = svg('text', { class: 'val', x: gutter + barW + 8, y: y + rowH / 2 + 4 });
    val.textContent = String(v);
    g.append(val);
  });

  g.append(svg('line', {
    x1: gutter, y1: top + rows.length * (rowH + gap), x2: gutter + plotW, y2: top + rows.length * (rowH + gap),
    stroke: 'rgba(255,255,255,.13)', 'stroke-width': 1,
  }));

  return g;
}

/**
 * Donut of proposal decisions — part-of-whole across four states, with the
 * total in the centre and a labelled legend beside it. Colour is never alone:
 * every legend row prints its label and count.
 */
function decisionsDonut(s) {
  const total = Number(s.total_proposals || 0);
  if (!total) {
    return el('div', { className: 'empty' }, 'No proposals yet — run the agent on a disruption.');
  }

  const approved = Number(s.approved || 0);
  const edited = Number(s.edited || 0);
  const rejected = Number(s.rejected || 0);
  const awaiting = Math.max(0, total - approved - edited - rejected);

  const segs = [
    { k: 'Approved', v: approved, c: 'var(--green)' },
    { k: 'Edited', v: edited, c: 'var(--orange)' },
    { k: 'Rejected', v: rejected, c: 'var(--red)' },
    { k: 'Awaiting review', v: awaiting, c: '#3d3d4a' },
  ].filter((x) => x.v > 0);

  const size = 172;
  const cx = size / 2;
  const r = 66;
  const circ = 2 * Math.PI * r;

  const g = svg('svg', { viewBox: `0 0 ${size} ${size}`, role: 'img', 'aria-label': 'Proposal decisions' });
  g.append(svg('circle', { cx, cy: cx, r, fill: 'none', stroke: 'var(--panel-3)', 'stroke-width': 18 }));

  let acc = 0;
  for (const sgm of segs) {
    const len = (sgm.v / total) * circ;
    const drawn = Math.max(0, len - (segs.length > 1 ? 2 : 0));
    g.append(svg('circle', {
      cx, cy: cx, r, fill: 'none',
      stroke: sgm.c, 'stroke-width': 18,
      'stroke-dasharray': `${drawn} ${circ - drawn}`,
      'stroke-dashoffset': String(-acc),
      transform: `rotate(-90 ${cx} ${cx})`,
    }));
    acc += len;
  }

  return el('div', { className: 'donutwrap' },
    el('div', { className: 'donut' }, g,
      el('div', { className: 'center' }, el('b', {}, String(total)), el('span', {}, 'proposals'))),
    el('div', { className: 'legend' },
      ...segs.map((sgm) => el('div', { className: 'lg' },
        el('i', { style: `background:${sgm.c}` }),
        el('span', {}, sgm.k),
        el('b', {}, String(sgm.v))))));
}

/* ------------------------------------------------------------------- boot */

loadHealth();
renderCases(true);
