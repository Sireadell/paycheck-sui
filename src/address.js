// The one place an address is read. Valid input becomes 0x plus 64 lowercase hex characters, the shape chain data always uses.
// Invalid input gets a plain reason and a short input code, so a typo is never mistaken for a wallet with no history.
const HEX = /^[0-9a-fA-F]+$/;

const fail = (inputCode, reason) => ({ ok: false, address: null, inputCode, reason });

/**
 * @param {unknown} input what the caller sent
 * @returns {{ok: true, address: string}|{ok: false, inputCode: string, reason: string}}
 * Input codes: EMPTY_ADDRESS, NAME_NOT_SUPPORTED, MISSING_0X, NOT_HEX, ETHEREUM_ADDRESS, TOO_LONG.
 */
export function parseAddress(input) {
  if (typeof input !== 'string') return fail('EMPTY_ADDRESS', 'No address was sent. Send a Sui address: 0x followed by hex.');
  const text = input.trim();
  if (!text) return fail('EMPTY_ADDRESS', 'No address was sent. Send a Sui address: 0x followed by hex.');
  // SuiNS names (alice.sui, @alice) are names, not addresses. We do not look them up, so we do not guess.
  if (/^@?[^\s0x][^\s]*\.sui$/i.test(text) || /^@[a-z0-9-]+$/i.test(text) || /^[a-z0-9-]+\.sui$/i.test(text)) {
    return fail('NAME_NOT_SUPPORTED', 'That looks like a SuiNS name. Names are not looked up here. Resolve it to its 0x address first and send that.');
  }
  const m = /^0x(.*)$/i.exec(text);
  if (!m) {
    if (HEX.test(text) && text.length <= 64) return fail('MISSING_0X', 'The address is missing its 0x at the start. Add 0x and check it again.');
    return fail('NOT_HEX', 'That is not a Sui address. A Sui address is 0x followed by up to 64 hex characters (0 to 9 and a to f).');
  }
  const hex = m[1];
  if (!hex) return fail('EMPTY_ADDRESS', 'Nothing follows the 0x. Send a full Sui address.');
  if (!HEX.test(hex)) return fail('NOT_HEX', 'That is not a Sui address. After 0x only the characters 0 to 9 and a to f are allowed.');
  if (hex.length > 64) return fail('TOO_LONG', 'That address is longer than 64 hex characters, so it is not a Sui address.');
  // 20 bytes is the Ethereum shape. A Sui address printed in full is 32 bytes, so paying this one on Sui would be a wrong-chain mistake.
  if (hex.length === 40) return fail('ETHEREUM_ADDRESS', 'That is 40 hex characters, the Ethereum shape. A Sui address is 64 hex characters, so this looks like the wrong chain.');
  return { ok: true, address: `0x${hex.toLowerCase().padStart(64, '0')}` };
}

export const isSuiAddress = (a) => parseAddress(a).ok;

/** Pad and lowercase. Returns null when the text is not an address. */
export function padAddress(a) {
  const p = parseAddress(a);
  return p.ok ? p.address : null;
}
