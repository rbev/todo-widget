// Safe mutation helpers for todo-widget — pure ES module, no platform dependencies.
//
// All functions operate on the raw file text and return the new text.
// They re-parse from the provided text (the caller is expected to pass a
// freshly-read copy) and verify line identity before modifying, so that
// external edits made between read and mutation are rejected rather than
// silently overwritten.  Per-line separators are preserved byte-for-byte;
// new lines use the file's dominant EOL.

import { parseMarkdown } from './parser.js';
import { isValidDate } from './dates.js';

// Fence patterns — replicated from parser.js (not exported) to detect fenced
// code blocks during forward scanning without re-parsing the entire file.
const FENCE_OPEN_RE = /^(\s{0,3})(`{3,}|~{3,})/;
const FENCE_CLOSE_RE = /^\s{0,3}(`{3,}|~{3,})\s*$/;

/**
 * Return the 1-based line of the next category heading after *cat*, or 0
 * if there is none (cat is the last category).
 */
function findNextHeadingLine(model, cat) {
  const idx = model.categories.indexOf(cat);
  const next = model.categories[idx + 1];
  return next ? next.line : 0;
}

/**
 * Find the 0-based insertion index after the last task's entire block,
 * including following indented sub-bullets, intervening blank lines, and
 * attached indented fenced code blocks.  Stops before the next category's
 * heading, unindented content, or unindented fenced code blocks.  Trailing
 * blank lines are excluded so they remain as separators.
 *
 * @param {string[]} lines
 * @param {number} lastTaskLineIdx — 0-based index of the last task line
 * @param {number} stopLine — 1-based line of next heading, or 0 if none
 * @returns {number} 0-based insertion index
 */
function findBlockEnd(lines, lastTaskLineIdx, stopLine) {
  const stop = stopLine > 0 ? stopLine - 1 : lines.length;
  let insertAt = lastTaskLineIdx + 1;
  let inFence = false;
  let fenceChar = null;
  let fenceLen = 0;

  for (let i = lastTaskLineIdx + 1; i < lines.length && i < stop; i++) {
    const line = lines[i];

    if (inFence) {
      const fc = FENCE_CLOSE_RE.exec(line);
      if (fc && fc[1][0] === fenceChar && fc[1].length >= fenceLen) {
        inFence = false;
        fenceChar = null;
        fenceLen = 0;
      }
      insertAt = i + 1;
      continue;
    }

    const fo = FENCE_OPEN_RE.exec(line);
    if (fo) {
      if (fo[1].length > 0) {
        // Indented fence — part of the sub-block; track until close.
        inFence = true;
        fenceChar = fo[2][0];
        fenceLen = fo[2].length;
        insertAt = i + 1;
        continue;
      }
      break; // unindented standalone fence — boundary
    }

    if (line.trim() === '') continue;

    if (/^\s/.test(line)) {
      insertAt = i + 1;
      continue;
    }

    break; // unindented non-blank — end of block
  }

  if (inFence) throw new Error('Close the task’s fenced code block before adding an item');
  return insertAt;
}

/**
 * Rebuild text from lines and their individual separators.
 * @param {string[]} lines
 * @param {string[]} seps  - per-line separator parallel to lines
 * @returns {string}
 */
function rebuild(lines, seps) {
  let result = '';
  for (let i = 0; i < lines.length; i++) {
    result += lines[i] + seps[i];
  }
  return result;
}

/**
 * Insert a new line at a 0-based index, using preferred EOL for the new
 * line's separator.  Existing line separators are preserved.
 *
 * @param {string[]} lines  - mutated in place
 * @param {string[]} seps   - mutated in place
 * @param {number} idx      - 0-based insertion index
 * @param {string} newLine  - new line content (no separator)
 * @param {string} eol      - preferred EOL for the new line
 */
