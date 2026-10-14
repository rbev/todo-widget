// Markdown parser for todo-widget — pure ES module, no platform dependencies.
//
// Parses a markdown string into a model of categories (ATX headings) and
// checkbox tasks.  Fenced code blocks are respected: nothing inside a fence
// is treated as a heading or task.  Per-line separators (\n or \r\n) are
// tracked so that mutations can faithfully reconstruct mixed-EOL source.

import { isValidDate } from './dates.js';

const HEADING_RE = /^ {0,3}(#{1,6})\s+(.+)$/;
const TASK_RE = /^(\s*)-(\s*)\[([ xX])\](\s+.*)$/;
const DUE_RE = /^\[(\d{4}-\d{2}-\d{2})\]\s*(.*)$/;
const FENCE_OPEN_RE = /^\s{0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE_RE = /^\s{0,3}(`{3,}|~{3,})\s*$/;
const PLAIN_BULLET_RE = /^(\s*)-(\s+)(\S.*)$/;

/**
 * Expand leading whitespace to a column count (tabs → next multiple of 4).
 * @param {string} ws
 * @returns {number}
 */
function indentColumns(ws) {
  let col = 0;
  for (const ch of ws) {
    if (ch === '\t') col = (Math.floor(col / 4) + 1) * 4;
    else col++;
  }
  return col;
}

/**
 * Split text into content lines and per-line separators.
 *
 * Each separator is "\n", "\r\n", or "" (for the final line when the file
 * has no trailing newline).  This preserves mixed EOL files byte-for-byte.
 *
 * @param {string} text
 * @returns {{ lines: string[], seps: string[] }}
 */
function splitWithSeparators(text) {
  if (text.length === 0) return { lines: [], seps: [] };
  const lines = [];
  const seps = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      let contentEnd = i;
      let sep = '\n';
      if (i > 0 && text[i - 1] === '\r') {
        contentEnd = i - 1;
        sep = '\r\n';
      }
      lines.push(text.slice(start, contentEnd));
      seps.push(sep);
      start = i + 1;
    }
  }
  if (start < text.length) {
    lines.push(text.slice(start));
    seps.push('');
  }
  return { lines, seps };
}

/**
 * @typedef {Object} Task
 * @property {number} line     - 1-based line number in the source
 * @property {boolean} checked
 * @property {string} text     - task text without due-date prefix
 * @property {string|null} due - YYYY-MM-DD or null
 * @property {string} raw      - exact original line content (no trailing newline / CR)
 * @property {number} indent   - leading-whitespace column count (tabs expanded)
 */

/**
 * @typedef {Object} NoteEntry
 * @property {'note'} kind
 * @property {number} line     - 1-based line number in the source
 * @property {string} text     - bullet text (link syntax preserved for extraction)
 * @property {string} raw      - exact original line content
 * @property {number} indent   - leading-whitespace column count (tabs expanded)
 */

/**
 * @typedef {Object} TaskEntry
 * @property {'task'} kind
 * @property {Task} task
 */

/** @typedef {TaskEntry|NoteEntry} Entry */

/**
 * @typedef {Object} Category
 * @property {string} id      - sequential id ("0", "1", …)
 * @property {string|null} title - heading text or null for the default unheaded category
 * @property {number} level   - heading level 1-6, or 0 for default
 * @property {number} line    - 1-based line number of the heading, or 0 for default
 * @property {Task[]} tasks   - flat array of all checkbox tasks (for overdue/toggle/Add)
 * @property {Entry[]} entries - ordered display: tasks + plain bullet notes
 */

/**
 * @typedef {Object} Model
 * @property {string[]} lines            - content lines (no separators)
 * @property {string[]} seps             - per-line separators ("\n", "\r\n", or "")
 * @property {string} eol                - preferred EOL for new lines (dominant style)
 * @property {boolean} hasFinalNewline
 * @property {Category[]} categories
 * @property {number} lineCount
 */

/**
 * Parse markdown text into a model.
 * @param {string} text
 * @returns {Model}
 */
export function parseMarkdown(text) {
  const { lines, seps } = splitWithSeparators(text);

  // Determine preferred EOL from dominant separator.
  let crlfCount = 0;
  let lfCount = 0;
  for (const s of seps) {
    if (s === '\r\n') crlfCount++;
    else if (s === '\n') lfCount++;
  }
  const eol = crlfCount > lfCount ? '\r\n' : '\n';
  const hasFinalNewline = seps.length > 0 && seps[seps.length - 1] !== '';

  const defaultCat = { id: '0', title: null, level: 0, line: 0, tasks: [], entries: [] };
  const headingCats = [];
  let currentCat = defaultCat;
  let inFence = false;
  let fenceChar = null;
  let fenceLen = 0;
  let inTaskBlock = false;
  let blockRootIndent = Infinity;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // --- fence handling ---
    if (!inFence) {
      const fo = FENCE_OPEN_RE.exec(line);
      if (fo) {
        inFence = true;
        fenceChar = fo[1][0];
        fenceLen = fo[1].length;
        // Unindented fence ends the task block; indented fence is part of it.
        if (!/^\s/.test(line)) { inTaskBlock = false; blockRootIndent = Infinity; }
        continue;
      }
    } else {
      const fc = FENCE_CLOSE_RE.exec(line);
      if (fc && fc[1][0] === fenceChar && fc[1].length >= fenceLen) {
        inFence = false;
        fenceChar = null;
        fenceLen = 0;
      }
      continue;
    }

    // --- ATX heading ---
    const hm = HEADING_RE.exec(line);
    if (hm) {
      inTaskBlock = false;
      blockRootIndent = Infinity;
      let title = hm[2].replace(/\s+#+\s*$/, '').replace(/\s+$/, '');
      currentCat = {
        id: String(headingCats.length + 1),
        title,
        level: hm[1].length,
        line: lineNum,
        tasks: [],
        entries: [],
      };
      headingCats.push(currentCat);
      continue;
    }

    // --- checkbox task ---
    const tm = TASK_RE.exec(line);
    if (tm) {
      const indent = indentColumns(tm[1]);
      const checked = tm[3].toLowerCase() === 'x';
      let rest = tm[4].replace(/^\s+/, ''); // strip leading whitespace after ]
      let due = null;
      let text = rest;
      const dm = DUE_RE.exec(rest);
      if (dm && isValidDate(dm[1])) {
        due = dm[1];
        text = dm[2];
      }
      const taskObj = { line: lineNum, checked, text, due, raw: line, indent };
      currentCat.tasks.push(taskObj);
      currentCat.entries.push({ kind: 'task', task: taskObj });
      const wasInBlock = inTaskBlock;
      inTaskBlock = true;
      if (!wasInBlock || indent <= blockRootIndent) blockRootIndent = indent;
      continue;
    }

    // --- plain bullet: only descendants of a checkbox task block ---
    if (inTaskBlock) {
      const pm = PLAIN_BULLET_RE.exec(line);
      if (pm) {
        const indent = indentColumns(pm[1]);
        if (indent > blockRootIndent) {
          currentCat.entries.push({
            kind: 'note',
            line: lineNum,
            text: pm[3].replace(/\s+$/, ''),
            raw: line,
            indent,
          });
        } else {
          // Not a descendant — ends the block.
          inTaskBlock = false;
          blockRootIndent = Infinity;
        }
        continue;
      }
    }

    // --- other content: manage block context ---
    if (line.trim() === '') continue; // blank line keeps block open
    if (!/^\s/.test(line)) { inTaskBlock = false; blockRootIndent = Infinity; }
    // Indented non-bullet content within a block is part of the block
    // but not displayed; outside a block it is ignored.
  }

  // Assemble final category list: default first (only if it has tasks), then headings.
  const categories = [];
  if (defaultCat.tasks.length > 0) categories.push(defaultCat);
  for (const c of headingCats) categories.push(c);
  categories.forEach((c, idx) => (c.id = String(idx)));

  return { lines, seps, eol, hasFinalNewline, categories, lineCount: lines.length };
}