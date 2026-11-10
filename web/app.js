import { renderTatumPanel, sourceTagFor } from './tatum-panel.js';
const API_BASE = '';

const COPY = {
  brand: 'PayCheck Sui',
  modeTest: 'TEST MODE',
  modeLive: 'LIVE MODE',
  proofLink: 'Proof',
  headline: 'One agent gets burned. Every other agent is warned.',
  inputPlaceholder: '0x... (a Sui address)',
  checkButton: 'Check',
  memorySwitchLabel: 'Shared memory',
  memoryOn: 'On',
  memoryOff: 'Off',
  memoryHintOn: 'Memory on: the agent reads what other agents reported.',
  memoryHintOff: 'Memory off: the same address, judged from the chain alone.',
  checkingStatus: 'Reading the chain and shared memory. This can take up to 30 seconds.',
  sampleBanner: 'SAMPLE DATA, server not reachable',
  verdictPay: 'pay',
  verdictCaution: 'caution',
  verdictDoNotPay: 'do not pay',
  withMemory: 'With memory',
  withoutMemory: 'Without memory',
  memoryChanged: 'Memory changed this answer. Without it: {verdict}.',
  memoryNotChanged: 'Memory did not change this answer.',
  whatToDoNext: 'What to do next:',
  evidenceTitle: 'Evidence',
  showAll: 'Show all',
  memoryCitationsTitle: 'Memory Citations',
  sharedFunder: 'Same first funder as {wallets} wallets: {address}',
  gasSponsor: 'Network fees paid by {address}',
  correlatedFunding: '{note}',
  weakLink: '{type} {address}, {note}',
  roundTrip: 'Sent money straight back to its funder {funder}',
  roundTripSecondHop: '{note}',
  memoryReport: 'Report: payment to {address} went {outcome}. Reported by {reporter}. Memory id {memoryId}',
  stoppedByMemory: 'Stopped by memory {memoryId}, reported by {reporter}, about {reportedAddress}, reached through {viaType}',
  metaCalls: 'Tatum calls: {tatumCalls}, Ankr calls: {ankrCalls}. Ankr agrees on {agree} of {checked} links.',
  metaSavedCalls: 'Memory saved {savedCalls} Tatum calls.',
  degradedMemory: 'Shared memory could not be read fully, so this answer may miss a report.',
  twoAgentTitle: 'Two-Agent Memory Relay',
  agentA: 'Agent A',
  agentAPaid: 'Paid',
  agentAWentBad: 'It went bad',
  agentAMemoryId: 'Memory id',
  whatTiesThem: 'What ties them',
  agentB: 'Agent B',
  agentBAboutToPay: 'Was about to pay',
  realGroupsFound: 'Real Sui wallet groups found',
  ordinaryWalletsStrict: 'Ordinary wallets wrongly told do not pay',
  memoryRecallChecked: 'Memory recall checked by exact address',
  benchmarkHeadPlainAi: 'Plain AI',
  benchmarkHeadPlainAiReport: 'Plain AI + report',
  benchmarkHeadChecker: 'Checker',
  benchmarkHeadCheckerMemory: 'Checker + memory',
  benchmarkRowStopped: 'Group wallets answered do not pay',
  benchmarkRowLink: 'Group wallets where the right link was named',
  benchmarkRowStrict: 'Ordinary wallets wrongly told do not pay',
  benchmarkRowIncl: 'Ordinary wallets told do not pay or caution',
  liveChangedVerdicts: 'Memories that changed an answer',
  liveMemories: 'Live memories',
  livePrescan: 'Pre-scan memories',
  liveTatumCalls: 'Tatum calls since start',
  liveNote: 'Memory counts are read back from Walrus after each start. Tatum calls are counted since this server last started.',
  proofRecountedLink: 'Every number, recounted from the saved files',
  footerText: 'Reads Sui through Tatum. Shared memory on Walrus. Not a fraud detector: red means someone reported a bad payment that reaches this address through a real link.',
  rateLimitError: 'Too many checks from your address. Try again in {seconds} seconds.',
  fallbackError: 'The check failed. Try again shortly.'
};

