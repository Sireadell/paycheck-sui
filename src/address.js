// One shape for every Sui address: 0x plus 64 lowercase hex characters. Chain data always uses this shape.
const RAW = /^0x[0-9a-fA-F]{1,64}$/;

export const isSuiAddress = (a) => typeof a === 'string' && RAW.test(a);

/** Pad and lowercase. Returns null when the text is not an address. */
export function padAddress(a) {
  if (!isSuiAddress(a)) return null;
  return `0x${a.slice(2).toLowerCase().padStart(64, '0')}`;
}
