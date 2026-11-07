// Token bucket shared by the whole process. Tatum's free limit is 3 calls a second, we stay at 2.5.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createLimiter({ perSecond = 2.5, now = () => Date.now(), wait = sleep } = {}) {
  const gap = 1000 / perSecond;
  let next = 0;
  return async function acquire() {
    const t = now();
    const start = Math.max(t, next);
    next = start + gap;
    if (start > t) await wait(start - t);
  };
}

export const sharedLimiter = createLimiter();