const SAMPLE_DATA = {
  check: {
    address: "0x0f8500ea00a3171ad047e3533b42ef8c5e261b6686cf603630b3b733cec9e6f4",
    memoryOn: true,
    verdict: "do not pay",
    code: "GROUP_BAD_OUTCOME",
    label: "do not pay",
    reason: "This wallet has a direct on-chain link (same funder, same gas sponsor or same group) to a wallet where a payment went bad (stored report).",
    nextAction: "Do not sign this payment. Review the cited memory.",
    retryable: false,
    evidence: [
      {
        kind: "link",
        type: "shared_funder",
        basis: "fact",
        address: "0x217a4e9c2b758739510f675156d4ca38a72ba14e30c977fc887a09141793dcd8",
        wallets: 2
      },
      {
        kind: "memory",
        basis: "report",
        memoryId: "uVKrZAcEnPYog1x0mLDYnDZkUmVNzDskqK4XdTOUpcU",
        outcome: "bad",
        address: "0x4c0ecb5d3a7c09dffc7dd88a8598a6e53a500487206472f0393810e192591f5b",
        reporter: "agent-a",
        origin: "agent-a",
        via: {
          type: "shared_funder",
          address: "0x217a4e9c2b758739510f675156d4ca38a72ba14e30c977fc887a09141793dcd8"
        }
      }
    ],
    memoryIds: ["uVKrZAcEnPYog1x0mLDYnDZkUmVNzDskqK4XdTOUpcU"],
    changedByMemory: true,
    changedByIds: ["uVKrZAcEnPYog1x0mLDYnDZkUmVNzDskqK4XdTOUpcU"],
    warnedBy: [
      {
        memoryId: "uVKrZAcEnPYog1x0mLDYnDZkUmVNzDskqK4XdTOUpcU",
        reporter: "agent-a",
        origin: "agent-a",
        reportedAddress: "0x4c0ecb5d3a7c09dffc7dd88a8598a6e53a500487206472f0393810e192591f5b",
        crossAddress: true,
        via: {
          type: "shared_funder",
          address: "0x217a4e9c2b758739510f675156d4ca38a72ba14e30c977fc887a09141793dcd8"
        }
      }
    ],
    withoutMemory: {
      verdict: "pay",
      code: "LINKED_NO_BAD_HISTORY",
      label: "pay, linked, no bad history"
    },
    memorySavedCalls: 0,
    memory: { used: 1, recalled: 3, recallOk: true, degraded: false },
    crossCheck: { used: true, checked: 1, agree: 1 },
    notes: ["Only the oldest 50 transactions of this wallet were read."],
    callLog: {
      tatum: { calls: 4, failed: 0, medianMs: 310 },
      ankr: { calls: 1, failed: 0, medianMs: 420 }
    },
    dataAsOfCheckpoint: 342700000,
    tookMs: 6100
  },
  stats: {
    mode: "test",
    memories: {
      live: 12,
      prescan: 200,
      test: 30,
      changedVerdicts: 3,
      pendingWrites: 0,
      failedWrites: 0,
      note: "Memory counts are read back from Walrus after each start."
    },
    prescanVerified: { recalledAndVerified: 171, of: 200 },
    paidChecks: { settled: 1, route: "plain SUI on Sui mainnet" },
    calls: {
      tatum: { calls: 57, failed: 0, medianMs: 300 },
      ankr: { calls: 9, failed: 0, medianMs: 400 }
    }
  },
  proof: {
    real: {
      recount: {
        groups: 20,
        groupsCaught: 18,
        members: 70,
        membersCaught: 57,
        controls: 20,
        controlsStrict: 0,
        controlsWithCaution: 3,
        missed: ["rs-15", "rs-20"]
      }
    },
    benchmark: {
      model: "gemini-3.1-flash-lite",
      recount: {
        cases: 30,
        memoryChanged: 18,
        columns: {
          ai: {
            stopped: 5,
            linkFound: 17,
            falseAlarmStrict: 3,
            falseAlarmIncl: 4,
            groups: 20,
            controls: 10
          },
          aiReport: {
            stopped: 18,
            linkFound: 8,
            falseAlarmStrict: 3,
            falseAlarmIncl: 5,
            groups: 20,
            controls: 10
          },
          checker: {
            stopped: 0,
            linkFound: 18,
            falseAlarmStrict: 0,
            falseAlarmIncl: 1,
            groups: 20,
            controls: 10
          },
          memory: {
            stopped: 18,
            linkFound: 18,
            falseAlarmStrict: 0,
            falseAlarmIncl: 1,
            groups: 20,
            controls: 10
          }
        }
      }
    },
    prescan: { recalledAndVerified: 171, of: 200 }
  },
  crossAgent: {
    agentA: {
      id: "Agent A",
      address: "0x4c0ecb5d3a7c09dffc7dd88a8598a6e53a500487206472f0393810e192591f5b",
      memoryId: "uVKrZAcEnPYog1x0mLDYnDZkUmVNzDskqK4XdTOUpcU"
    },
    link: {
      type: "shared_funder",
      address: "0x217a4e9c2b758739510f675156d4ca38a72ba14e30c977fc887a09141793dcd8"
    },
    agentB: {
      id: "Agent B",
      address: "0x0f8500ea00a3171ad047e3533b42ef8c5e261b6686cf603630b3b733cec9e6f4",
      check: {
        verdict: "do not pay",
        code: "GROUP_BAD_OUTCOME",
        warnedBy: [
          {
            memoryId: "uVKrZAcEnPYog1x0mLDYnDZkUmVNzDskqK4XdTOUpcU",
            reporter: "agent-a"
          }
        ],
        withoutMemory: {
          verdict: "pay",
          label: "pay, linked, no bad history"
        }
      }
    }
  }
};

