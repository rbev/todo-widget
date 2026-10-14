// Date helpers for todo-widget — pure ES module, no platform dependencies.

/**
 * Validate that a string is a real calendar date in YYYY-MM-DD format.
 * @param {string} s
 * @returns {boolean}
 */
export function isValidDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12) return false;
  if (d < 1 || d > 31) return false;
  // Defer to Date rollover: invalid day/month combos roll over.
  const dt = new Date(y, mo - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d;
}

/**
 * Return today's date as YYYY-MM-DD in the local timezone.
 * @returns {string}
 */
export function todayString() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Determine whether an uncompleted task with the given due date is overdue.
 * A task is overdue only when due is strictly before today AND the task is
 * not checked.  Today itself is never overdue.  Completed tasks are never
 * overdue.  Invalid or missing due dates are never overdue.
 *
 * @param {string|null} due  - YYYY-MM-DD or null
 * @param {boolean} checked
 * @param {string} [today]   - YYYY-MM-DD (defaults to todayString())
 * @returns {boolean}
 */
export function isOverdue(due, checked, today) {
  if (checked) return false;
  if (!due) return false;
  if (!isValidDate(due)) return false;
  const ref = today ?? todayString();
  return due < ref; // lexicographic comparison works for YYYY-MM-DD
}