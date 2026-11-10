// "What Tatum read for this check": the real calls this check made, and what the wallet and its funder hold.
// All text goes in with textContent. Nothing here changes the verdict; it is evidence beside it.
const CALL_WORDS = {
  listTransactions: 'wallet history pages',
  addressProfile: 'address type and balance',
  latestCheckpoint: 'data-as-of label',
  walletSnapshot: 'holdings (coins, objects, name)',
  referenceGasPrice: 'network fee now',
  transactionByDigest: 'payment read-back',
  exchangeRate: 'SUI price',
};

// Where a piece of evidence came from, in plain words. Wording only: it never changes what is shown or decided.
export const SOURCE = { tatum: 'read from Tatum', report: 'from a saved report on Walrus Memory', worked: 'worked out by us from Tatum history', ankr: 'checked against Ankr' };
const EVIDENCE_SOURCE = { memory: 'report', link: 'tatum', round_trip: 'tatum', weak_link: 'worked', correlated_funding: 'worked', round_trip_second_hop: 'worked' };
export function sourceTagFor(item) { return SOURCE[EVIDENCE_SOURCE[item && item.kind]] || null; }

const short = (a) => (a ? a.slice(0, 8) + '...' + a.slice(-6) : '');

function suiOf(s) {
  const c = (s.coins || []).find((x) => /::sui::SUI$/.test(x.coinType || ''));
  if (!c) return null;
  const n = Number(c.balance) / 1e9;
  return (n >= 100 ? n.toFixed(0) : n.toFixed(3)) + ' SUI';
}

function holdingsText(s) {
  if (!s) return 'could not be read';
  const bits = [];
  const sui = suiOf(s);
  bits.push(sui ? sui : 'no SUI');
  const others = (s.coins || []).filter((x) => !/::sui::SUI$/.test(x.coinType || '')).length;
  bits.push(others ? others + ' other coin type' + (others === 1 ? '' : 's') : 'no other coins');
  const more = s.objectsMore ? '+' : '';
  bits.push(s.objects + more + ' object' + (s.objects === 1 && !more ? '' : 's') + (s.otherObjects ? ' (' + s.otherObjects + ' not coins)' : ''));
  if (s.name) bits.push('name ' + s.name);
  return bits.join(', ');
}

function row(label, value, source) {
  const li = document.createElement('li');
  const b = document.createElement('strong');
  b.textContent = label + ' ';
  li.appendChild(b);
  li.appendChild(document.createTextNode(value));
  if (source) {
    const tag = document.createElement('span');
    tag.className = 'source-tag';
    tag.textContent = 'Source: ' + SOURCE[source];
    li.appendChild(tag);
  }
  return li;
}

function ageText(days) {
  if (days == null) return null;
  if (days < 1) return 'first seen today';
  if (days < 60) return 'first seen ' + days + ' day' + (days === 1 ? '' : 's') + ' ago';
  return 'first seen ' + Math.round(days / 30) + ' months ago';
}

// Age, activity, pass-through and the funder's reach. Read from history already fetched. Evidence only.
function profileRows(list, data) {
  const p = data.walletProfile;
  if (p && p.txsRead) {
    const more = p.capped ? ' (oldest ' + p.txsRead + ' read)' : '';
    const bits = [ageText(p.ageDays), p.received + ' received, ' + p.sent + ' sent' + more, 'active on ' + (p.capped ? 'at least ' : '') + p.activeDays + ' day' + (p.activeDays === 1 ? '' : 's')];
    list.appendChild(row('Wallet age and activity:', bits.filter(Boolean).join(', ') + '.', 'worked'));
    const pt = p.passThrough || { count: 0 };
    list.appendChild(row('Pass-through:', pt.count
      ? pt.count + ' time' + (pt.count === 1 ? '' : 's') + ' SUI came in and nearly all of it left within 30 minutes (' + pt.examples.map((e) => e.minutes + ' min').join(', ') + '). Often a relay or service wallet, not proof of anything.'
      : 'none seen in the history read.', 'worked'));
  }
  const fo = data.funderFanOut;
  if (fo) {
    const reading = fo.reading === 'link' ? 'a direct link' : fo.reading;
    list.appendChild(row('First funder reach:', 'paid ' + fo.countText + ' wallet' + (fo.wallets === 1 && !fo.atLeast ? '' : 's') + ' over ' + fo.hours + ' hour' + (fo.hours === 1 ? '' : 's') + ', read as ' + reading + '.', 'worked'));
  }
}

// Who funded the first funder, with the extra Tatum calls it cost. Evidence only; the row is simply left out when there is none.
function secondHopRow(list, data) {
  const h = data.secondHopFunder;
  if (!h) return;
  const calls = h.callsUsed + ' extra Tatum call' + (h.callsUsed === 1 ? '' : 's');
  let text;
  if (!h.found) text = h.note + ' (' + calls + ').';
  else if (h.circular) text = 'the wallet being checked funded its own first funder, so the money went in a circle (' + calls + ').';
  else {
    const bits = [short(h.address) + ' paid its first funder' + (h.fundedAt ? ' on ' + h.fundedAt.slice(0, 10) : '')];
    if (h.reach) bits.push('it has paid ' + h.reach.countText + ' wallet' + (h.reach.wallets === 1 && !h.reach.atLeast ? '' : 's') + ' over ' + h.reach.hours + ' hour' + (h.reach.hours === 1 ? '' : 's') + ', read as ' + (h.reach.reading === 'link' ? 'a direct link' : h.reach.reading));
    if (h.profile) bits.push(h.profile.isPackage ? 'it is a package, not a wallet' : h.profile.isObject ? 'it is an object, not a wallet' : 'it holds ' + (Number(h.profile.balance) / 1e9 >= 100 ? (Number(h.profile.balance) / 1e9).toFixed(0) : (Number(h.profile.balance) / 1e9).toFixed(3)) + ' SUI');
    if (!h.reach && !h.profile) bits.push('its own history and balance could not be read');
    text = bits.join(', ') + ' (' + calls + ').';
  }
  list.appendChild(row('Who funded its first funder:', text, 'worked'));
}

export function renderTatumPanel(data) {
  const box = document.getElementById('tatum-panel');
  if (!box) return;
  const t = data && data.callLog && data.callLog.tatum;
  if (!t || !Array.isArray(t.list) || t.list.length === 0) { box.classList.add('hidden'); return; }
  const list = document.getElementById('tatum-panel-list');
  list.innerHTML = '';
  const counts = {};
  t.list.forEach((c) => { counts[c.type] = (counts[c.type] || 0) + 1; });
  const parts = Object.keys(counts).map((k) => counts[k] + ' x ' + (CALL_WORDS[k] || k));
  list.appendChild(row('Tatum calls for this check: ' + t.calls + (t.failed ? ' (' + t.failed + ' failed)' : '') + '.', parts.join(', ') + '. Median ' + t.medianMs + ' ms.', 'tatum'));
  profileRows(list, data);
  secondHopRow(list, data);
  const f = data.chainFacts;
  if (f) {
    list.appendChild(row('This wallet holds:', holdingsText(f.wallet) + '.', 'tatum'));
    if (f.funder) list.appendChild(row('Its first funder ' + short(f.funder.address) + ' holds:', holdingsText(f.funder) + '.', 'tatum'));
    if (f.referenceGasPrice != null) list.appendChild(row('Sui network fee right now:', f.referenceGasPrice + ' MIST per unit of gas.', 'tatum'));
  }
  box.classList.remove('hidden');
}