let currentMemoryState = 'on';
let currentCheckResult = null;
let crossAgentData = null;
let showAllEvidence = false;
let isSampleCheck = false;
let isSampleCrossAgent = false;
let isSampleProofOrStats = false;

function formatAddress(addr) {
  if (!addr) return '';
  if (addr.length <= 18) return addr;
  return addr.substring(0, 10) + '...' + addr.substring(addr.length - 6);
}

function shortId(id) {
  if (!id || id.length <= 14) return id || '';
  return id.substring(0, 6) + '...' + id.substring(id.length - 4);
}

function createAddressSpan(addr) {
  const span = document.createElement('span');
  span.className = 'mono-address';
  span.title = addr;
  span.textContent = formatAddress(addr);
  return span;
}

function getVerdictClass(verdict) {
  const v = (verdict || '').toLowerCase().trim();
  if (v === 'pay') return 'verdict-chip-pay';
  if (v === 'caution') return 'verdict-chip-caution';
  return 'verdict-chip-danger';
}

function setMemorySwitch(state) {
  currentMemoryState = state;
  const onBtn = document.getElementById('memory-on-btn');
  const offBtn = document.getElementById('memory-off-btn');
  const hint = document.getElementById('memory-hint');

  if (state === 'on') {
    onBtn.classList.add('active');
    onBtn.setAttribute('aria-pressed', 'true');
    offBtn.classList.remove('active');
    offBtn.setAttribute('aria-pressed', 'false');
    hint.textContent = COPY.memoryHintOn;
  } else {
    offBtn.classList.add('active');
    offBtn.setAttribute('aria-pressed', 'true');
    onBtn.classList.remove('active');
    onBtn.setAttribute('aria-pressed', 'false');
    hint.textContent = COPY.memoryHintOff;
  }

  if (currentCheckResult) {
    renderVerdictCard(currentCheckResult);
  }
  if (crossAgentData) {
    renderCrossAgentCard(crossAgentData, isSampleCrossAgent);
  }
}