function insertLine(lines, seps, idx, newLine, eol) {
  if (lines.length === 0) {
    lines.push(newLine);
    seps.push('');
    return;
  }
  if (idx >= lines.length) {
    // Inserting at end.
    if (seps[lines.length - 1] === '') {
      // No trailing newline — give previous last line a separator, new line gets none.
      seps[lines.length - 1] = eol;
      lines.push(newLine);
      seps.push('');
    } else {
      // Trailing newline exists — new line inherits preferred EOL.
      lines.push(newLine);
      seps.push(eol);
    }
  } else {
    // Inserting in the middle or at the beginning.
    lines.splice(idx, 0, newLine);
    seps.splice(idx, 0, eol);
  }
}

/**
 * Build a new task line.
 * @param {string} title
 * @param {string|null} due
 * @returns {string}
 */
function buildTaskLine(title, due) {
  if (due) return `- [ ] [${due}] ${title}`;
  return `- [ ] ${title}`;
}

/**
 * Toggle the checkbox on a specific line.
 *
 * @param {string} text       - fresh file contents
 * @param {number} taskLine   - 1-based line number
 * @param {string} expectedRaw - the raw line content as previously rendered
 * @returns {string} new file contents
 * @throws if the line is stale (changed, missing, or no longer a checkbox)
 */
export function toggleCheckbox(text, taskLine, expectedRaw) {
  const model = parseMarkdown(text);
  const lines = [...model.lines];
  const seps = [...model.seps];
  const idx = taskLine - 1;

  if (idx < 0 || idx >= lines.length) {
    throw new Error('Stale: line number out of range');
  }
  if (lines[idx] !== expectedRaw) {
    throw new Error('Stale: line content has changed');
  }

  // Re-match to toggle only the checkbox character.
  const m = /^(\s*)-(\s*)\[([ xX])\](\s+.*)$/.exec(lines[idx]);
  if (!m) {
    throw new Error('Stale: line is no longer a checkbox task');
  }
  const wasChecked = m[3].toLowerCase() === 'x';
  const newBox = wasChecked ? ' ' : 'x';
  lines[idx] = `${m[1]}-${m[2]}[${newBox}]${m[4]}`;

  return rebuild(lines, seps);
}

/**
 * Add a new task under a category.
 *
 * @param {string} text       - fresh file contents
 * @param {string} title      - task title
 * @param {string} categoryId - category id, or '__default__' for unheaded
 * @param {string|null} due   - YYYY-MM-DD or null
 * @returns {string} new file contents
 * @throws on invalid title, invalid category or invalid due date
 */
export function addItem(text, title, categoryId, due) {
  // Trust boundary: reject blank or multiline titles.
  if (typeof title !== 'string' || title.trim() === '') {
    throw new Error('Task title must not be empty');
  }
  if (/[\r\n]/.test(title)) {
    throw new Error('Task title must not contain newlines');
  }

  if (due && !isValidDate(due)) {
    throw new Error(`Invalid due date: ${due}`);
  }

  const model = parseMarkdown(text);
  const lines = [...model.lines];
  const seps = [...model.seps];
  const newLine = buildTaskLine(title, due);

  let insertAt; // 0-based splice index

  if (categoryId === '__default__') {
    const def = model.categories.find((c) => c.title === null);
    if (def && def.tasks.length > 0) {
      insertAt = findBlockEnd(model.lines, def.tasks[def.tasks.length - 1].line - 1,
        findNextHeadingLine(model, def));
    } else {
      insertAt = 0;
    }
  } else {
    const cat = model.categories.find((c) => c.id === categoryId);
    if (!cat) throw new Error(`Invalid category: ${categoryId}`);
    if (cat.tasks.length > 0) {
      insertAt = findBlockEnd(model.lines, cat.tasks[cat.tasks.length - 1].line - 1,
        findNextHeadingLine(model, cat));
    } else if (cat.title !== null) {
      insertAt = cat.line; // insert right after heading
    } else {
      insertAt = 0;
    }
  }

  insertLine(lines, seps, insertAt, newLine, model.eol);
  return rebuild(lines, seps);
}