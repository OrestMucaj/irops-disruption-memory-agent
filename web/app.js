/* IROPS Disruption Memory Agent — frontend.
 *
 * Plain DOM and fetch. No framework, no build step, no router: SPEC §6 says
 * three views maximum and explicitly not to spend time on design systems or
 * routing, and a build step would be one more thing to break between here and
 * the S3 bucket.
 *
 * API base resolution: same-origin /api when served by the local dev server,
 * or window.API_BASE when the page is on S3 and the API is a Lambda Function
 * URL on a different origin. config.js (written at deploy time) sets it.
 */
'use strict';

const API = (window.API_BASE || '').replace(/\/+$/, '') || '';
const api = (path) => `${API}${path}`;

const $ = (sel) => document.querySelector(sel);
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of children.flat()) {
    if (child == null) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
};

const esc = (s) => String(s ?? '');
const fmtDate = (d) => (d ? new Date(d).toISOString().replace('T', ' ').slice(0, 16) + 'Z' : '—');
const shortId = (id) => String(id ?? '').slice(0, 8);

let toastTimer;
function toast(message) {
  const node = $('#toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 3200);
}

async function call(path, options) {
  const response = await fetch(api(path), {
    headers: { 'content-type': 'application/json' },
    ...options,
  });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = { error: text }; }
  if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
  return body;
}

// ---------------------------------------------------------------------------
// View switching
// ---------------------------------------------------------------------------

function show(view) {
  for (const id of ['cases', 'detail', 'memory']) {
    $(`#view-${id}`).hidden = id !== view;
  }
  document.querySelectorAll('nav button').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === view);
  });
}

document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-view]');
  if (!target) return;
  const view = target.dataset.view;
  show(view);
  if (view === 'cases') loadCases();
  if (view === 'memory') loadMemory();
});

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

async function loadHealth() {
  try {
    const h = await call('/api/health');
    $('#health').textContent =
      `embeddings: ${h.embeddingModel}  ·  reasoning: ${h.llmModel}`;
    if (h.llmProvider === 'heuristic') {
      $('#health').textContent += '   ⚠ heuristic stand-in, not a language model';
    }
  } catch (err) {
    $('#health').textContent = `API unreachable: ${err.message}`;
  }
}

// ---------------------------------------------------------------------------
// View 1 — case list
// ---------------------------------------------------------------------------

async function loadCases() {
  const tbody = $('#case-table tbody');
  tbody.replaceChildren(el('tr', {}, el('td', { colSpan: 8, className: 'spin' }, 'loading…')));

  try {
    const status = $('#status-filter').value;
    const { cases } = await call(`/api/cases?status=${encodeURIComponent(status)}`);
    $('#case-count').textContent = `${cases.length} case${cases.length === 1 ? '' : 's'}`;

    if (!cases.length) {
      tbody.replaceChildren(el('tr', {}, el('td', { colSpan: 8, className: 'spin' }, 'no cases')));
      return;
    }

    tbody.replaceChildren(...cases.map((c) => {
      const row = el('tr', {},
        el('td', {}, el('code', {}, esc(c.flight_no))),
        el('td', {}, `${esc(c.origin)} → ${esc(c.destination)}`),
        el('td', {}, esc(c.cause)),
        el('td', {}, `${c.delay_minutes ?? '—'} min`),
        el('td', {}, String(c.pax_count)),
        el('td', {}, String(c.misconnect_count)),
        el('td', {}, el('span', { className: `pill ${c.status}` }, c.status)),
        el('td', {}, c.outcome_rating != null ? `${c.outcome_rating}/5`
          : c.pending_actions > 0 ? `${c.pending_actions} pending` : '—'),
      );
      row.onclick = () => openCase(c.id);
      return row;
    }));
  } catch (err) {
    tbody.replaceChildren(el('tr', {}, el('td', { colSpan: 8 },
      el('div', { className: 'banner err' }, `Could not load cases: ${err.message}`))));
  }
}

$('#status-filter').addEventListener('change', loadCases);

// ---------------------------------------------------------------------------
// View 2 — case detail
// ---------------------------------------------------------------------------

let currentCaseId = null;

async function openCase(id) {
  currentCaseId = id;
  show('detail');
  $('#detail-body').replaceChildren(el('div', { className: 'spin' }, 'loading…'));
  await renderCase();
}