function renderEvidenceItem(item) {
  const li = document.createElement('li');
  li.className = 'evidence-row';

  const basisSpan = document.createElement('span');
  basisSpan.className = 'basis-tag';
  basisSpan.textContent = (item.basis || 'FACT').toUpperCase();
  li.appendChild(basisSpan);

  const textWrap = document.createElement('span');

  const kind = item.kind;
  const type = item.type;

  if (kind === 'link' && type === 'shared_funder') {
    textWrap.append('Same first funder as ' + (item.wallets != null ? item.wallets : '') + ' wallets: ');
    textWrap.appendChild(createAddressSpan(item.address));
  } else if (kind === 'link' && type === 'gas_sponsor') {
    textWrap.append('Network fees paid by ');
    textWrap.appendChild(createAddressSpan(item.address));
  } else if (kind === 'link' && type === 'correlated_funding') {
    textWrap.textContent = item.note || '';
  } else if (kind === 'weak_link') {
    textWrap.append((type || '') + ' ');
    if (item.address) {
      textWrap.appendChild(createAddressSpan(item.address));
      textWrap.append(', ');
    }
    textWrap.append(item.note || '');
  } else if (kind === 'round_trip') {
    textWrap.append('Sent money straight back to its funder ');
    textWrap.appendChild(createAddressSpan(item.funder));
  } else if (kind === 'round_trip_second_hop') {
    textWrap.textContent = item.note || '';
  } else if (kind === 'memory') {
    textWrap.append('Report: payment to ');
    textWrap.appendChild(createAddressSpan(item.address));
    textWrap.append(' went ' + (item.outcome || '') + '. Reported by ' + (item.reporter || '') + '. Memory id ' + (item.memoryId || ''));
  } else {
    textWrap.textContent = item.note || item.reason || JSON.stringify(item);
  }

  if (item.digest) {
    textWrap.append(' ');
    const txLink = document.createElement('a');
    txLink.href = 'https://suiscan.xyz/mainnet/tx/' + encodeURIComponent(item.digest);
    txLink.target = '_blank';
    txLink.rel = 'noopener noreferrer';
    txLink.textContent = '[Tx]';
    textWrap.appendChild(txLink);
  }

  const src = sourceTagFor(item);
  if (src) {
    const tag = document.createElement('span');
    tag.className = 'source-tag';
    tag.textContent = 'Source: ' + src;
    textWrap.appendChild(tag);
  }
  li.appendChild(textWrap);
  return li;
}

function renderVerdictCard(data) {
  const card = document.getElementById('verdict-card');
  const errorCard = document.getElementById('error-card');
  const sampleBanner = document.getElementById('sample-banner');
  const verdictSampleBanner = document.getElementById('verdict-sample-banner');

  errorCard.classList.add('hidden');
  card.classList.remove('hidden');

  if (isSampleCheck) {
    if (sampleBanner) sampleBanner.classList.remove('hidden');
    if (verdictSampleBanner) {
      verdictSampleBanner.classList.remove('hidden');
      const badge = verdictSampleBanner.querySelector('.sample-badge');
      if (badge) badge.textContent = COPY.sampleBanner;
    }
  } else {
    if (sampleBanner) sampleBanner.classList.add('hidden');
    if (verdictSampleBanner) verdictSampleBanner.classList.add('hidden');
  }

  const isMemOn = currentMemoryState === 'on';

  const displayedVerdict = isMemOn ? data.verdict : (data.withoutMemory ? data.withoutMemory.verdict : data.verdict);
  const displayedReason = isMemOn ? data.reason : (data.withoutMemory && data.withoutMemory.label ? data.withoutMemory.label : data.reason);

  const mainChip = document.getElementById('main-verdict-chip');
  mainChip.textContent = displayedVerdict;
  mainChip.className = 'verdict-chip ' + getVerdictClass(displayedVerdict);

  document.getElementById('main-verdict-reason').textContent = displayedReason || '';

  const colWith = document.getElementById('col-with-memory');
  const colWithout = document.getElementById('col-without-memory');
  const colWithVerdict = document.getElementById('col-with-memory-verdict');
  const colWithoutVerdict = document.getElementById('col-without-memory-verdict');

  colWithVerdict.textContent = data.verdict;
  colWithoutVerdict.textContent = data.withoutMemory ? data.withoutMemory.verdict : '...';

  if (isMemOn) {
    colWith.classList.add('outlined');
    colWithout.classList.remove('outlined');
  } else {
    colWithout.classList.add('outlined');
    colWith.classList.remove('outlined');
  }

  const memoryChangedLine = document.getElementById('memory-changed-line');
  if (data.changedByMemory) {
    const withoutV = data.withoutMemory ? data.withoutMemory.verdict : '';
    memoryChangedLine.textContent = COPY.memoryChanged.replace('{verdict}', withoutV);
  } else {
    memoryChangedLine.textContent = COPY.memoryNotChanged;
  }

  document.getElementById('next-action-text').textContent = data.nextAction || '...';

  const evidenceList = document.getElementById('evidence-list');
  evidenceList.innerHTML = '';
  const evidence = data.evidence || [];
  const limit = showAllEvidence ? evidence.length : Math.min(8, evidence.length);

  for (let i = 0; i < limit; i++) {
    evidenceList.appendChild(renderEvidenceItem(evidence[i]));
  }

  const showAllBtn = document.getElementById('evidence-show-all-btn');
  if (evidence.length > 8 && !showAllEvidence) {
    showAllBtn.classList.remove('hidden');
  } else {
    showAllBtn.classList.add('hidden');
  }

  const warnedBlock = document.getElementById('warned-by-block');
  const warnedList = document.getElementById('warned-by-list');
  warnedList.innerHTML = '';
  const warnedBy = data.warnedBy || [];

  if (warnedBy.length > 0) {
    warnedBlock.classList.remove('hidden');
    warnedBy.forEach(w => {
      const li = document.createElement('li');
      li.className = 'citation-row';
      const viaType = (w.via && w.via.type) ? w.via.type : 'link';
      const line = document.createElement('span');
      line.append('Stopped by memory ' + (w.memoryId || '') + ', reported by ' + (w.reporter || '') + ', about ');
      line.appendChild(createAddressSpan(w.reportedAddress));
      line.append(', reached through ' + viaType);
      li.appendChild(line);
      warnedList.appendChild(li);
    });
  } else {
    warnedBlock.classList.add('hidden');
  }

  const tatumCalls = (data.callLog && data.callLog.tatum && data.callLog.tatum.calls != null) ? data.callLog.tatum.calls : 0;
  const ankrCalls = (data.callLog && data.callLog.ankr && data.callLog.ankr.calls != null) ? data.callLog.ankr.calls : 0;
  const agree = (data.crossCheck && data.crossCheck.agree != null) ? data.crossCheck.agree : 0;
  const checked = (data.crossCheck && data.crossCheck.checked != null) ? data.crossCheck.checked : 0;

  let metaText = COPY.metaCalls
    .replace('{tatumCalls}', tatumCalls)
    .replace('{ankrCalls}', ankrCalls)
    .replace('{agree}', agree)
    .replace('{checked}', checked);

  if (data.memorySavedCalls && data.memorySavedCalls > 0) {
    metaText += ' ' + COPY.metaSavedCalls.replace('{savedCalls}', data.memorySavedCalls);
  }
  document.getElementById('verdict-stats-line').textContent = metaText;
  renderTatumPanel(data);

  const degradedLine = document.getElementById('verdict-degraded-line');
  if (data.memory && data.memory.degraded) {
    degradedLine.classList.remove('hidden');
  } else {
    degradedLine.classList.add('hidden');
  }

  const notesList = document.getElementById('verdict-notes-list');
  notesList.innerHTML = '';
  if (data.notes && Array.isArray(data.notes)) {
    data.notes.forEach(note => {
      const p = document.createElement('p');
      p.className = 'meta-line';
      p.textContent = note;
      notesList.appendChild(p);
    });
  }
}

