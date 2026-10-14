import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import { isValidDate, todayString, isOverdue } from '../lib/dates.js';
import { parseMarkdown } from '../lib/parser.js';
import { toggleCheckbox, addItem } from '../lib/mutation.js';
import { assertUnchanged } from '../lib/assert.js';
import { extractLinks, cleanLinkSyntax } from '../lib/links.js';

test('addItem refuses insertion inside an unclosed attached code fence', () => {
  const text = '# Work\n- [ ] Parent\n  ```\n  code\n';
  assert.throws(() => addItem(text, 'New', '0', null), /Close.*fenced code block/);
});

// ---------------------------------------------------------------------------
// dates.js
// ---------------------------------------------------------------------------

test('isValidDate accepts real calendar dates', () => {
  assert.ok(isValidDate('2026-01-15'));
  assert.ok(isValidDate('2024-02-29')); // leap year
  assert.ok(isValidDate('2026-12-31'));
});

test('isValidDate rejects impossible dates', () => {
  assert.ok(!isValidDate('2026-02-30'));  // Feb 30
  assert.ok(!isValidDate('2025-02-29'));  // not a leap year
  assert.ok(!isValidDate('2026-13-01'));  // month 13
  assert.ok(!isValidDate('2026-00-10'));  // month 0
  assert.ok(!isValidDate('2026-01-00'));  // day 0
  assert.ok(!isValidDate('2026-01-32'));  // day 32
  assert.ok(!isValidDate('not-a-date'));
  assert.ok(!isValidDate('2026-1-5'));    // not zero-padded
  assert.ok(!isValidDate(''));
});

