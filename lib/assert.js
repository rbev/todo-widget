// Shared pure assertion helper for external-edit safety.
//
// Conservative by design: exact text equality.  Any change between the
// snapshot captured when the menu was rendered (or a dialog opened) and the
// fresh read at action time is rejected, forcing a reload and protecting
// against stale writes.  Gio etags still guard the narrower read-write
// window; this guard covers the wider render-to-action window.

/**
 * Assert that file text has not changed since a snapshot was captured.
 * @param {string} text         - fresh file contents
 * @param {string} expectedText - snapshot captured at render / dialog-open time
 * @throws {Error} if texts differ
 */
export function assertUnchanged(text, expectedText) {
  if (text !== expectedText) {
    throw new Error('File changed since last render');
  }
}