function showError(msg) {
  const card = document.getElementById('verdict-card');
  const errorCard = document.getElementById('error-card');
  const errorText = document.getElementById('error-text');

  card.classList.add('hidden');
  errorText.textContent = msg;
  errorCard.classList.remove('hidden');
}

function renderCrossAgentCard(data, isSample = false) {
  const card = document.getElementById('two-agent-card');
  const banner = document.getElementById('cross-agent-sample-banner');
  if (!data || data.available === false) {
    card.classList.add('hidden');
    if (banner) banner.classList.add('hidden');
    return;
  }
  card.classList.remove('hidden');
  if (banner) {
    if (isSample) {
      banner.classList.remove('hidden');
      const badge = banner.querySelector('.sample-badge');
      if (badge) badge.textContent = COPY.sampleBanner;
    } else {
      banner.classList.add('hidden');
    }
  }

  const addrA = document.getElementById('agent-a-address');
  addrA.textContent = formatAddress(data.agentA.address);
  addrA.title = data.agentA.address;

  const memA = document.getElementById('agent-a-memory-id');
  memA.textContent = shortId(data.agentA.memoryId);
  memA.title = data.agentA.memoryId;

  const tieType = document.getElementById('tie-type');
  const tieLabels = { funder: 'First funder', gas_sponsor: 'Gas sponsor' };
  const tieKinds = [];
  ((data.links && data.links.length) ? data.links : (data.link ? [data.link] : [])).forEach((l) => {
    const label = tieLabels[l.type] || l.type || 'link';
    if (tieKinds.indexOf(label) === -1) tieKinds.push(label);
  });
  tieType.innerHTML = '';
  tieKinds.forEach((label) => {
    const pill = document.createElement('span');
    pill.className = 'pill';
    pill.textContent = label;
    tieType.appendChild(pill);
  });

  const tieAddr = document.getElementById('tie-address');
  tieAddr.textContent = formatAddress(data.link ? data.link.address : '');
  tieAddr.title = data.link ? data.link.address : '';

  const addrB = document.getElementById('agent-b-address');
  addrB.textContent = formatAddress(data.agentB.address);
  addrB.title = data.agentB.address;

  const refusalBox = document.getElementById('agent-b-refusal');
  const refusalId = document.getElementById('agent-b-memory-id');
  if (refusalBox && refusalId) {
    if (data.agentB.refusalMemoryId) {
      refusalId.textContent = shortId(data.agentB.refusalMemoryId);
      refusalId.title = data.agentB.refusalMemoryId;
      refusalBox.classList.remove('hidden');
    } else {
      refusalBox.classList.add('hidden');
    }
  }

  const isMemOn = currentMemoryState === 'on';
  const chipB = document.getElementById('agent-b-chip');

  let verdictB = 'caution';
  if (data.agentB && data.agentB.check) {
    if (isMemOn) {
      verdictB = data.agentB.check.verdict;
    } else {
      verdictB = (data.agentB.check.withoutMemory && data.agentB.check.withoutMemory.verdict)
        ? data.agentB.check.withoutMemory.verdict
        : data.agentB.check.verdict;
    }
  }

  chipB.textContent = verdictB.charAt(0).toUpperCase() + verdictB.slice(1);
  chipB.className = 'verdict-chip-sm ' + getVerdictClass(verdictB);
}

