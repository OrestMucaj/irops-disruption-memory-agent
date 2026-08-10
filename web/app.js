/* IROPS Disruption Memory — operations console.
 *
 * Vue 3 + PrimeVue, loaded as UMD from web/vendor/. No bundler, no build step:
 * the frontend is still just static files S3 serves unchanged, which keeps the
 * deploy a plain `aws s3 sync` and means nothing between here and the demo URL
 * can fail to compile.
 *
 * The vendor files are committed rather than fetched from a CDN on purpose. The
 * demo has to stay up for a month of judging; a CDN outage or a version yanked
 * upstream would take it down for reasons that have nothing to do with this
 * project.
 *
 * API base: same-origin /api locally, or window.API_BASE (written by
 * scripts/deploy.ps1) when the page is on S3 and the API is a Lambda Function
 * URL on another origin.
 */
'use strict';

const API = (window.API_BASE || '').replace(/\/+$/, '');
const { createApp, ref, computed, onMounted, nextTick } = Vue;

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

const pad = (n) => String(n).padStart(2, '0');

/** Zulu, always. Local time in an ops context is a defect. */
function zulu(d) {
  if (!d) return '—';
  const t = new Date(d);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}Z`;
}
const short = (id) => String(id || '').slice(0, 8);

/* Mirrors severityOf() in src/domain/vocabulary.ts. Display-only duplication —
   the server owns the real classification; this only picks a colour. */
const severity = (m) => (m < 60 ? 'minor' : m < 120 ? 'moderate' : m < 240 ? 'severe' : 'extreme');

/* Presentation for the five action types in src/agent/schema.ts. Ordered most
   consequential first: a reviewer should meet "rebook 12 people" before
   "send a message", because that is the decision that costs money. */
const ACTION_META = {
  rebook:     { label: 'Rebook',     icon: 'pi pi-sync',                 blurb: 'move onto a later flight' },
  hotel:      { label: 'Hotel',      icon: 'pi pi-home',                 blurb: 'overnight accommodation' },
  prioritise: { label: 'Prioritise', icon: 'pi pi-flag-fill',            blurb: 'handle at the desk first' },
  escalate:   { label: 'Escalate',   icon: 'pi pi-exclamation-triangle', blurb: 'raise to the duty manager' },
  notify:     { label: 'Notify',     icon: 'pi pi-send',                 blurb: 'proactive passenger message' },
};
const ACTION_ORDER = ['rebook', 'hotel', 'prioritise', 'escalate', 'notify'];

const app = createApp({
  setup() {
    const view = ref('cases');
    const health = ref(null);
    const clock = ref('--:--:--');

    const cases = ref([]);
    const loadingCases = ref(true);
    const statusFilter = ref('all');
    const query = ref('');
    const filters = ref({ global: { value: null, matchMode: 'contains' } });

    const detail = ref(null);
    const currentCaseId = ref(null);
    const running = ref(false);
    const deciding = ref(false);
    const resolving = ref(false);
    const outcomeNotes = ref('');
    const outcomeRating = ref(4);

    const expanded = ref({});          // action_type -> bool
    const evidenceTab = ref('pax');
    const bulk = ref(null);            // { done, total } while a bulk decision runs
    const editing = ref(null);         // the action open in the edit dialog
    const editNote = ref('');
    const precedentOpen = ref(null);   // the precedent open in the detail dialog

    const memory = ref(null);
    const question = ref('');
    const asking = ref(false);

    /* The analyst is a floating assistant rather than a panel inside Memory:
       the question you want to ask usually arrives while you are looking at a
       case ("has weather ever gone well for us?"), and making that require a
       trip to another view is how a feature goes unused. */
    const chatOpen = ref(false);
    const chatLog = ref([]);
    const chatBox = ref(null);

    const toast = PrimeVue.useToast();
    const notify = (severityLevel, summary, detailText) =>
      toast.add({ severity: severityLevel, summary, detail: detailText, life: 5000 });

    /* ---------------------------------------------------------- chrome -- */

    setInterval(() => {
      const d = new Date();
      clock.value = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
    }, 1000);

    /* ------------------------------------------------------- caseload -- */

    const statusOptions = [
      { label: 'All', value: 'all' },
      { label: 'Open', value: 'open' },
      { label: 'Planned', value: 'planned' },
      { label: 'Resolved', value: 'resolved' },
    ];

    async function loadCases() {
      loadingCases.value = true;
      try {
        const r = await call('/api/cases?status=all');
        // pg returns INT/count as strings; DataTable's numeric sort needs numbers.
        cases.value = r.cases.map((c) => ({
          ...c,
          delay_minutes: Number(c.delay_minutes ?? 0),
          pax_count: Number(c.pax_count ?? 0),
          misconnect_count: Number(c.misconnect_count ?? 0),
          priority_pax_count: Number(c.priority_pax_count ?? 0),
          pending_actions: Number(c.pending_actions ?? 0),
          outcome_rating: c.outcome_rating === null ? null : Number(c.outcome_rating),
        }));
      } catch (err) {
        notify('error', 'Could not load disruptions', err.message);
      } finally {
        loadingCases.value = false;
      }
    }

    const filteredCases = computed(() => {
      const q = query.value.trim().toLowerCase();
      return cases.value.filter((c) => {
        if (statusFilter.value !== 'all' && c.status !== statusFilter.value) return false;
        if (!q) return true;
        return `${c.flight_no} ${c.origin} ${c.destination} ${c.origin}${c.destination} ${c.cause} ${c.status}`
          .toLowerCase().includes(q);
      });
    });

    const caseKpis = computed(() => {
      const list = cases.value;
      const open = list.filter((c) => c.status === 'open').length;
      const planned = list.filter((c) => c.status === 'planned').length;
      const resolved = list.filter((c) => c.status === 'resolved');
      const rated = resolved.filter((c) => c.outcome_rating !== null);
      const mean = rated.length
        ? (rated.reduce((s, c) => s + c.outcome_rating, 0) / rated.length).toFixed(1) : '—';
      const misconnecting = list.filter((c) => c.status !== 'resolved')
        .reduce((s, c) => s + c.misconnect_count, 0);
      const pending = list.reduce((s, c) => s + c.pending_actions, 0);
      return [
        { label: 'Active disruptions', value: open + planned, tone: 'orange', icon: 'pi pi-bolt', foot: `${open} open · ${planned} planned` },
        { label: 'Pax misconnecting', value: misconnecting, tone: 'red', icon: 'pi pi-users', foot: 'across active disruptions' },
        { label: 'Awaiting review', value: pending, tone: 'blue', icon: 'pi pi-inbox', foot: 'proposed actions to decide' },
        { label: 'Resolved', value: resolved.length, tone: 'green', icon: 'pi pi-check-circle', foot: list.length ? `${Math.round((resolved.length / list.length) * 100)}% of caseload` : '' },
        { label: 'Mean outcome', value: mean, suffix: '/5', tone: 'pink', icon: 'pi pi-star', foot: `${rated.length} rated` },
        { label: 'In memory', value: list.length, tone: 'purple', icon: 'pi pi-database', foot: 'cases embedded' },
      ];
    });

    /* --------------------------------------------------------- detail -- */

    async function openCase(id) {
      currentCaseId.value = id;
      detail.value = null;
      expanded.value = {};
      evidenceTab.value = 'pax';
      view.value = 'detail';
      window.scrollTo({ top: 0 });
      await loadDetail();
    }

    async function loadDetail() {
      try {
        const d = await call(`/api/cases/${currentCaseId.value}`);
        d.actions = d.actions.map((a) => ({ ...a, confidence: Number(a.confidence ?? 0) }));
        d.passengers = d.passengers.map((p) => ({
          ...p,
          connectionMinutes: p.connectionMinutes === null ? null : Number(p.connectionMinutes),
        }));
        d.precedents = d.precedents.map((p) => ({
          ...p,
          delay_minutes: Number(p.delay_minutes ?? 0),
          outcome_rating: p.outcome_rating === null ? null : Number(p.outcome_rating),
        }));
        detail.value = d;
      } catch (err) {
        notify('error', 'Could not load case', err.message);
      }
    }

    const caseFacts = computed(() => {
      if (!detail.value) return [];
      const c = detail.value.case;
      return [
        { k: 'Cause', v: String(c.cause).replace('_', '-') },
        { k: 'Severity', v: severity(c.delayMinutes) },
        { k: 'Aircraft', v: String(c.aircraftClass).replace('_', '-') },
        { k: 'Passengers', v: c.paxCount },
        { k: 'Priority pax', v: c.priorityPaxCount },
        { k: 'Scheduled dep', v: zulu(c.scheduledDep) },
        { k: 'Actual dep', v: c.actualDep ? zulu(c.actualDep) : 'not departed' },
        { k: 'Case ref', v: short(c.id) },
      ];
    });

    const missedCount = computed(() =>
      (detail.value?.passengers ?? []).filter((p) => p.connectionStatus === 'missed').length);
    const atRiskCount = computed(() =>
      (detail.value?.passengers ?? []).filter((p) => p.connectionStatus === 'at_risk').length);

    const paxSummary = computed(() => {
      if (!detail.value) return '';
      return `${detail.value.passengers.length} tracked · ${missedCount.value} missed · ${atRiskCount.value} at risk`;
    });

    const runMeta = computed(() => {
      const r = detail.value?.lastRun;
      if (!r) return 'not yet run';
      return `last run ${zulu(r.created_at)} · ${(r.retrieved_case_ids || []).length} similar cases · ${r.latency_ms ?? '?'}ms`;
    });

    /* --------------------------------------------------- the action plan -- */

    /* Actions carry precedent as raw case UUIDs. A reviewer cannot do anything
       with "ee75da89", so resolve each one against the retrieved set and show
       the flight number and how that case actually turned out. This is the
       whole point of the product, and it belongs at the moment of decision
       rather than in a column the reviewer has to eyeball-match against. */
    const precedentById = computed(() => {
      const map = new Map();
      for (const p of detail.value?.precedents ?? []) map.set(p.id, p);
      return map;
    });

    function outcomeWord(r) {
      if (r === null || r === undefined) return 'unrated';
      if (r <= 2) return 'went badly';
      if (r === 3) return 'mixed';
      return 'worked';
    }

    function citeChips(ids) {
      return (ids || []).map((id) => {
        const p = precedentById.value.get(id);
        return {
          id,
          known: Boolean(p),
          flight: p ? p.flight_no : short(id),
          rating: p ? p.outcome_rating : null,
          tone: p ? precTone(p.outcome_rating) : '',
          word: p ? outcomeWord(p.outcome_rating) : 'not in this run',
        };
      });
    }

    /* One card per action type instead of one per passenger. Twelve identical
       "rebook SYNPAX-nnnnnn" cards is not twelve decisions — it is one decision
       printed twelve times, and making the reviewer click Approve twelve times
       is how a reviewer stops reading. Individual override stays one click away. */
    const actionGroups = computed(() => {
      const all = detail.value?.actions ?? [];
      const byType = new Map();
      for (const a of all) {
        if (!byType.has(a.action_type)) byType.set(a.action_type, []);
        byType.get(a.action_type).push(a);
      }

      const paxByRef = new Map();
      for (const p of detail.value?.passengers ?? []) paxByRef.set(p.paxRef, p);

      const groups = [];
      for (const [type, items] of byType) {
        const meta = ACTION_META[type] ?? { label: type, icon: 'pi pi-circle-fill', blurb: '' };
        const pending = items.filter((a) => a.status === 'proposed');

        // Distinct precedent across the whole group, most-cited first.
        const counts = new Map();
        for (const a of items) {
          for (const id of a.precedent_case_ids || []) {
            counts.set(id, (counts.get(id) || 0) + 1);
          }
        }
        const cites = citeChips([...counts.entries()].sort((x, y) => y[1] - x[1]).map(([id]) => id));

        // Who this group is about, in connection terms rather than pax refs.
        const targets = items.map((a) => paxByRef.get(a.target_pax_ref)).filter(Boolean);
        const missed = targets.filter((p) => p.connectionStatus === 'missed').length;
        const risk = targets.filter((p) => p.connectionStatus === 'at_risk').length;
        const caseLevel = items.filter((a) => !a.target_pax_ref).length;
        const parts = [];
        if (missed) parts.push(`${missed} missed their connection`);
        if (risk) parts.push(`${risk} at risk`);
        if (caseLevel) parts.push(`${caseLevel} case-level`);

        const conf = items.reduce((s, a) => s + a.confidence, 0) / (items.length || 1);

        groups.push({
          type, items, pending, cites,
          label: meta.label, icon: meta.icon, blurb: meta.blurb,
          headline: parts.join(' · ') || `${items.length} action(s)`,
          confidence: conf,
          approved: items.filter((a) => a.status === 'approved').length,
          rejected: items.filter((a) => a.status === 'rejected').length,
          edited: items.filter((a) => a.status === 'edited').length,
        });
      }

      groups.sort((a, b) => {
        const ia = ACTION_ORDER.indexOf(a.type);
        const ib = ACTION_ORDER.indexOf(b.type);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      });
      return groups;
    });

    const pendingActions = computed(() =>
      (detail.value?.actions ?? []).filter((a) => a.status === 'proposed'));

    const decidedCount = computed(() =>
      (detail.value?.actions ?? []).length - pendingActions.value.length);

    const planNote = computed(() => {
      const total = (detail.value?.actions ?? []).length;
      if (!total) return 'nothing proposed yet';
      const p = pendingActions.value.length;
      return p
        ? `${total} action${total === 1 ? '' : 's'} · ${p} awaiting your decision`
        : `${total} action${total === 1 ? '' : 's'} · all decided`;
    });

    const isExpanded = (type) => expanded.value[type] === true;
    function toggleGroup(type) { expanded.value = { ...expanded.value, [type]: !isExpanded(type) }; }

    /* --------------------------------------------------------- decisions -- */

    const busy = computed(() => deciding.value || bulk.value !== null);

    async function decide(action, status, payload) {
      deciding.value = true;
      try {
        await call(`/api/actions/${action.id}/decision`, {
          method: 'POST',
          body: JSON.stringify(payload ? { status, edited_payload: payload } : { status }),
        });
        notify('success', `Action ${status}`, '');
        await loadDetail();
      } catch (err) {
        notify('error', 'Failed', err.message);
      } finally {
        deciding.value = false;
      }
    }

    /* Bulk approve is N calls, not one — the decision endpoint is per-action so
       every decision keeps its own audited row. Four at a time: the free-tier
       cluster is one node and a dozen concurrent SERIALIZABLE writes would
       mostly retry each other. Failures are counted, not swallowed. */
    async function bulkDecide(list, status) {
      const items = list.slice();
      if (!items.length) return;
      bulk.value = { done: 0, total: items.length };
      let failed = 0;
      let cursor = 0;

      async function worker() {
        while (cursor < items.length) {
          const a = items[cursor];
          cursor += 1;
          try {
            await call(`/api/actions/${a.id}/decision`, {
              method: 'POST',
              body: JSON.stringify({ status }),
            });
          } catch {
            failed += 1;
          }
          bulk.value = { done: bulk.value.done + 1, total: items.length };
        }
      }

      await Promise.all(Array.from({ length: Math.min(4, items.length) }, worker));
      bulk.value = null;

      const done = items.length - failed;
      if (failed) notify('warn', `${done} of ${items.length} ${status}`, `${failed} failed — reload and retry`);
      else notify('success', `${done} action${done === 1 ? '' : 's'} ${status}`, '');

      await loadDetail();
      await loadCases();
    }

    function openEdit(action) {
      editing.value = action;
      editNote.value = '';
    }
    function closeEdit() { editing.value = null; }
    function closePrecedent() { precedentOpen.value = null; }
    function openPrecedentCase() {
      const id = precedentOpen.value?.id;
      precedentOpen.value = null;
      if (id) openCase(id);
    }

    async function submitEdit() {
      const note = editNote.value.trim();
      if (!note) { notify('warn', 'Say what you changed', 'The note is the signal.'); return; }
      const action = editing.value;
      editing.value = null;
      await decide(action, 'edited', { reviewer_note: note, original_rationale: action.rationale });
    }

    function openPrecedent(id) {
      precedentOpen.value = precedentById.value.get(id) ?? null;
      if (!precedentOpen.value) notify('info', 'Not in this run', 'That case was not among the retrieved precedent.');
    }

    async function resolveCase() {
      if (!outcomeNotes.value.trim()) { notify('warn', 'Outcome notes are required', ''); return; }
      resolving.value = true;
      try {
        const r = await call(`/api/cases/${currentCaseId.value}/resolve`, {
          method: 'POST',
          body: JSON.stringify({
            outcome_notes: outcomeNotes.value.trim(),
            outcome_rating: Number(outcomeRating.value),
          }),
        });
        notify('success', 'Resolved',
          r.embedded ? 'Embedded — this case is now retrievable precedent'
            : 'Saved, but embedding failed; it will be backfilled');
        outcomeNotes.value = '';
        await loadDetail();
        await loadCases();
      } catch (err) {
        notify('error', 'Failed', err.message);
      } finally {
        resolving.value = false;
      }
    }

    async function runAgent() {
      running.value = true;
      try {
        const r = await call(`/api/cases/${currentCaseId.value}/run`, { method: 'POST' });
        if (r.error) notify('error', 'Run failed', r.error);
        else notify('success', 'Recommendations ready',
          `${r.actionCount} actions from ${r.precedentCount} similar past disruptions`);
        await loadDetail();
      } catch (err) {
        notify('error', 'Run failed', err.message);
      } finally {
        running.value = false;
      }
    }

    function scrollToClose() {
      document.getElementById('close-the-loop')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    /* --------------------------------------------------------- memory -- */

    async function loadMemory() {
      try {
        const m = await call('/api/memory');
        m.mostCitedPrecedents = m.mostCitedPrecedents.map((p) => ({
          ...p,
          delay_minutes: Number(p.delay_minutes ?? 0),
          citations: Number(p.citations ?? 0),
          outcome_rating: p.outcome_rating === null ? null : Number(p.outcome_rating),
        }));
        m.recentRuns = m.recentRuns.map((r) => ({
          ...r,
          prompt_tokens: r.prompt_tokens === null ? null : Number(r.prompt_tokens),
          completion_tokens: r.completion_tokens === null ? null : Number(r.completion_tokens),
          latency_ms: r.latency_ms === null ? null : Number(r.latency_ms),
        }));
        memory.value = m;
      } catch (err) {
        notify('error', 'Could not load memory', err.message);
      }
    }

    const memoryKpis = computed(() => {
      const s = memory.value?.stats ?? {};
      const decisions = Number(s.approved || 0) + Number(s.edited || 0) + Number(s.rejected || 0);
      return [
        { label: 'Cases embedded', value: s.embedded_cases ?? 0, tone: 'purple', icon: 'pi pi-database', foot: 'searchable as precedent' },
        { label: 'Outcomes embedded', value: s.embedded_resolutions ?? 0, tone: 'green', icon: 'pi pi-check-circle', foot: 'resolutions in memory' },
        { label: 'Proposals made', value: s.total_proposals ?? 0, tone: 'blue', icon: 'pi pi-inbox', foot: 'by the agent, all runs' },
        { label: 'Human decisions', value: decisions, tone: 'orange', icon: 'pi pi-user-edit', foot: `${s.approved || 0} approved · ${s.edited || 0} edited · ${s.rejected || 0} rejected` },
      ];
    });

    const outcomeBars = computed(() => {
      const labels = { 5: 'Excellent', 4: 'Effective', 3: 'Acceptable', 2: 'Poor', 1: 'Failed' };
      const buckets = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
      for (const r of memory.value?.recentResolutions ?? []) {
        const n = Number(r.outcome_rating);
        if (buckets[n] !== undefined) buckets[n] += 1;
      }
      const max = Math.max(1, ...Object.values(buckets));
      return [5, 4, 3, 2, 1].map((n) => ({
        n, label: labels[n], count: buckets[n], pct: (buckets[n] / max) * 100,
      }));
    });

    const decisionBars = computed(() => {
      const s = memory.value?.stats ?? {};
      const total = Number(s.total_proposals || 0);
      const approved = Number(s.approved || 0);
      const edited = Number(s.edited || 0);
      const rejected = Number(s.rejected || 0);
      const awaiting = Math.max(0, total - approved - edited - rejected);
      const max = Math.max(1, approved, edited, rejected, awaiting);
      return [
        { label: 'Approved', count: approved, pct: (approved / max) * 100, cls: 'bar-approved' },
        { label: 'Edited', count: edited, pct: (edited / max) * 100, cls: 'bar-edited' },
        { label: 'Rejected', count: rejected, pct: (rejected / max) * 100, cls: 'bar-rejected' },
        { label: 'Awaiting review', count: awaiting, pct: (awaiting / max) * 100, cls: 'bar-awaiting' },
      ];
    });

    const suggestions = [
      'Which cause had the worst average outcome rating?',
      'How many proposals has a human rejected?',
      'What is the average delay for weather disruptions?',
    ];

    function scrollChat() {
      const el = chatBox.value;
      if (el) el.scrollTop = el.scrollHeight;
    }
    function toggleChat() {
      chatOpen.value = !chatOpen.value;
      if (chatOpen.value) nextTick(scrollChat);
    }
    function closeChat() { chatOpen.value = false; }
    function clearChat() { chatLog.value = []; }
    function toggleSql(message) { message.showSql = !message.showSql; }

    /* Reads as a conversation, but each question is answered independently —
       the analyst holds no history, so the transcript is a record of what was
       asked, not context the model can lean on. Said plainly in the UI rather
       than implied away, because a chat window invites the opposite belief. */
    async function askAnalyst(preset) {
      if (preset) question.value = preset;
      const q = question.value.trim();
      if (q.length < 3) { notify('warn', 'Ask a question first', ''); return; }

      chatOpen.value = true;
      chatLog.value = [...chatLog.value, { role: 'user', text: q }];
      question.value = '';
      asking.value = true;
      await nextTick(); scrollChat();

      try {
        const r = await call('/api/analyst', {
          method: 'POST',
          body: JSON.stringify({ question: q }),
        });
        chatLog.value = [...chatLog.value, { role: 'bot', showSql: true, ...r }];
      } catch (err) {
        chatLog.value = [...chatLog.value, {
          role: 'bot', showSql: false, answer: null, queries: [], refusals: [], error: err.message,
        }];
      } finally {
        asking.value = false;
        await nextTick(); scrollChat();
      }
    }

    /* ----------------------------------------------------- navigation -- */

    function goCases() { view.value = 'cases'; loadCases(); }
    function goMemory() { view.value = 'memory'; loadMemory(); }
    function onRowClick(event) { openCase(event.data.id); }
    function onSearch() { if (view.value !== 'cases') view.value = 'cases'; }
    function applyStatusFilter() { /* computed reacts; hook kept for clarity */ }

    /* -------------------------------------------------------- helpers -- */

    const statusSeverity = (s) =>
      s === 'open' ? 'warn' : s === 'planned' ? 'info' : 'success';
    const connSeverity = (s) =>
      s === 'missed' ? 'danger' : s === 'at_risk' ? 'warn' : 'secondary';
    const actionSeverity = (s) =>
      s === 'approved' ? 'success' : s === 'rejected' ? 'danger'
        : s === 'edited' ? 'warn' : 'secondary';
    const precTone = (r) => (r === null ? '' : r <= 2 ? 'bad' : r >= 4 ? 'good' : 'mid');
    const confWord = (c) => (c >= 0.8 ? 'high' : c >= 0.6 ? 'medium' : 'low');

    /* Retrieval rank, not a similarity percentage. The cosine distance is
       computed inside the vector search and never leaves the agent run — the
       API returns the retrieved ids in closest-first order and nothing more.
       Rank is the real signal available here; a percentage bar fed by an
       absent field would just be a full bar pretending to be a measurement. */
    const RANK_WORDS = ['closest match', '2nd closest', '3rd closest', '4th closest', '5th closest'];
    const rankWord = (i) => RANK_WORDS[i] ?? `${i + 1}th closest`;

    const precedentRank = computed(() => {
      if (!precedentOpen.value) return 0;
      return (detail.value?.precedents ?? []).findIndex((p) => p.id === precedentOpen.value.id);
    });

    onMounted(async () => {
      try { health.value = await call('/api/health'); } catch { health.value = null; }
      await loadCases();
    });

    return {
      view, health, clock,
      cases, loadingCases, filteredCases, caseKpis, statusFilter, statusOptions, query, filters,
      detail, caseFacts, missedCount, atRiskCount, paxSummary, runMeta,
      running, deciding, resolving, outcomeNotes, outcomeRating,
      actionGroups, pendingActions, decidedCount, planNote, citeChips,
      expanded, isExpanded, toggleGroup, evidenceTab, bulk, busy,
      editing, editNote, openEdit, submitEdit, closeEdit,
      precedentOpen, openPrecedent, closePrecedent, openPrecedentCase,
      outcomeWord, rankWord, precedentRank,
      memory, memoryKpis, outcomeBars, decisionBars,
      question, asking, suggestions,
      chatOpen, chatLog, chatBox, toggleChat, closeChat, clearChat, toggleSql, scrollChat,
      goCases, goMemory, openCase, onRowClick, onSearch, applyStatusFilter, scrollToClose,
      runAgent, decide, bulkDecide, resolveCase, askAnalyst,
      zulu, short, severity, statusSeverity, connSeverity, actionSeverity,
      precTone, confWord,
    };
  },
});

app.use(PrimeVue.default || PrimeVue.PrimeVue, {
  theme: {
    preset: PrimeVue.Themes.Aura,
    options: {
      // The page is permanently dark (html class="dark"), matching an ops
      // console that runs on a wall display through a night shift.
      darkModeSelector: '.dark',
      cssLayer: false,
    },
  },
  ripple: false,
});
app.use(PrimeVue.ToastService);

for (const [tag, name] of [
  ['p-datatable', 'DataTable'], ['p-column', 'Column'], ['p-button', 'Button'],
  ['p-tag', 'Tag'], ['p-card', 'Card'], ['p-panel', 'Panel'], ['p-message', 'Message'],
  ['p-textarea', 'Textarea'], ['p-inputtext', 'InputText'], ['p-progressbar', 'ProgressBar'],
  ['p-selectbutton', 'SelectButton'], ['p-chip', 'Chip'], ['p-toast', 'Toast'],
  ['p-iconfield', 'IconField'], ['p-inputicon', 'InputIcon'], ['p-dialog', 'Dialog'],
  ['p-tabs', 'Tabs'], ['p-tablist', 'TabList'], ['p-tab', 'Tab'],
  ['p-tabpanels', 'TabPanels'], ['p-tabpanel', 'TabPanel'],
  ['p-divider', 'Divider'], ['p-badge', 'Badge'],
]) {
  if (PrimeVue[name]) app.component(tag, PrimeVue[name]);
}
if (PrimeVue.Tooltip) app.directive('tooltip', PrimeVue.Tooltip);

app.mount('#app');
