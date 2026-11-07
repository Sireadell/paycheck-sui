// First screen. Reads only the endpoints in docs/API.md. All reader-facing words come from copy.json.
const $ = (id) => document.getElementById(id);
const state = { copy: null, memoryOn: true, panel: null, result: null };

const fill = (s, vars = {}) => String(s).replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ''));
const t = (path, vars) => fill(path.split('.').reduce((o, k) => o?.[k], state.copy) ?? '', vars);
const short = (a) => (a && a.length > 20 ? `${a.slice(0, 8)}...${a.slice(-6)}` : a ?? '');
const chipClass = (v) => (v === 'pay' ? 'pay' : v === 'do not pay' ? 'dnp' : 'caution');
const getJson = async (url) => {
  try { const r = await fetch(url); return r.ok ? await r.json() : null; } catch { return null; }
};
const setChip = (el, verdict) => { el.textContent = verdict ?? ''; el.className = `chip ${chipClass(verdict)}`; };

function renderStatic() {
  document.querySelectorAll('[data-copy]').forEach((el) => { el.textContent = t(el.dataset.copy); });
  const list = $('limits-list');
  list.replaceChildren(...state.copy.limits.items.map((txt) => Object.assign(document.createElement('li'), { textContent: txt })));
}

function renderMode(stats) {
  const badge = $('mode-badge');
  if (!stats) { badge.hidden = true; return; }
  const test = stats.mode !== 'live';
  badge.hidden = false;
  badge.textContent = test ? t('testBadge') : t('liveBadge');
  badge.classList.toggle('live', !test);
  const note = $('test-note');
  note.hidden = !test;
  note.textContent = test ? t('testNote') : '';
}

function renderSwitch() {
  $('sw-on').setAttribute('aria-pressed', String(state.memoryOn));
  $('sw-off').setAttribute('aria-pressed', String(!state.memoryOn));
  $('switch-hint').textContent = t(state.memoryOn ? 'switch.hintOn' : 'switch.hintOff');
  renderPanel();
  renderResultFocus();
}

function renderPanel() {
  const d = state.panel;
  if (!d) return;
  const placeholder = d.placeholder === true;
  const c = d.agentB.check ?? {};
  const tag = $('panel-tag');
  tag.textContent = t(placeholder ? 'panel.placeholderBadge' : 'panel.liveBadge');
  tag.classList.toggle('real', !placeholder);
  const note = $('panel-note');
  note.textContent = placeholder ? t('panel.placeholderNote') : t('panel.liveNote', { when: d.ranAt ?? d.agentA.reportedAt ?? '' });
  note.classList.toggle('real', !placeholder);

  $('a-tell').textContent = t('panel.agentATell', { address: short(d.agentA.address) });
  $('a-mem').textContent = d.agentA.memoryId ? t('panel.memoryId', { id: d.agentA.memoryId }) : '';
  $('link-text').textContent = t(d.link?.type === 'gas_sponsor' ? 'panel.linkGasSponsor' : 'panel.linkFunder', { address: short(d.link?.address) });
  $('b-tell').textContent = t('panel.agentBTell', { address: short(d.agentB.address) });

  const warn = c.warnedBy?.[0];
  if (state.memoryOn) {
    setChip($('b-chip'), c.verdict);
    $('b-why').textContent = warn
      ? `${t('panel.stoppedOn')} ${t('panel.stoppedBy', { id: warn.memoryId, who: warn.reporter ?? d.agentA.id })}`
      : (c.reason ?? '');
  } else {
    const off = c.withoutMemory ?? {};
    setChip($('b-chip'), off.verdict);
    $('b-why').textContent = off.verdict === 'pay' ? t('panel.wouldHavePaid') : (off.label ?? '');
  }

  const btn = $('run-live');
  btn.textContent = t('panel.runLive');
  btn.disabled = placeholder;
  $('run-live-note').textContent = placeholder ? t('panel.runLiveDisabled') : '';
  $('shared-account').textContent = d.sharedAccount === false ? '' : t('panel.sharedAccount');
}

function renderCounters(s) {
  if (!s) return;
  const m = s.memories;
  $('changed-big').textContent = t('counters.changedLine', { n: m.changedVerdicts });
  $('total-line').textContent = t('counters.totalLine', { n: m.live + m.prescan });
  $('live-line').textContent = t('counters.liveLine', { n: m.live });
  $('prescan-line').textContent = t('counters.prescanLine', { n: m.prescan });
  $('test-line').textContent = t('counters.testLine', { n: m.test });
}

function renderBench(b) {
  const r = b?.real;
  if (!r) {
    $('real-n').textContent = '';
    $('real-detail').textContent = t('bench.missing');
  } else {
    $('real-n').textContent = t('bench.realHeadline', { caught: r.caught, groups: r.groups });
    $('real-detail').textContent = t('bench.realDetail', { membersCaught: r.membersCaught, members: r.members });
    $('ctl-strict').textContent = t('bench.controlsStrict', { n: r.falseAlarmsStrict, controls: r.controls });
    $('ctl-loose').textContent = t('bench.controlsLoose', { n: r.falseAlarmsWithCaution, controls: r.controls });
    $('bench-ran').textContent = t('bench.ranAt', { when: r.ranAt?.replace('T', ' ').slice(0, 16) + ' UTC' });
  }
  renderColumns(b?.columns);
  const st = b?.stress;
  $('stress-n').textContent = st ? t('bench.stressHeadline', { caught: st.caught, total: st.total }) : '';
  $('stress-note').textContent = st ? '' : t('bench.stressNone');
}