function renderProofAndStats(proof, stats, isSample = false) {
  const numbersBanner = document.getElementById('numbers-sample-banner');
  if (numbersBanner) {
    if (isSample) {
      numbersBanner.classList.remove('hidden');
      const badge = numbersBanner.querySelector('.sample-badge');
      if (badge) badge.textContent = COPY.sampleBanner;
    } else {
      numbersBanner.classList.add('hidden');
    }
  }

  if (proof && proof.real && proof.real.recount) {
    const rc = proof.real.recount;
    setFigure('stat-groups-caught', rc.groupsCaught + ' of ' + rc.groups);
    setFigure('stat-controls-strict', rc.controlsStrict + ' of ' + rc.controls);
  }

  if (proof && proof.prescan) {
    setFigure('stat-prescan-verified', proof.prescan.recalledAndVerified + ' of ' + proof.prescan.of);
  } else if (stats && stats.prescanVerified) {
    setFigure('stat-prescan-verified', stats.prescanVerified.recalledAndVerified + ' of ' + stats.prescanVerified.of);
  }

  if (proof && proof.benchmark && proof.benchmark.recount && proof.benchmark.recount.columns) {
    const cols = proof.benchmark.recount.columns;
    const colKeys = ['ai', 'aiReport', 'checker', 'memory'];

    colKeys.forEach(key => {
      const col = cols[key];
      if (col) {
        const stoppedEl = document.getElementById('table-stopped-' + key);
        if (stoppedEl) stoppedEl.textContent = col.stopped + ' of ' + col.groups;

        const linkEl = document.getElementById('table-link-' + key);
        if (linkEl) linkEl.textContent = col.linkFound + ' of ' + col.groups;

        const strictEl = document.getElementById('table-strict-' + key);
        if (strictEl) strictEl.textContent = col.falseAlarmStrict + ' of ' + col.controls;

        const inclEl = document.getElementById('table-incl-' + key);
        if (inclEl) inclEl.textContent = col.falseAlarmIncl + ' of ' + col.controls;
      }
    });
  }

  if (stats) {
    const modeBadge = document.getElementById('mode-badge');
    if (stats.mode === 'live') {
      modeBadge.textContent = COPY.modeLive;
      modeBadge.classList.add('live');
    } else {
      modeBadge.textContent = COPY.modeTest;
      modeBadge.classList.remove('live');
    }

    if (stats.memories) {
      document.getElementById('live-changed-verdicts').textContent = stats.memories.changedVerdicts != null ? stats.memories.changedVerdicts : '...';
      document.getElementById('live-memories').textContent = stats.memories.live != null ? stats.memories.live : '...';
      document.getElementById('live-prescan').textContent = stats.memories.prescan != null ? stats.memories.prescan : '...';
      const note = document.getElementById('counter-note');
      if (note) {
        if (!note.dataset.base) note.dataset.base = note.textContent;
        const u = stats.memories.unlabelled;
        note.textContent = note.dataset.base + (u > 0 ? ' Right now ' + u + ' listed note' + (u === 1 ? ' is' : 's are') + ' not labelled yet.' : '');
      }
    }

    if (stats.calls && stats.calls.tatum) {
      document.getElementById('live-tatum-calls').textContent = stats.calls.tatum.calls != null ? stats.calls.tatum.calls : '...';
    }
  }
}