test('todayString returns YYYY-MM-DD', () => {
  assert.match(todayString(), /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(isValidDate(todayString()));
});

test('isOverdue: past unchecked is overdue', () => {
  assert.ok(isOverdue('2020-01-01', false, '2026-06-01'));
});

test('isOverdue: past checked is NOT overdue', () => {
  assert.ok(!isOverdue('2020-01-01', true, '2026-06-01'));
});

test('isOverdue: today is NOT overdue', () => {
  assert.ok(!isOverdue('2026-06-01', false, '2026-06-01'));
});

test('isOverdue: future is NOT overdue', () => {
  assert.ok(!isOverdue('2099-12-31', false, '2026-06-01'));
});

test('isOverdue: no due date is never overdue', () => {
  assert.ok(!isOverdue(null, false, '2026-06-01'));
});

test('isOverdue: invalid due date is never overdue', () => {
  assert.ok(!isOverdue('2026-13-45', false, '2026-06-01'));
});

// ---------------------------------------------------------------------------
// parser.js
// ---------------------------------------------------------------------------

test('parseMarkdown: basic heading + task', () => {
  const m = parseMarkdown('# Work\n- [ ] Buy milk\n');
  assert.equal(m.categories.length, 1);
  assert.equal(m.categories[0].title, 'Work');
  assert.equal(m.categories[0].level, 1);
  assert.equal(m.categories[0].tasks.length, 1);
  assert.equal(m.categories[0].tasks[0].text, 'Buy milk');
  assert.equal(m.categories[0].tasks[0].checked, false);
  assert.equal(m.categories[0].tasks[0].due, null);
  assert.ok(m.hasFinalNewline);
});

test('parseMarkdown: checked task', () => {
  const m = parseMarkdown('# Work\n- [x] Done task\n');
  assert.equal(m.categories[0].tasks[0].checked, true);
});

test('parseMarkdown: uppercase X is checked', () => {
  const m = parseMarkdown('# Work\n- [X] Done task\n');
  assert.equal(m.categories[0].tasks[0].checked, true);
});

test('parseMarkdown: due date prefix', () => {
  const m = parseMarkdown('# Work\n- [ ] [2026-03-15] Submit report\n');
  const t = m.categories[0].tasks[0];
  assert.equal(t.due, '2026-03-15');
  assert.equal(t.text, 'Submit report');
});

test('parseMarkdown: invalid date in brackets is not a due date', () => {
  const m = parseMarkdown('# Work\n- [ ] [urgent] Buy milk\n');
  const t = m.categories[0].tasks[0];
  assert.equal(t.due, null);
  assert.equal(t.text, '[urgent] Buy milk');
});

test('parseMarkdown: headings levels 1-6', () => {
  const text = '# H1\n## H2\n### H3\n#### H4\n##### H5\n###### H6\n';
  const m = parseMarkdown(text);
  assert.equal(m.categories.length, 6);
  assert.deepEqual(m.categories.map((c) => c.level), [1, 2, 3, 4, 5, 6]);
});

test('parseMarkdown: default unheaded category', () => {
  const m = parseMarkdown('- [ ] No category task\n# Work\n- [ ] Work task\n');
  assert.equal(m.categories.length, 2);
  assert.equal(m.categories[0].title, null);
  assert.equal(m.categories[0].tasks[0].text, 'No category task');
  assert.equal(m.categories[1].title, 'Work');
});

test('parseMarkdown: no default category when no pre-heading tasks', () => {
  const m = parseMarkdown('Some prose\n# Work\n- [ ] Task\n');
  assert.equal(m.categories.length, 1);
  assert.equal(m.categories[0].title, 'Work');
});

test('parseMarkdown: fenced code blocks are ignored', () => {
  const text = [
    '# Real',
    '- [ ] Real task',
    '```',
    '# Fake heading',
    '- [ ] Fake task',
    '```',
    '# After',
    '- [ ] After task',
    '',
  ].join('\n');
  const m = parseMarkdown(text);
  assert.equal(m.categories.length, 2);
  assert.equal(m.categories[0].title, 'Real');
  assert.equal(m.categories[1].title, 'After');
  assert.equal(m.categories[0].tasks.length, 1);
  assert.equal(m.categories[1].tasks.length, 1);
});

test('parseMarkdown: tilde fences', () => {
  const text = '# Real\n- [ ] Real task\n~~~\n- [ ] Fake\n~~~\n';
  const m = parseMarkdown(text);
  assert.equal(m.categories.length, 1);
  assert.equal(m.categories[0].tasks.length, 1);
});

test('parseMarkdown: CRLF line endings detected', () => {
  const m = parseMarkdown('# Work\r\n- [ ] Task\r\n');
  assert.equal(m.eol, '\r\n');
  assert.equal(m.lines.length, 2);
  assert.equal(m.lines[0], '# Work');
  assert.equal(m.lines[1], '- [ ] Task');
  assert.ok(m.hasFinalNewline);
});

test('parseMarkdown: no trailing newline', () => {
  const m = parseMarkdown('# Work\n- [ ] Task');
  assert.ok(!m.hasFinalNewline);
  assert.equal(m.lines.length, 2);
});

test('parseMarkdown: empty file', () => {
  const m = parseMarkdown('');
  assert.equal(m.categories.length, 0);
  assert.equal(m.lines.length, 0);
  assert.ok(!m.hasFinalNewline);
});

test('parseMarkdown: duplicate headings are distinguishable by id/position', () => {
  const m = parseMarkdown('# Work\n- [ ] A\n# Work\n- [ ] B\n');
  assert.equal(m.categories.length, 2);
  assert.equal(m.categories[0].id, '0');
  assert.equal(m.categories[1].id, '1');
  assert.equal(m.categories[0].tasks[0].text, 'A');
  assert.equal(m.categories[1].tasks[0].text, 'B');
});

test('parseMarkdown: raw line stored for stale detection', () => {
  const m = parseMarkdown('# Work\n- [ ] Task\n');
  assert.equal(m.categories[0].tasks[0].raw, '- [ ] Task');
  assert.equal(m.categories[0].tasks[0].line, 2);
});

test('parseMarkdown: heading with closing hashes', () => {
  const m = parseMarkdown('## My Heading ##\n');
  assert.equal(m.categories[0].title, 'My Heading');
});

test('parseMarkdown: seven hashes is not a heading', () => {
  const m = parseMarkdown('####### Not a heading\n- [ ] Task\n');
  assert.equal(m.categories.length, 1);
  assert.equal(m.categories[0].title, null);
});

test('parseMarkdown: ATX heading requires space after hashes', () => {
  const m = parseMarkdown('#NoSpace\n- [ ] Task\n');
  assert.equal(m.categories.length, 1);
  assert.equal(m.categories[0].title, null);
});

// ---------------------------------------------------------------------------
// parser.js — fence length tracking
// ---------------------------------------------------------------------------

test('parseMarkdown: closing fence shorter than opening does not close', () => {
  const text = '# Real\n- [ ] Real task\n````\n# Fake\n- [ ] Fake\n```\n# Should be inside\n````\n# After\n- [ ] After\n';
  const m = parseMarkdown(text);
  // "Should be inside" is still inside the fence (``` is shorter than ````)
  // so only "Real" and "After" are categories
  assert.equal(m.categories.length, 2);
  assert.equal(m.categories[0].title, 'Real');
  assert.equal(m.categories[1].title, 'After');
});

test('parseMarkdown: closing fence equal length closes', () => {
  const text = '# Real\n````\n# Fake\n````\n# After\n';
  const m = parseMarkdown(text);
  assert.equal(m.categories.length, 2);
  assert.equal(m.categories[0].title, 'Real');
  assert.equal(m.categories[1].title, 'After');
});

test('parseMarkdown: closing fence longer than opening closes', () => {
  const text = '# Real\n```\n# Fake\n`````\n# After\n';
  const m = parseMarkdown(text);
  assert.equal(m.categories.length, 2);
  assert.equal(m.categories[0].title, 'Real');
  assert.equal(m.categories[1].title, 'After');
});

// ---------------------------------------------------------------------------
// parser.js — mixed EOL separators
// ---------------------------------------------------------------------------

test('parseMarkdown: mixed EOL separators tracked per line', () => {
  const text = '# Work\n- [ ] Task1\r\n- [ ] Task2\n';
  const m = parseMarkdown(text);
  assert.equal(m.seps.length, 3);
  assert.equal(m.seps[0], '\n');
  assert.equal(m.seps[1], '\r\n');
  assert.equal(m.seps[2], '\n');
});

test('parseMarkdown: no trailing newline sep is empty', () => {
  const text = '# Work\n- [ ] Task';
  const m = parseMarkdown(text);
  assert.equal(m.seps[0], '\n');
  assert.equal(m.seps[1], '');
  assert.ok(!m.hasFinalNewline);
});

// ---------------------------------------------------------------------------
// mutation.js — toggleCheckbox
// ---------------------------------------------------------------------------

test('toggleCheckbox: unchecked to checked', () => {
  const text = '# Work\n- [ ] Buy milk\n';
  const result = toggleCheckbox(text, 2, '- [ ] Buy milk');
  assert.ok(result.includes('- [x] Buy milk'));
  assert.ok(result.includes('# Work'));
});

test('toggleCheckbox: checked to unchecked', () => {
  const text = '# Work\n- [x] Buy milk\n';
  const result = toggleCheckbox(text, 2, '- [x] Buy milk');
  assert.ok(result.includes('- [ ] Buy milk'));
});

test('toggleCheckbox: preserves due date', () => {
  const text = '# Work\n- [ ] [2026-03-15] Submit\n';
  const result = toggleCheckbox(text, 2, '- [ ] [2026-03-15] Submit');
  assert.ok(result.includes('- [x] [2026-03-15] Submit'));
});

test('toggleCheckbox: preserves CRLF', () => {
  const text = '# Work\r\n- [ ] Task\r\n';
  const result = toggleCheckbox(text, 2, '- [ ] Task');
  assert.ok(result.includes('\r\n'));
  assert.ok(!result.endsWith('\n\n') && result.endsWith('\r\n'));
});

test('toggleCheckbox: preserves no trailing newline', () => {
  const text = '# Work\n- [ ] Task';
  const result = toggleCheckbox(text, 2, '- [ ] Task');
  assert.ok(!result.endsWith('\n'));
});

test('toggleCheckbox: preserves surrounding prose', () => {
  const text = 'Some intro prose\n# Work\n- [ ] Task\nMore prose\n';
  const result = toggleCheckbox(text, 3, '- [ ] Task');
  assert.ok(result.includes('Some intro prose'));
  assert.ok(result.includes('More prose'));
  assert.ok(result.includes('- [x] Task'));
});

test('toggleCheckbox: stale line content rejected', () => {
  const text = '# Work\n- [ ] Different text\n';
  assert.throws(() => toggleCheckbox(text, 2, '- [ ] Original text'), /Stale/);
});

test('toggleCheckbox: stale line out of range rejected', () => {
  const text = '# Work\n- [ ] Task\n';
  assert.throws(() => toggleCheckbox(text, 99, '- [ ] Task'), /Stale/);
});

test('toggleCheckbox: line no longer a checkbox rejected', () => {
  const text = '# Work\nJust prose\n';
  assert.throws(() => toggleCheckbox(text, 2, 'Just prose'), /Stale/);
});

// ---------------------------------------------------------------------------
// mutation.js — toggleCheckbox byte preservation with mixed EOL
// ---------------------------------------------------------------------------

test('toggleCheckbox: mixed EOL byte preservation', () => {
  const text = '# Work\n- [ ] Task1\r\n- [ ] Task2\n';
  const result = toggleCheckbox(text, 2, '- [ ] Task1');
  // Only the checkbox char on line 2 changed; all separators preserved.
  assert.equal(result, '# Work\n- [x] Task1\r\n- [ ] Task2\n');
});

test('toggleCheckbox: mixed EOL toggling last line with CRLF', () => {
  const text = '# Work\r\n- [ ] Task1\n- [ ] Task2\r\n';
  const result = toggleCheckbox(text, 3, '- [ ] Task2');
  assert.equal(result, '# Work\r\n- [ ] Task1\n- [x] Task2\r\n');
});

// ---------------------------------------------------------------------------
// mutation.js — addItem
// ---------------------------------------------------------------------------

test('addItem: under heading with existing tasks', () => {
  const text = '# Work\n- [ ] First\n## Sub\n- [ ] Second\n';
  const result = addItem(text, 'New task', '0', null);
  const lines = result.split('\n');
  assert.equal(lines[0], '# Work');
  assert.equal(lines[1], '- [ ] First');
  assert.equal(lines[2], '- [ ] New task');
  assert.equal(lines[3], '## Sub');
});

test('addItem: under heading with no tasks', () => {
  const text = '# Work\n## Sub\n- [ ] Sub task\n';
  const result = addItem(text, 'New task', '0', null);
  const lines = result.split('\n');
  assert.equal(lines[0], '# Work');
  assert.equal(lines[1], '- [ ] New task');
  assert.equal(lines[2], '## Sub');
});

test('addItem: under default category (tasks before headings)', () => {
  const text = '- [ ] Pre task\n# Work\n- [ ] Work task\n';
  const result = addItem(text, 'New pre', '__default__', null);
  const lines = result.split('\n');
  assert.equal(lines[0], '- [ ] Pre task');
  assert.equal(lines[1], '- [ ] New pre');
  assert.equal(lines[2], '# Work');
});

test('addItem: default category on empty file', () => {
  const result = addItem('', 'First task', '__default__', null);
  assert.equal(result, '- [ ] First task');
});

test('addItem: with due date', () => {
  const text = '# Work\n- [ ] Existing\n';
  const result = addItem(text, 'Important', '0', '2026-12-25');
  assert.ok(result.includes('- [ ] [2026-12-25] Important'));
});

test('addItem: invalid due date rejected', () => {
  const text = '# Work\n';
  assert.throws(() => addItem(text, 'Task', '0', '2026-13-45'), /Invalid due date/);
});

test('addItem: preserves CRLF', () => {
  const text = '# Work\r\n- [ ] Existing\r\n';
  const result = addItem(text, 'New', '0', null);
  assert.ok(result.includes('\r\n'));
});

test('addItem: preserves no trailing newline', () => {
  const text = '# Work\n- [ ] Existing';
  const result = addItem(text, 'New', '0', null);
  // No trailing newline preserved — new line at end has no separator.
  assert.ok(!result.endsWith('\n'));
});

test('addItem: invalid category rejected', () => {
  const text = '# Work\n- [ ] Task\n';
  assert.throws(() => addItem(text, 'Task', 'nonexistent', null), /Invalid category/);
});

test('addItem: does not corrupt nested headings', () => {
  const text = '# Project\n## Phase 1\n- [ ] Task A\n## Phase 2\n- [ ] Task B\n';
  const result = addItem(text, 'New A', '1', null); // add under "Phase 1"
  const lines = result.split('\n');
  assert.equal(lines[0], '# Project');
  assert.equal(lines[1], '## Phase 1');
  assert.equal(lines[2], '- [ ] Task A');
  assert.equal(lines[3], '- [ ] New A');
  assert.equal(lines[4], '## Phase 2');
  assert.equal(lines[5], '- [ ] Task B');
});

test('addItem: at end of file (last heading)', () => {
  const text = '# A\n- [ ] A1\n# B\n- [ ] B1\n';
  const result = addItem(text, 'B2', '1', null);
  const lines = result.split('\n');
  assert.equal(lines[3], '- [ ] B1');
  assert.equal(lines[4], '- [ ] B2');
});

test('addItem: last task of file preserves final newline', () => {
  const text = '# Work\n- [ ] Existing\n';
  const result = addItem(text, 'New', '0', null);
  assert.ok(result.endsWith('\n'));
});

// ---------------------------------------------------------------------------
// mutation.js — addItem mixed EOL byte preservation
// ---------------------------------------------------------------------------

test('addItem: mixed EOL — new line uses dominant EOL, existing preserved', () => {
  const text = '# Work\n- [ ] Task1\r\n- [ ] Task2\n';
  const result = addItem(text, 'New', '0', null);
  // Dominant EOL is \n (2 vs 1). New line inserted after Task1 (line 2).
  // Expected: "# Work\n- [ ] Task1\n- [ ] New\r\n- [ ] Task2\n"
  // Wait — new line is inserted after last task of cat 0 (Task2, line 3).
  // insertAt = 3, which is >= lines.length (3), so appended at end.
  // seps[2] = '\n' (not ''), so new line gets '\n' (eol).
  assert.equal(result, '# Work\n- [ ] Task1\r\n- [ ] Task2\n- [ ] New\n');
});

test('addItem: mixed EOL inserting in middle preserves surrounding separators', () => {
  const text = '# Work\r\n- [ ] Task1\n## Sub\n- [ ] Task2\r\n';
  const result = addItem(text, 'New', '0', null);
  // Insert after Task1 (line 2), before "## Sub".
  // seps: [\r\n, \n, \n, \r\n] → CRLF:2, LF:2 → tie → eol = \n.
  // New line gets \n (preferred eol). Existing separators preserved.
  assert.equal(result, '# Work\r\n- [ ] Task1\n- [ ] New\n## Sub\n- [ ] Task2\r\n');
});

// ---------------------------------------------------------------------------
// mutation.js — addItem title validation
// ---------------------------------------------------------------------------

test('addItem: blank title rejected', () => {
  assert.throws(() => addItem('# Work\n', '', '0', null), /empty/i);
  assert.throws(() => addItem('# Work\n', '   ', '0', null), /empty/i);
});

test('addItem: multiline title rejected', () => {
  assert.throws(() => addItem('# Work\n', 'Line1\nLine2', '0', null), /newline/i);
  assert.throws(() => addItem('# Work\n', 'Line1\r\nLine2', '0', null), /newline/i);
  assert.throws(() => addItem('# Work\n', 'Line1\rLine2', '0', null), /newline/i);
});

test('addItem: non-string title rejected', () => {
  assert.throws(() => addItem('# Work\n', null, '0', null), /empty/i);
  assert.throws(() => addItem('# Work\n', undefined, '0', null), /empty/i);
});

// ---------------------------------------------------------------------------
// assert.js — assertUnchanged
// ---------------------------------------------------------------------------

test('assertUnchanged: identical text passes', () => {
  assertUnchanged('hello', 'hello');
  assertUnchanged('', '');
});

test('assertUnchanged: different text throws', () => {
  assert.throws(() => assertUnchanged('hello', 'hello!'), /changed/i);
  assert.throws(() => assertUnchanged('hello\n', 'hello'), /changed/i);
  assert.throws(() => assertUnchanged('hello', 'hello\n'), /changed/i);
});

test('assertUnchanged: conservative — whitespace difference rejected', () => {
  assert.throws(() => assertUnchanged('a b', 'a  b'), /changed/i);
  assert.throws(() => assertUnchanged('a\nb', 'a\r\nb'), /changed/i);
});

// ---------------------------------------------------------------------------
// mutation.js — addItem after sub-bullets
// ---------------------------------------------------------------------------

test('addItem: inserts after sub-bullets, not before them', () => {
  const text = '# Work\n- [ ] Parent\n  - detail\n  - detail2\n';
  const result = addItem(text, 'New', '0', null);
  assert.equal(result, '# Work\n- [ ] Parent\n  - detail\n  - detail2\n- [ ] New\n');
});

test('addItem: inserts after nested checkboxes and their sub-bullets', () => {
  const text = '# Work\n- [ ] Parent\n  - [ ] Sub checkbox\n    - deep detail\n';
  const result = addItem(text, 'New', '0', null);
  // Last parsed task is the nested checkbox at line 3; its sub-bullet at
  // line 4 is indented and belongs to the block. New item goes after line 4.
  assert.equal(result, '# Work\n- [ ] Parent\n  - [ ] Sub checkbox\n    - deep detail\n- [ ] New\n');
});

test('addItem: sub-bullets then heading — new item before heading', () => {
  const text = '# Work\n- [ ] Parent\n  - detail\n## Next\n';
  const result = addItem(text, 'New', '0', null);
  assert.equal(result, '# Work\n- [ ] Parent\n  - detail\n- [ ] New\n## Next\n');
});

test('addItem: sub-bullets with CRLF preserved', () => {
  const text = '# Work\r\n- [ ] Parent\r\n  - detail\r\n';
  const result = addItem(text, 'New', '0', null);
  assert.equal(result, '# Work\r\n- [ ] Parent\r\n  - detail\r\n- [ ] New\r\n');
});

test('addItem: sub-bullets with no trailing newline', () => {
  const text = '# Work\n- [ ] Parent\n  - detail';
  const result = addItem(text, 'New', '0', null);
  assert.equal(result, '# Work\n- [ ] Parent\n  - detail\n- [ ] New');
});

test('addItem: sub-bullets in default category', () => {
  const text = '- [ ] Pre task\n  - detail\n# Work\n';
  const result = addItem(text, 'New pre', '__default__', null);
  assert.equal(result, '- [ ] Pre task\n  - detail\n- [ ] New pre\n# Work\n');
});

test('addItem: intervening blank lines between sub-bullets are included', () => {
  const text = '# Work\n- [ ] Parent\n  - detail\n\n  - detail2\n';
  const result = addItem(text, 'New', '0', null);
  assert.equal(result, '# Work\n- [ ] Parent\n  - detail\n\n  - detail2\n- [ ] New\n');
});

test('addItem: trailing blank lines before heading are not included', () => {
  const text = '# Work\n- [ ] Parent\n  - detail\n\n## Next\n';
  const result = addItem(text, 'New', '0', null);
  assert.equal(result, '# Work\n- [ ] Parent\n  - detail\n- [ ] New\n\n## Next\n');
});

test('addItem: no sub-bullets — backward compatible', () => {
  const text = '# Work\n- [ ] Task\n## Sub\n';
  const result = addItem(text, 'New', '0', null);
  assert.equal(result, '# Work\n- [ ] Task\n- [ ] New\n## Sub\n');
});

test('addItem: fence after sub-bullets stops scan', () => {
  const text = '# Work\n- [ ] Parent\n  - detail\n```\ncode\n```\n  - after fence\n';
  const result = addItem(text, 'New', '0', null);
  // Fence opener stops the scan; new item goes after '  - detail', before fence.
  assert.equal(result, '# Work\n- [ ] Parent\n  - detail\n- [ ] New\n```\ncode\n```\n  - after fence\n');
});

// ---------------------------------------------------------------------------
// mutation.js — toggleCheckbox preserves sub-bullets
// ---------------------------------------------------------------------------

test('toggleCheckbox: changes only checkbox, keeps sub-bullets', () => {
  const text = '# Work\n- [ ] Parent\n  - detail\n  - detail2\n';
  const result = toggleCheckbox(text, 2, '- [ ] Parent');
  assert.equal(result, '# Work\n- [x] Parent\n  - detail\n  - detail2\n');
});

test('toggleCheckbox: nested checkbox toggle keeps siblings', () => {
  const text = '# Work\n- [ ] Parent\n  - [ ] Sub\n  - [ ] Other\n';
  const result = toggleCheckbox(text, 3, '  - [ ] Sub');
  assert.equal(result, '# Work\n- [ ] Parent\n  - [x] Sub\n  - [ ] Other\n');
});

// ---------------------------------------------------------------------------
// links.js — extractLinks
// ---------------------------------------------------------------------------

test('extractLinks: Markdown link [label](url)', () => {
  const links = extractLinks('See [docs](https://example.com/docs)');
  assert.equal(links.length, 1);
  assert.equal(links[0].label, 'docs');
  assert.equal(links[0].url, 'https://example.com/docs');
});

test('extractLinks: bare URL', () => {
  const links = extractLinks('See https://example.com/page');
  assert.equal(links.length, 1);
  assert.equal(links[0].label, 'https://example.com/page');
  assert.equal(links[0].url, 'https://example.com/page');
});

test('extractLinks: angle-bracket autolink', () => {
  const links = extractLinks('See <https://example.com>');
  assert.equal(links.length, 1);
  assert.equal(links[0].label, 'https://example.com');
  assert.equal(links[0].url, 'https://example.com');
});

test('extractLinks: deduplicates URLs (first label wins)', () => {
  const links = extractLinks('[a](https://x.com) and [b](https://x.com)');
  assert.equal(links.length, 1);
  assert.equal(links[0].label, 'a');
});

test('extractLinks: multiple different links', () => {
  const links = extractLinks('[a](https://a.com) and [b](https://b.com)');
  assert.equal(links.length, 2);
  assert.equal(links[0].url, 'https://a.com');
  assert.equal(links[1].url, 'https://b.com');
});

test('extractLinks: rejects javascript: scheme', () => {
  const links = extractLinks('[run](javascript:alert(1))');
  assert.equal(links.length, 0);
});

test('extractLinks: rejects file: scheme', () => {
  const links = extractLinks('[f](file:///etc/passwd)');
  assert.equal(links.length, 0);
});

test('extractLinks: rejects data: scheme', () => {
  const links = extractLinks('[d](data:text/html,<script>)');
  assert.equal(links.length, 0);
});

test('extractLinks: rejects malformed URL', () => {
  const links = extractLinks('[x](https://)');
  assert.equal(links.length, 0);
});

test('extractLinks: trims trailing period from bare URL', () => {
  const links = extractLinks('See https://example.com.');
  assert.equal(links[0].url, 'https://example.com');
});

test('extractLinks: trims trailing comma and semicolon', () => {
  const links = extractLinks('See https://example.com, and https://example.org;');
  assert.equal(links[0].url, 'https://example.com');
  assert.equal(links[1].url, 'https://example.org');
});

test('extractLinks: trims unmatched closing paren from bare URL', () => {
  const links = extractLinks('(see https://example.com)');
  assert.equal(links[0].url, 'https://example.com');
});

test('extractLinks: keeps balanced parens in bare URL', () => {
  const links = extractLinks('See https://en.wikipedia.org/wiki/Foo_(bar)');
  assert.equal(links[0].url, 'https://en.wikipedia.org/wiki/Foo_(bar)');
});

test('extractLinks: Markdown link URL with parens in destination', () => {
  const links = extractLinks('[wiki](https://en.wikipedia.org/wiki/Foo_(bar))');
  assert.equal(links.length, 1);
  assert.equal(links[0].url, 'https://en.wikipedia.org/wiki/Foo_(bar)');
});

test('extractLinks: empty text returns empty array', () => {
  assert.deepEqual(extractLinks(''), []);
  assert.deepEqual(extractLinks(null), []);
});

test('extractLinks: text with no links returns empty array', () => {
  assert.deepEqual(extractLinks('Just some text'), []);
});

test('extractLinks: http and https both accepted', () => {
  const links = extractLinks('[a](http://a.com) [b](https://b.com)');
  assert.equal(links.length, 2);
});

// ---------------------------------------------------------------------------
// links.js — cleanLinkSyntax
// ---------------------------------------------------------------------------

test('cleanLinkSyntax: replaces Markdown link with label', () => {
  assert.equal(cleanLinkSyntax('See [docs](https://example.com)'), 'See docs');
});

test('cleanLinkSyntax: preserves unrelated text', () => {
  assert.equal(cleanLinkSyntax('Task [link](https://x.com) and more'), 'Task link and more');
});

test('cleanLinkSyntax: leaves bare URLs as-is', () => {
  assert.equal(cleanLinkSyntax('See https://example.com'), 'See https://example.com');
});

test('cleanLinkSyntax: leaves angle-bracket autolinks as-is', () => {
  assert.equal(cleanLinkSyntax('See <https://example.com>'), 'See <https://example.com>');
});

test('cleanLinkSyntax: empty text returns as-is', () => {
  assert.equal(cleanLinkSyntax(''), '');
  assert.equal(cleanLinkSyntax(null), null);
});

// ---------------------------------------------------------------------------
// links.js — regression: angle phantom, source order, no-URL GJS, no trim
// ---------------------------------------------------------------------------

test('extractLinks: angle autolink with path — no phantom bare duplicate', () => {
  // URL_BODY used to include < and >, so the bare pass re-scanned past the
  // closing > and produced a second wrong link ending in >.
  const links = extractLinks('See <https://example.com/page>');
  assert.equal(links.length, 1);
  assert.equal(links[0].url, 'https://example.com/page');
});

test('extractLinks: mixed link types in source order', () => {
  // Single-pass combined regex ensures source order, not type-grouped order.
  const links = extractLinks('https://a.com and [b](https://b.com) and <https://c.com>');
  assert.equal(links.length, 3);
  assert.equal(links[0].url, 'https://a.com');
  assert.equal(links[1].url, 'https://b.com');
  assert.equal(links[2].url, 'https://c.com');
});

test('extractLinks: angle autolink preserves trailing punctuation', () => {
  // Angle delimiters are explicit — no trimTrailing applied.
  const links = extractLinks('See <https://example.com/foo.>');
  assert.equal(links.length, 1);
  assert.equal(links[0].url, 'https://example.com/foo.');
});

test('extractLinks: Markdown destination preserves trailing punctuation', () => {
  // Markdown link destinations are explicitly delimited — no trimTrailing.
  const links = extractLinks('[x](https://example.com/bar.)');
  assert.equal(links.length, 1);
  assert.equal(links[0].url, 'https://example.com/bar.');
});

test('extractLinks: bare URL inside Markdown link not separately matched', () => {
  // Combined regex consumes the full [label](url) so the inner bare URL is
  // not re-matched in a separate pass.
  const links = extractLinks('[docs](https://example.com) and https://other.com');
  assert.equal(links.length, 2);
  assert.equal(links[0].label, 'docs');
  assert.equal(links[0].url, 'https://example.com');
  assert.equal(links[1].url, 'https://other.com');
});

test('extractLinks: works without URL global (GJS compatibility)', () => {
  // Evaluate the module source in a bare VM context where URL is undefined,
  // proving the lexical validator has no platform URL API dependency.
  const src = fs.readFileSync(
    path.resolve(import.meta.dirname, '..', 'lib', 'links.js'), 'utf8');
  const ctx = vm.createContext({}); // no URL, no globals beyond bare JS
  vm.runInContext(src.replace(/^export /gm, '') + '\n;globalThis.fn = extractLinks;', ctx);
  const links = ctx.fn('See [docs](https://example.com) and <https://other.com/path>');
  assert.equal(links.length, 2);
  assert.equal(links[0].url, 'https://example.com');
  assert.equal(links[1].url, 'https://other.com/path');
});

test('extractLinks: rejects http authority malformed', () => {
  assert.equal(extractLinks('[x](https://)').length, 0);
  assert.equal(extractLinks('[x](http://)').length, 0);
  assert.equal(extractLinks('[x](https:///path)').length, 0);
  assert.equal(extractLinks('https://').length, 0);
  assert.equal(extractLinks('https:// example.com').length, 0);
  // Angle delimiter after a valid URL is excluded from the URL body —
  // the URL itself is still valid.
  assert.equal(extractLinks('https://example.com<').length, 1);
  assert.equal(extractLinks('https://example.com<')[0].url, 'https://example.com');
});

// ---------------------------------------------------------------------------
// mutation.js — regression: indented heading boundary, attached fenced code
// ---------------------------------------------------------------------------

test('addItem: indented heading in sub-bullets is a boundary', () => {
  // Parser recognises 2-space-indented ATX headings as category headings.
  // findBlockEnd must stop before the indented heading, not cross it.
  const text = '# Work\n- [ ] Parent\n  - child\n  ## Next\n- [ ] Other\n';
  const result = addItem(text, 'New', '0', null);
  assert.equal(result, '# Work\n- [ ] Parent\n  - child\n- [ ] New\n  ## Next\n- [ ] Other\n');
});

test('addItem: indented heading at 3-space indent is also a boundary', () => {
  const text = '# A\n- [ ] Task A\n   ### Deep\n- [ ] Deep task\n';
  const result = addItem(text, 'New', '0', null);
  assert.equal(result, '# A\n- [ ] Task A\n- [ ] New\n   ### Deep\n- [ ] Deep task\n');
});

test('addItem: attached indented fenced code preserved before heading', () => {
  const text = '# Work\n- [ ] Parent\n  - child\n  ```\n  code\n  ```\n## Next\n- [ ] Other\n';
  const result = addItem(text, 'New', '0', null);
  assert.equal(result, '# Work\n- [ ] Parent\n  - child\n  ```\n  code\n  ```\n- [ ] New\n## Next\n- [ ] Other\n');
});

test('addItem: attached indented fenced code at end of file', () => {
  const text = '# Work\n- [ ] Parent\n  - child\n  ```\n  code\n  ```\n';
  const result = addItem(text, 'New', '0', null);
  assert.equal(result, '# Work\n- [ ] Parent\n  - child\n  ```\n  code\n  ```\n- [ ] New\n');
});

test('addItem: unindented fence still stops scan (standalone boundary)', () => {
  const text = '# Work\n- [ ] Parent\n  - detail\n```\ncode\n```\n  - after fence\n';
  const result = addItem(text, 'New', '0', null);
  assert.equal(result, '# Work\n- [ ] Parent\n  - detail\n- [ ] New\n```\ncode\n```\n  - after fence\n');
});

test('addItem: indented fence with tilde syntax preserved', () => {
  const text = '# Work\n- [ ] Parent\n  - child\n  ~~~\n  code\n  ~~~\n## Next\n';
  const result = addItem(text, 'New', '0', null);
  assert.equal(result, '# Work\n- [ ] Parent\n  - child\n  ~~~\n  code\n  ~~~\n- [ ] New\n## Next\n');
});

// ---------------------------------------------------------------------------
// parser.js — nested entries: checkbox tasks + plain bullet notes
// ---------------------------------------------------------------------------

test('parseMarkdown: user example — parent, child checkbox, child plain bullet', () => {
  const text = '- [ ] parent\n  - [ ] child\n  - child text only\n';
  const m = parseMarkdown(text);
  const cat = m.categories[0];
  // Flat tasks array still has both checkboxes for overdue/toggle/Add.
  assert.equal(cat.tasks.length, 2);
  assert.equal(cat.tasks[0].text, 'parent');
  assert.equal(cat.tasks[0].indent, 0);
  assert.equal(cat.tasks[1].text, 'child');
  assert.equal(cat.tasks[1].indent, 2);
  // Ordered entries: task, task, note.
  assert.equal(cat.entries.length, 3);
  assert.equal(cat.entries[0].kind, 'task');
  assert.equal(cat.entries[0].task.text, 'parent');
  assert.equal(cat.entries[1].kind, 'task');
  assert.equal(cat.entries[1].task.text, 'child');
  assert.equal(cat.entries[2].kind, 'note');
  assert.equal(cat.entries[2].text, 'child text only');
  assert.equal(cat.entries[2].indent, 2);
  assert.equal(cat.entries[2].raw, '  - child text only');
  assert.equal(cat.entries[2].line, 3);
});

test('parseMarkdown: mixed notes and tasks preserve source order', () => {
  const text = '- [ ] A\n  - note A\n  - [ ] B\n  - note B\n';
  const m = parseMarkdown(text);
  const entries = m.categories[0].entries;
  assert.deepEqual(entries.map(e => e.kind), ['task', 'note', 'task', 'note']);
  assert.equal(entries[0].task.text, 'A');
  assert.equal(entries[1].text, 'note A');
  assert.equal(entries[2].task.text, 'B');
  assert.equal(entries[3].text, 'note B');
});

test('parseMarkdown: deep nesting — three levels of checkboxes plus note', () => {
  const text = '- [ ] A\n  - [ ] B\n    - [ ] C\n      - deep note\n';
  const m = parseMarkdown(text);
  const entries = m.categories[0].entries;
  assert.equal(entries.length, 4);
  assert.deepEqual(entries.map(e => e.kind), ['task', 'task', 'task', 'note']);
  assert.equal(entries[0].task.indent, 0);
  assert.equal(entries[1].task.indent, 2);
  assert.equal(entries[2].task.indent, 4);
  assert.equal(entries[3].indent, 6);
  assert.equal(entries[3].text, 'deep note');
  // Flat tasks array has all three checkboxes.
  assert.equal(m.categories[0].tasks.length, 3);
});

test('parseMarkdown: fenced code suppresses plain bullets inside', () => {
  const text = [
    '- [ ] task',
    '  - real note',
    '```',
    '- [ ] fake task',
    '  - fake note',
    '```',
    '- [ ] after',
    '  - after note',
  ].join('\n');
  const m = parseMarkdown(text);
  const entries = m.categories[0].entries;
  const texts = entries.map(e => (e.kind === 'task' ? e.task.text : e.text));
  assert.ok(!texts.includes('fake note'));
  assert.ok(!texts.includes('fake task'));
  assert.ok(texts.includes('real note'));
  assert.ok(texts.includes('after note'));
});

test('parseMarkdown: heading boundary — no leakage across categories', () => {
  const text = '- [ ] task\n  - note\n# Heading\n  - leaked note\n- [ ] after\n  - after note\n';
  const m = parseMarkdown(text);
  // Default category: task + note only.
  const def = m.categories.find(c => c.title === null);
  assert.equal(def.entries.length, 2);
  const defTexts = def.entries.map(e => (e.kind === 'task' ? e.task.text : e.text));
  assert.ok(!defTexts.includes('leaked note'));
  // Heading category: after + after note (leaked note NOT included).
  const head = m.categories.find(c => c.title === 'Heading');
  assert.equal(head.entries.length, 2);
  const headTexts = head.entries.map(e => (e.kind === 'task' ? e.task.text : e.text));
  assert.deepEqual(headTexts, ['after', 'after note']);
});

test('parseMarkdown: unindented prose ends block — no later leakage', () => {
  const text = '- [ ] task\n  - note\nProse line\n  - leaked note\n';
  const m = parseMarkdown(text);
  const entries = m.categories[0].entries;
  assert.equal(entries.length, 2); // task + note only
  const texts = entries.map(e => (e.kind === 'task' ? e.task.text : e.text));
  assert.ok(!texts.includes('leaked note'));
});

test('parseMarkdown: blank lines within subtree keep block open', () => {
  const text = '- [ ] task\n\n  - note after blank\n';
  const m = parseMarkdown(text);
  const entries = m.categories[0].entries;
  assert.equal(entries.length, 2);
  assert.equal(entries[1].kind, 'note');
  assert.equal(entries[1].text, 'note after blank');
});

test('parseMarkdown: top-level plain bullet without task block is ignored', () => {
  const text = '- standalone bullet\n- [ ] task\n  - child note\n';
  const m = parseMarkdown(text);
  const entries = m.categories[0].entries;
  // Only task + child note; standalone bullet not in entries.
  assert.equal(entries.length, 2);
  assert.equal(entries[0].task.text, 'task');
  assert.equal(entries[1].text, 'child note');
});

test('parseMarkdown: tab indentation expanded consistently', () => {
  const text = '- [ ] parent\n\t- [ ] child\n\t- child note\n';
  const m = parseMarkdown(text);
  const entries = m.categories[0].entries;
  assert.equal(entries.length, 3);
  // Tab expands to column 4.
  assert.equal(entries[0].task.indent, 0);
  assert.equal(entries[1].task.indent, 4);
  assert.equal(entries[2].indent, 4);
  assert.equal(entries[2].text, 'child note');
});

test('parseMarkdown: note raw preserves full source line', () => {
  const text = '- [ ] task\n  - note with [link](https://x.com)\n';
  const m = parseMarkdown(text);
  const note = m.categories[0].entries[1];
  assert.equal(note.kind, 'note');
  assert.equal(note.raw, '  - note with [link](https://x.com)');
  assert.equal(note.text, 'note with [link](https://x.com)');
  assert.equal(note.line, 2);
});