async function renderCase() {
  const body = $('#detail-body');
  let data;
  try {
    data = await call(`/api/cases/${currentCaseId}`);
  } catch (err) {
    body.replaceChildren(el('div', { className: 'banner err' }, `Could not load case: ${err.message}`));
    return;
  }

  const { case: c, passengers, actions, precedents, lastRun, resolution } = data;
  const parts = [];

  // --- Facts -------------------------------------------------------------
  const fact = (label, value) => el('div', {}, el('span', {}, label), el('b', {}, value));
  parts.push(el('div', { className: 'card' },
    el('h3', {}, `${esc(c.flightNo)}  ${esc(c.origin)} → ${esc(c.destination)}`,
      ' ', el('span', { className: `pill ${c.status}` }, c.status)),
    el('div', { className: 'facts' },
      fact('cause', c.cause),
      fact('delay', `${c.delayMinutes} min`),
      fact('scheduled', fmtDate(c.scheduledDep)),
      fact('aircraft', String(c.aircraftClass).replace(/_/g, ' ')),
      fact('passengers', c.paxCount),
      fact('misconnecting', c.misconnectCount),
      fact('priority pax', c.priorityPaxCount),
    ),
  ));

  // --- Run controls ------------------------------------------------------
  const runBtn = el('button', { className: 'primary' },
    actions.length ? 'Re-run agent' : 'Ask the agent for a plan');
  runBtn.onclick = async () => {
    runBtn.disabled = true;
    runBtn.textContent = 'thinking…';
    try {
      const result = await call(`/api/cases/${currentCaseId}/run`, { method: 'POST' });
      toast(result.error
        ? `Run failed: ${result.error}`
        : `${result.actionCount} actions from ${result.precedentCount} precedents (${result.latencyMs}ms)`);
      await renderCase();
    } catch (err) {
      toast(`Run failed: ${err.message}`);
      runBtn.disabled = false;
      runBtn.textContent = 'Ask the agent for a plan';
    }
  };

  const runCard = el('div', { className: 'card' }, el('h2', {}, 'Agent'), runBtn);
  if (lastRun) {
    runCard.append(el('div', { className: 'muted', style: 'margin-top:9px' },
      `last run ${fmtDate(lastRun.created_at)} · ${lastRun.model_id} · ` +
      `${lastRun.prompt_tokens ?? '?'}/${lastRun.completion_tokens ?? '?'} tokens · ${lastRun.latency_ms ?? '?'}ms`));
    if (lastRun.error) {
      runCard.append(el('div', { className: 'banner err', style: 'margin-top:9px' }, lastRun.error));
    }
  }
  parts.push(runCard);

  // --- Retrieved precedent (the heart of the demo) -----------------------
  const precCard = el('div', { className: 'card' },
    el('h2', {}, 'Retrieved precedent — what was done, and how it turned out'));

  if (!precedents.length) {
    precCard.append(el('div', { className: 'muted' },
      'No precedents yet. Run the agent to search the memory layer.'));
  } else {
    for (const p of precedents) {
      const rating = p.outcome_rating;
      const cls = rating == null ? '' : rating <= 2 ? 'bad' : rating >= 4 ? 'good' : '';
      const acts = Array.isArray(p.actions_taken)
        ? p.actions_taken.map((a) => a.action_type).join(' + ') : '—';

      precCard.append(el('div', { className: `precedent ${cls}` },
        el('div', { className: 'meta' },
          `${shortId(p.id)} · ${esc(p.flight_no)} · ${esc(p.cause)} · ${p.delay_minutes} min · ${fmtDate(p.scheduled_dep)}`),
        el('div', { className: 'summary' }, esc(p.summary_text)),
        el('div', { className: 'outcome' },
          el('em', {}, 'did: '), acts, '  ',
          el('em', {}, 'outcome: '),
          rating == null ? 'not recorded' : `${rating}/5`,
          rating != null && rating <= 2 ? ' — went badly' : '',
          p.outcome_notes ? el('div', { className: 'muted', style: 'margin-top:4px' }, esc(p.outcome_notes)) : null),
      ));
    }
  }
  parts.push(precCard);

  // --- Proposed actions --------------------------------------------------
  const actCard = el('div', { className: 'card' },
    el('h2', {}, 'Proposed actions — nothing is executed without approval'));

  if (!actions.length) {
    actCard.append(el('div', { className: 'muted' }, 'No proposals yet.'));
  } else {
    for (const a of actions) {
      const decided = a.status !== 'proposed';
      const node = el('div', { className: 'action' },
        el('div', { className: 'head' },
          el('span', { className: 'type' }, String(a.action_type).toUpperCase()),
          a.target_pax_ref ? el('code', {}, esc(a.target_pax_ref)) : el('span', { className: 'muted' }, 'case-level'),
          el('span', { className: `pill ${a.status}` }, a.status),
          el('span', { className: 'muted' }, `confidence ${a.confidence ?? '—'}`)),
        el('div', { className: 'rationale' }, esc(a.rationale)),
        el('div', { className: 'cites' },
          a.precedent_case_ids?.length
            ? `cites: ${a.precedent_case_ids.map(shortId).join(', ')}`
            : 'cites: none'),
      );

      if (!decided) {
        const controls = el('div', { className: 'controls' });
        const decide = async (status, editedPayload) => {
          controls.querySelectorAll('button').forEach((b) => { b.disabled = true; });
          try {
            await call(`/api/actions/${a.id}/decision`, {
              method: 'POST',
              body: JSON.stringify(editedPayload ? { status, edited_payload: editedPayload } : { status }),
            });
            toast(`Action ${status}`);
            await renderCase();
          } catch (err) {
            toast(`Failed: ${err.message}`);
            controls.querySelectorAll('button').forEach((b) => { b.disabled = false; });
          }
        };

        const approve = el('button', { className: 'act approve' }, 'Approve');
        approve.onclick = () => decide('approved');

        const edit = el('button', { className: 'act' }, 'Approve with edit');
        edit.onclick = () => {
          const note = prompt('What did you change, and why?\n(Recorded as memory — overrules are the strongest signal in the dataset.)');
          if (note === null || note.trim() === '') return;
          decide('edited', { reviewer_note: note.trim(), original_rationale: a.rationale });
        };

        const reject = el('button', { className: 'act reject' }, 'Reject');
        reject.onclick = () => decide('rejected');

        controls.append(approve, edit, reject);
        node.append(controls);
      } else if (a.edited_payload?.reviewer_note) {
        node.append(el('div', { className: 'banner warn' },
          `Reviewer edit: ${esc(a.edited_payload.reviewer_note)}`));
      }

      actCard.append(node);
    }
  }
  parts.push(actCard);

  // --- Passengers --------------------------------------------------------
  if (passengers.length) {
    const table = el('table', {},
      el('thead', {}, el('tr', {},
        ...['Pax ref', 'Tier', 'Connection', 'Buffer', 'Onward', 'Rebooked', 'Special'].map((h) => el('th', {}, h)))),
      el('tbody', {}, ...passengers.map((p) => el('tr', {},
        el('td', {}, el('code', {}, esc(p.paxRef))),
        el('td', {}, esc(p.priorityTier)),
        el('td', {}, el('span', {
          className: 'pill ' + (p.connectionStatus === 'missed' ? 'rejected'
            : p.connectionStatus === 'at_risk' ? 'edited' : 'resolved'),
        }, p.connectionStatus.replace('_', ' '))),
        el('td', {}, p.connectionMinutes != null ? `${p.connectionMinutes} min` : '—'),
        el('td', {}, esc(p.onwardFlight ?? '—')),
        el('td', {}, esc(p.rebookedTo ?? '—')),
        el('td', {}, p.specialHandling?.length ? p.specialHandling.join(', ') : '—'),
      ))),
    );
    parts.push(el('div', { className: 'card' },
      el('h2', {}, `Affected passengers (${passengers.length})`), table));
  }

  // --- Resolve -----------------------------------------------------------
  if (resolution) {
    parts.push(el('div', { className: 'card' },
      el('h2', {}, 'Resolution — now retrievable precedent'),
      el('div', {}, el('b', {}, `Rated ${resolution.outcome_rating}/5`), ' · ', fmtDate(resolution.resolved_at)),
      el('div', { style: 'margin-top:6px' }, esc(resolution.outcome_notes))));
  } else if (c.status !== 'resolved') {
    const notes = el('textarea', { rows: 3, placeholder: 'What actually happened? This becomes the precedent future cases retrieve.' });
    const rating = el('input', { type: 'number', min: 1, max: 5, value: 4 });
    const submit = el('button', { className: 'primary' }, 'Resolve case & write to memory');

    submit.onclick = async () => {
      if (!notes.value.trim()) { toast('Outcome notes are required'); return; }
      submit.disabled = true;
      submit.textContent = 'embedding…';
      try {
        const r = await call(`/api/cases/${currentCaseId}/resolve`, {
          method: 'POST',
          body: JSON.stringify({
            outcome_notes: notes.value.trim(),
            outcome_rating: Number(rating.value),
          }),
        });
        toast(r.embedded
          ? 'Resolved and embedded — this case is now precedent'
          : 'Resolved, but embedding failed; it will be backfilled');
        await renderCase();
      } catch (err) {
        toast(`Failed: ${err.message}`);
        submit.disabled = false;
        submit.textContent = 'Resolve case & write to memory';
      }
    };

    parts.push(el('div', { className: 'card' },
      el('h2', {}, 'Close the loop'),
      el('label', { className: 'field' }, 'Outcome notes'), notes,
      el('label', { className: 'field' }, 'Outcome rating (1 poor – 5 good)'), rating,
      submit));
  }

  body.replaceChildren(...parts);
}