// Latest shared warnings: who reported, when, and the memory id. Read only. Text goes in with textContent.
function whenText(iso) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return 'time not recorded';
  const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (mins < 60) return mins <= 1 ? 'just now' : mins + ' minutes ago';
  if (mins < 60 * 48) { const h = Math.round(mins / 60); return h + (h === 1 ? ' hour ago' : ' hours ago'); }
  return new Date(t).toISOString().slice(0, 10);
}

function setFigure(id, text) {
  const el = document.getElementById(id);
  if (!el) return;
  const m = /^(\d+)( of .+)$/.exec(String(text));
  el.textContent = '';
  if (!m) { el.textContent = text; return; }
  el.appendChild(document.createTextNode(m[1]));
  const of = document.createElement('span');
  of.className = 'fig-of';
  of.textContent = m[2];
  el.appendChild(of);
}

function reporterName(r) {
  const m = /^agent-([a-z])$/i.exec(r || '');
  return m ? 'Agent ' + m[1].toUpperCase() : (r || 'An agent');
}

function renderWarnings(data) {
  const box = document.getElementById('warnings-feed');
  const list = document.getElementById('warnings-list');
  if (!box || !list) return;
  list.innerHTML = '';
  const items = data && Array.isArray(data.warnings) ? data.warnings : [];
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'warnings-empty';
    li.textContent = data && data.state === 'ok' ? 'No bad payments reported yet.' : 'Reading shared memory...';
    list.appendChild(li);
    return;
  }
  const seen = new Set();
  items.forEach((w) => {
    if (w.reportedAddress) {
      if (seen.has(w.reportedAddress)) return;
      seen.add(w.reportedAddress);
    }
    if (seen.size > 4) return;
    const li = document.createElement('li');
    li.className = 'warnings-row';
    if (w.memoryId) li.title = 'Memory id ' + w.memoryId;
    const who = document.createElement('strong');
    who.textContent = reporterName(w.reporter);
    li.appendChild(who);
    li.append(' reported' + (w.reportedAddress ? ' ' : ' a bad payment'));
    if (w.reportedAddress) {
      const a = document.createElement('span');
      a.className = 'mono-address';
      a.title = w.reportedAddress;
      a.textContent = w.reportedAddress.substring(0, 8) + '...' + w.reportedAddress.substring(w.reportedAddress.length - 4);
      li.appendChild(a);
    }
    li.append(' · ' + whenText(w.reportedAt));
    list.appendChild(li);
  });
}

async function fetchWarnings() {
  try {
    const res = await fetch(API_BASE + '/api/warnings');
    if (!res.ok) throw new Error('bad status');
    renderWarnings(await res.json());
  } catch {
    const box = document.getElementById('warnings-feed');
    if (box) box.classList.add('hidden');
  }
}

async function fetchStats() {
  try {
    const res = await fetch(API_BASE + '/api/stats');
    if (res.ok) {
      const data = await res.json();
      isSampleProofOrStats = false;
      renderProofAndStats(null, data, false);
      return data;
    }
  } catch (err) {
    // server unreachable
  }
  return null;
}

async function fetchProof() {
  try {
    const res = await fetch(API_BASE + '/api/proof');
    if (res.ok) {
      const data = await res.json();
      isSampleProofOrStats = false;
      renderProofAndStats(data, null, false);
      return data;
    }
  } catch (err) {
    // server unreachable
  }
  return null;
}