function renderColumns(c) {
  const table = $('cols-table');
  const losses = $('losses');
  losses.replaceChildren(...state.copy.bench.losses.map((x) => {
    const li = document.createElement('li');
    const id = Object.assign(document.createElement('strong'), { textContent: x.id });
    li.append(id, ' ', x.text);
    return li;
  }));
  if (!c) { $('cols-lead').textContent = t('bench.columnsMissing'); table.replaceChildren(); return; }
  $('cols-lead').textContent = t('bench.columnsLead', { groups: c.groups, controls: c.controls, model: c.model });
  const keys = ['ai', 'aiReport', 'checker', 'memory'];
  const rows = [
    ['stopped', (x) => `${x.stopped} of ${c.groups}`],
    ['linkFound', (x) => `${x.linkFound} of ${c.groups}`],
    ['controlsStrict', (x) => `${x.falseAlarmStrict} of ${c.controls}`],
    ['controlsLoose', (x) => `${x.falseAlarmIncl} of ${c.controls}`],
  ];
  const tr = (cells, tag) => { const r = document.createElement('tr'); cells.forEach((v) => r.append(Object.assign(document.createElement(tag), { textContent: v }))); return r; };
  const head = document.createElement('thead');
  head.append(tr(['', ...keys.map((k) => t(`bench.columnHeads.${k}`))], 'th'));
  const body = document.createElement('tbody');
  for (const [name, f] of rows) {
    const r = tr([t(`bench.columnRows.${name}`), ...keys.map((k) => f(c[k]))], 'td');
    r.firstChild.className = 'rowname';
    body.append(r);
  }
  table.replaceChildren(head, body);
}

function renderResultFocus() {
  $('col-on').classList.toggle('active', state.memoryOn);
  $('col-off').classList.toggle('active', !state.memoryOn);
}

function renderResult(r) {
  state.result = r;
  $('check-result').hidden = false;
  setChip($('chip-on'), r.verdict);
  $('reason-on').textContent = r.reason ?? '';
  const off = r.withoutMemory ?? {};
  setChip($('chip-off'), off.verdict);
  $('reason-off').textContent = off.label ?? '';
  $('changed-line').textContent = r.changedByMemory
    ? t('check.changed', { was: off.verdict })
    : t('check.notChanged');
  const ev = $('evidence');
  const rows = (r.evidence ?? []).slice(0, 6).map((e) => {
    const li = document.createElement('li');
    const b = document.createElement('span');
    b.className = 'basis';
    b.textContent = t(`check.basis${(e.basis ?? 'fact')[0].toUpperCase()}${(e.basis ?? 'fact').slice(1)}`) || e.basis;
    const label = [String(e.type ?? e.kind ?? '').replaceAll('_', ' '), short(e.address), e.note].filter(Boolean).join(', ');
    li.append(b, document.createTextNode(label));
    return li;
  });
  if (!rows.length) rows.push(Object.assign(document.createElement('li'), { textContent: t('check.noEvidence') }));
  ev.replaceChildren(...rows);
  const tat = r.callLog?.tatum?.calls ?? 0;
  const ank = r.callLog?.ankr?.calls ?? 0;
  const cc = r.crossCheck;
  $('call-line').textContent = `${t('check.callLine', { tatum: tat, ankr: ank })} ${cc?.checked ? t('check.agreeLine', { agree: cc.agree, checked: cc.checked }) : t('check.agreeNone')}`;
  renderResultFocus();
}

async function runCheck(address) {
  const status = $('check-status');
  const btn = $('check-btn');
  btn.disabled = true;
  status.textContent = t('check.working');
  try {
    const res = await fetch(`/api/check?address=${encodeURIComponent(address.trim())}&memory=on`);
    const body = await res.json().catch(() => ({}));
    if (res.status === 429) { status.textContent = t('check.limited'); return; }
    if (!res.ok && !body.verdict) { status.textContent = t('check.failed', { why: body.error ?? res.status }); return; }
    status.textContent = '';
    renderResult(body);
  } catch (e) {
    status.textContent = t('check.failed', { why: String(e.message || e) });
  } finally { btn.disabled = false; }
}

async function init() {
  state.copy = await (await fetch('copy.json')).json();
  renderStatic();
  $('sw-on').addEventListener('click', () => { state.memoryOn = true; renderSwitch(); });
  $('sw-off').addEventListener('click', () => { state.memoryOn = false; renderSwitch(); });
  $('check-form').addEventListener('submit', (e) => { e.preventDefault(); if ($('addr').value.trim()) runCheck($('addr').value); });

  const [stats, bench, live, sample] = await Promise.all([getJson('/api/stats'), getJson('/api/benchmark'), getJson('/api/cross-agent'), getJson('sample.json')]);
  state.panel = live?.agentB ? live : sample;
  renderMode(stats);
  renderCounters(stats);
  renderBench(bench);
  const pick = bench?.real?.suggested;
  if (pick) {
    $('addr').value = pick.address;
    $('prefill-note').textContent = t('check.prefillNote', { id: pick.id, how: t(pick.type === 'gas_sponsor' ? 'check.howSponsor' : 'check.howFunder') });
  }
  $('addr').placeholder = t('check.placeholder');
  renderSwitch();
  setInterval(async () => { const s = await getJson('/api/stats'); renderMode(s); renderCounters(s); }, 15000);
}
init();