// ---------------------------------------------------------------------------
// View 3 — memory
// ---------------------------------------------------------------------------

async function loadMemory() {
  const body = $('#memory-body');
  body.replaceChildren(el('div', { className: 'spin' }, 'loading…'));

  let data;
  try {
    data = await call('/api/memory');
  } catch (err) {
    body.replaceChildren(el('div', { className: 'banner err' }, `Could not load memory: ${err.message}`));
    return;
  }

  const { stats, recentResolutions, mostCitedPrecedents, recentRuns } = data;
  const parts = [];

  const stat = (label, value) => el('div', { className: 'stat' }, el('b', {}, String(value ?? 0)), el('span', {}, label));
  parts.push(el('div', { className: 'card' },
    el('h2', {}, 'What the agent remembers'),
    el('div', { className: 'stats' },
      stat('cases', stats.total_cases),
      stat('resolved', stats.resolved_cases),
      stat('embedded cases', stats.embedded_cases),
      stat('embedded outcomes', stats.embedded_resolutions),
      stat('proposals', stats.total_proposals),
      stat('approved', stats.approved),
      stat('edited', stats.edited),
      stat('rejected', stats.rejected),
    ),
    el('div', { className: 'muted', style: 'margin-top:10px' },
      'Rejected and edited proposals are kept deliberately — what a human overruled is the strongest signal in the dataset.'),
  ));

  parts.push(el('div', { className: 'card' },
    el('h2', {}, 'Most-cited precedents'),
    mostCitedPrecedents.length
      ? el('table', {},
          el('thead', {}, el('tr', {}, ...['Case', 'Flight', 'Cause', 'Delay', 'Outcome', 'Citations'].map((h) => el('th', {}, h)))),
          el('tbody', {}, ...mostCitedPrecedents.map((p) => {
            const row = el('tr', {},
              el('td', {}, el('code', {}, shortId(p.id))),
              el('td', {}, esc(p.flight_no)),
              el('td', {}, esc(p.cause)),
              el('td', {}, `${p.delay_minutes} min`),
              el('td', {}, p.outcome_rating != null ? `${p.outcome_rating}/5` : '—'),
              el('td', {}, String(p.citations)));
            row.onclick = () => openCase(p.id);
            return row;
          })))
      : el('div', { className: 'muted' }, 'No citations yet — run the agent on a case.')));

  parts.push(el('div', { className: 'card' },
    el('h2', {}, 'Recent resolutions'),
    recentResolutions.length
      ? el('div', {}, ...recentResolutions.map((r) => el('div', { className: `precedent ${r.outcome_rating <= 2 ? 'bad' : r.outcome_rating >= 4 ? 'good' : ''}` },
          el('div', { className: 'meta' },
            `${esc(r.flight_no)} · ${esc(r.cause)} · ${r.delay_minutes} min · ${fmtDate(r.resolved_at)}` +
            (r.embedded ? '' : ' · NOT EMBEDDED')),
          el('div', { className: 'outcome' }, el('em', {}, `${r.outcome_rating}/5 — `), esc(r.outcome_notes)))))
      : el('div', { className: 'muted' }, 'Nothing resolved yet.')));

  parts.push(el('div', { className: 'card' },
    el('h2', {}, 'Recent agent runs (observability)'),
    recentRuns.length
      ? el('table', {},
          el('thead', {}, el('tr', {}, ...['When', 'Model', 'Prompt', 'Completion', 'Latency', 'Error'].map((h) => el('th', {}, h)))),
          el('tbody', {}, ...recentRuns.map((r) => el('tr', {},
            el('td', {}, fmtDate(r.created_at)),
            el('td', {}, el('code', {}, esc(r.model_id))),
            el('td', {}, String(r.prompt_tokens ?? '—')),
            el('td', {}, String(r.completion_tokens ?? '—')),
            el('td', {}, r.latency_ms != null ? `${r.latency_ms}ms` : '—'),
            el('td', {}, r.error ? el('span', { style: 'color:var(--bad)' }, esc(r.error).slice(0, 60)) : '—')))))
      : el('div', { className: 'muted' }, 'No runs yet.')));

  body.replaceChildren(...parts);
}

// ---------------------------------------------------------------------------

loadHealth();
loadCases();