async function fetchCrossAgent() {
  try {
    const res = await fetch(API_BASE + '/api/cross-agent');
    if (res.ok) {
      const data = await res.json();
      crossAgentData = data;
      isSampleCrossAgent = false;
      renderCrossAgentCard(data, false);
      return data;
    }
  } catch (err) {
    // server unreachable
  }
  return null;
}

async function doCheck(address) {
  if (!address) return;
  const statusEl = document.getElementById('status-message');
  const btn = document.getElementById('check-button');

  btn.disabled = true;
  statusEl.classList.remove('hidden');
  showAllEvidence = false;

  try {
    const res = await fetch(API_BASE + '/api/check?address=' + encodeURIComponent(address) + '&memory=' + currentMemoryState);
    if (res.status === 429) {
      const retryAfter = res.headers.get('Retry-After') || '60';
      showError(COPY.rateLimitError.replace('{seconds}', retryAfter));
      return;
    }
    if (!res.ok) {
      let errBody;
      try {
        errBody = await res.json();
      } catch (e) {
        errBody = null;
      }
      const msg = (errBody && (errBody.error || errBody.reason)) ? (errBody.error || errBody.reason) : COPY.fallbackError;
      showError(msg);
      return;
    }
    const data = await res.json();
    isSampleCheck = false;
    currentCheckResult = data;
    renderVerdictCard(data);
  } catch (err) {
    // server not reachable -> show sample data with clear amber label
    isSampleCheck = true;
    currentCheckResult = Object.assign({}, SAMPLE_DATA.check, { address });
    renderVerdictCard(currentCheckResult);
  } finally {
    btn.disabled = false;
    statusEl.classList.add('hidden');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const onBtn = document.getElementById('memory-on-btn');
  const offBtn = document.getElementById('memory-off-btn');
  const form = document.getElementById('check-form');
  const input = document.getElementById('address-input');
  const showAllBtn = document.getElementById('evidence-show-all-btn');

  // One-click example: the wallet Agent B was about to pay in the saved two-agent run.
  fetch(API_BASE + '/api/cross-agent').then((r) => (r.ok ? r.json() : null)).then((d) => {
    const addr = d && d.agentB && d.agentB.address;
    if (!addr) return;
    document.getElementById('try-example').classList.remove('hidden');
    document.getElementById('try-example-btn').addEventListener('click', () => { input.value = addr; setMemorySwitch('on'); doCheck(addr); });
  }).catch(() => {});

  onBtn.addEventListener('click', () => setMemorySwitch('on'));
  offBtn.addEventListener('click', () => setMemorySwitch('off'));

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const addr = input.value.trim();
    if (addr) {
      doCheck(addr);
    }
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const addr = input.value.trim();
      if (addr) {
        doCheck(addr);
      }
    }
  });

  showAllBtn.addEventListener('click', () => {
    showAllEvidence = true;
    if (currentCheckResult) {
      renderVerdictCard(currentCheckResult);
    }
  });

  // Initial loads
  Promise.all([fetchStats(), fetchProof(), fetchCrossAgent()]).then(([s, p, c]) => {
    const topBanner = document.getElementById('top-sample-banner');
    if (!s || !p || !c) {
      if (topBanner) {
        topBanner.classList.remove('hidden');
        const badge = topBanner.querySelector('.sample-badge');
        if (badge) badge.textContent = COPY.sampleBanner;
      }
    } else {
      if (topBanner) topBanner.classList.add('hidden');
    }

    if (!s && !p) {
      // Use sample data for stats & proof & cross-agent
      isSampleProofOrStats = true;
      renderProofAndStats(SAMPLE_DATA.proof, SAMPLE_DATA.stats, true);
    } else if (!s) {
      isSampleProofOrStats = true;
      renderProofAndStats(null, SAMPLE_DATA.stats, true);
    } else if (!p) {
      isSampleProofOrStats = true;
      renderProofAndStats(SAMPLE_DATA.proof, null, true);
    }

    if (!c) {
      crossAgentData = SAMPLE_DATA.crossAgent;
      isSampleCrossAgent = true;
      renderCrossAgentCard(SAMPLE_DATA.crossAgent, true);
    }
  });

  fetchWarnings();

  // Refresh live counters every 15 seconds
  setInterval(() => {
    fetchStats();
    fetchWarnings();
  }, 15000);
});
