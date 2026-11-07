// Token bucket shared by the whole process. Tatum's free limit is 3 calls a second, we stay at 2.5.
// The waiting line has a cap: past it, a call is refused at once instead of queueing without bound.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const QUEUE_FULL = 'The data provider queue is full. Try again shortly.';

export function createLimiter({ perSecond = 2.5, now = () => Date.now(), wait = sleep, maxQueue = 100 } = {}) {
  const gap = 1000 / perSecond;
  let next = 0;
  let waiting = 0;
  return async function acquire() {
    const t = now();
    const start = Math.max(t, next);
    if (start > t && waiting >= maxQueue) {
      const err = new Error(QUEUE_FULL);
      err.code = 'QUEUE_FULL';
      throw err;
    }
    next = start + gap;
    if (start > t) {
      waiting++;
      try { await wait(start - t); } finally { waiting--; }
    }
  };
}

export const sharedLimiter = createLimiter();
