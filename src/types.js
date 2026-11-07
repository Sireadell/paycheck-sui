/**
 * Result shapes shared by every lane. JSDoc only, no runtime code.
 *
 * @typedef {'pay'|'caution'|'do_not_pay'} VerdictLabel
 *
 * @typedef {Object} CheckResult
 * @property {VerdictLabel} verdict
 * @property {string} code
 * @property {string} reason
 * @property {Object[]} evidence
 * @property {string[]} memoryIds
 * @property {boolean} retryable
 * @property {string} nextAction
 *
 * @typedef {Object} CallLogEntry
 * @property {'tatum'|'ankr'} provider
 * @property {string} readType
 * @property {number} ms
 * @property {boolean} ok
 */
export {};
