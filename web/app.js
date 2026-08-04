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
const { createApp, ref, computed, onMounted } = Vue;

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

    const memory = ref(null);
    const question = ref('');
    const analyst = ref(null);
    const asking = ref(false);

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
      view.value = 'detail';
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
          distance: Number(p.distance ?? 0),
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
        { k: 'Delay', v: `${c.delayMinutes}′` },
        { k: 'Severity', v: severity(c.delayMinutes) },
        { k: 'Passengers', v: c.paxCount },
        { k: 'Misconnecting', v: c.misconnectCount },
        { k: 'Priority pax', v: c.priorityPaxCount },
        { k: 'Actual dep', v: c.actualDep ? zulu(c.actualDep) : 'not departed' },
      ];
    });

    const missedCount = computed(() =>
      (detail.value?.passengers ?? []).filter((p) => p.connectionStatus === 'missed').length);
    const atRiskCount = computed(() =>
      (detail.value?.passengers ?? []).filter((p) => p.connectionStatus === 'at_risk').length);

    const runMeta = computed(() => {
      const r = detail.value?.lastRun;
      if (!r) return 'not yet run';
      return `last run ${zulu(r.created_at)} · ${(r.retrieved_case_ids || []).length} similar cases · ${r.latency_ms ?? '?'}ms`;
    });

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

    function decideEdit(action) {
      const note = prompt('What did you change, and why?\n\nRecorded as memory — an overrule is the strongest signal in the dataset.');
      if (note === null || !note.trim()) return;
      decide(action, 'edited', { reviewer_note: note.trim(), original_rationale: action.rationale });
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

    async function askAnalyst(preset) {
      if (preset) question.value = preset;
      const q = question.value.trim();
      if (q.length < 3) { notify('warn', 'Ask a question first', ''); return; }
      asking.value = true;
      analyst.value = null;
      try {
        analyst.value = await call('/api/analyst', {
          method: 'POST',
          body: JSON.stringify({ question: q }),
        });
      } catch (err) {
        notify('error', 'Analyst failed', err.message);
      } finally {
        asking.value = false;
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

    function simPct(p) {
      const all = detail.value?.precedents ?? [];
      const worst = Math.max(...all.map((x) => x.distance), 0.0001);
      return Math.round((1 - (p.distance / worst) * 0.85) * 100);
    }

    onMounted(async () => {
      try { health.value = await call('/api/health'); } catch { health.value = null; }
      await loadCases();
    });

    return {
      view, health, clock,
      cases, loadingCases, filteredCases, caseKpis, statusFilter, statusOptions, query, filters,
      detail, caseFacts, missedCount, atRiskCount, runMeta,
      running, deciding, resolving, outcomeNotes, outcomeRating,
      memory, memoryKpis, outcomeBars, decisionBars,
      question, analyst, asking, suggestions,
      goCases, goMemory, openCase, onRowClick, onSearch, applyStatusFilter,
      runAgent, decide, decideEdit, resolveCase, askAnalyst,
      zulu, short, severity, statusSeverity, connSeverity, actionSeverity,
      precTone, confWord, simPct,
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
  ['p-iconfield', 'IconField'], ['p-inputicon', 'InputIcon'],
]) {
  if (PrimeVue[name]) app.component(tag, PrimeVue[name]);
}

app.mount('#app');
