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

function row(label, value) {
  const li = document.createElement('li');
  const b = document.createElement('strong');
  b.textContent = label + ' ';
  li.appendChild(b);
  li.appendChild(document.createTextNode(value));
  return li;
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
  list.appendChild(row('Tatum calls for this check: ' + t.calls + (t.failed ? ' (' + t.failed + ' failed)' : '') + '.', parts.join(', ') + '. Median ' + t.medianMs + ' ms.'));
  const f = data.chainFacts;
  if (f) {
    list.appendChild(row('This wallet holds:', holdingsText(f.wallet) + '.'));
    if (f.funder) list.appendChild(row('Its first funder ' + short(f.funder.address) + ' holds:', holdingsText(f.funder) + '.'));
    if (f.referenceGasPrice != null) list.appendChild(row('Sui network fee right now:', f.referenceGasPrice + ' MIST per unit of gas.'));
  }
  box.classList.remove('hidden');
}
