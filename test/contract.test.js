import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { assertUnchanged } from '../lib/assert.js';
import { addItem, toggleCheckbox } from '../lib/mutation.js';
import { parseMarkdown } from '../lib/parser.js';
import { isValidDate, todayString, isOverdue } from '../lib/dates.js';
import { extractLinks, cleanLinkSyntax } from '../lib/links.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'indicator.js'), 'utf8');

test('launchers use GJS module mode and pinned GTK3 bindings', () => {
  assert.match(source.split('\n')[0], /env -S gjs -m/);
  assert.match(source, /gi:\/\/Gtk\?version=3\.0/);
  assert.match(source, /gi:\/\/AyatanaAppIndicator3\?version=0\.1/);
  const service = fs.readFileSync(path.join(ROOT, 'todo-widget.service'), 'utf8');
  assert.match(service, /ExecStart=\/usr\/bin\/gjs -m /);
});

test('overdue and normal icons have different checkbox colors', () => {
  const colors = ['normal', 'overdue'].map(name => {
    const svg = fs.readFileSync(path.join(ROOT, `icons/todo-${name}.svg`), 'utf8');
    return svg.match(/<rect[^>]*stroke="([^"]*)"/)[1];
  });
  assert.notEqual(colors[0], colors[1]);
});

test('double installation updates files without nesting, enables and restarts', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-install-'));
  try {
    const bin = path.join(home, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'systemctl'), '#!/bin/bash\nprintf "%s\\n" "$*" >> "$HOME/calls.log"\n', { mode: 0o755 });
    const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` };
    const install = () => execFileSync('bash', ['install.sh'], { env, cwd: ROOT });
    install();
    const target = path.join(home, '.local/share/todo-widget');
    fs.writeFileSync(path.join(target, 'lib/parser.js'), 'stale code');
    install();
    assert.equal(fs.readFileSync(path.join(target, 'lib/parser.js'), 'utf8'), fs.readFileSync(path.join(ROOT, 'lib/parser.js'), 'utf8'));
    assert.ok(!fs.existsSync(path.join(target, 'lib/lib')));
    assert.ok(!fs.existsSync(path.join(target, 'icons/icons')));
    const calls = fs.readFileSync(path.join(home, 'calls.log'), 'utf8');
    assert.equal(calls.match(/--user restart todo-widget.service/g).length, 2);
    assert.match(calls, /--user enable todo-widget.service/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// Execute the real app handlers, replacing only GI bindings and startup.
function app(initial = '') {
  let content = initial;
  let etag = 'etag-1';
  let failWrite = false;
  let writes = 0;
  let failLaunch = false;
  const launches = [];
  class Widget {
    constructor(props = {}) { Object.assign(this, props); this.children = []; this.handlers = {}; }
    append(child) { this.children.push(child); }
    connect(event, handler) { this.handlers[event] = handler; }
    show_all() {}
  }
  const missing = () => Object.assign(new Error('No such file'), { matches: () => true });
  const file = {
    load_contents() {
      if (content === null) throw missing();
      return [true, new TextEncoder().encode(content), etag];
    },
    get_uri: () => 'file:///notes/my%20todo.md',
    query_exists: () => content !== null,
    get_parent: () => ({ query_exists: () => true }),
    create() {
      if (content !== null) throw new Error('File already exists');
      content = '';
      return { close() {} };
    },
    replace_contents(bytes, expected) {
      if (failWrite || expected !== etag) throw new Error('Write conflict');
      content = new TextDecoder().decode(bytes);
      writes++;
    },
  };
  const context = vm.createContext({
    TextEncoder, TextDecoder, parseMarkdown, addItem, toggleCheckbox,
    assertUnchanged, isValidDate, todayString, isOverdue,
    extractLinks, cleanLinkSyntax,
    GLib: {
      path_get_dirname: path.dirname,
      build_pathv: (_, parts) => path.join(...parts),
      UriFlags: { NONE: 0 },
      Uri: {
        parse: (url, _flags) => {
          const m = /^(https?):\/\/([^/?#]+)/i.exec(url);
          if (!m) throw new Error(`Could not parse URI: ${url}`);
          return {
            get_scheme: () => m[1].toLowerCase(),
            get_host: () => m[2],
          };
        },
      },
    },
    Gio: {
      File: { new_for_path: () => file },
      IOErrorEnum: { NOT_FOUND: 1 },
      FileCreateFlags: { NONE: 0 },
      AppInfo: {
        launch_default_for_uri(uri, _cancellable) {
          if (failLaunch) throw new Error('Launch failed: ' + uri);
          launches.push(uri);
        },
      },
    },
    Gtk: { Menu: Widget, MenuItem: Widget, CheckMenuItem: Widget, SeparatorMenuItem: Widget },
  });
  const code = source.slice(0, source.indexOf('Gtk.init(null);'))
    .replace(/^#!.*\n/, '')
    .replace(/^import .*;\n/gm, '')
    .replace('import.meta.url', JSON.stringify(`file://${ROOT}/indicator.js`));
  vm.runInContext(code + `
    todoPath = '/todo.md';
    indicator = { set_menu() {}, set_icon_full() {} };
    globalThis.api = {
      reload, handleCreateFile, handleToggle, handleAddItem,
      getMenu: () => menu,
      state: () => ({ opError, fileError, fileMissing, renderedText }),
      setDialog: callback => { showAddDialog = callback; },
    };
  `, context);
  const api = context.api;
  api.reload();
  return {
    ...api,
    content: () => content,
    edit: value => { content = value; },
    etag: value => { etag = value; },
    failWrite: () => { failWrite = true; },
    failLaunch: () => { failLaunch = true; },
    writes: () => writes,
    launches: () => launches,
  };
}

const task = text => parseMarkdown(text).categories[0].tasks[0];
const newItem = (catId = '__default__') => ({ title: 'New task', catId, due: null });

test('missing file exposes Create and Add; explicit creation succeeds', () => {
  const a = app(null);
  assert.ok(a.state().fileMissing);
  const labels = a.getMenu().children.map(child => child.label);
  assert.ok(labels.includes('Create file'));
  assert.ok(labels.includes('+  Add new item…'));
  a.handleCreateFile();
  assert.equal(a.content(), '');
  assert.equal(a.state().opError, null);
});

test('Open todo file launches VS Code with an encoded file path', () => {
  const a = app('- [ ] Task\n');
  a.getMenu().children.find(child => child.label === 'Open todo file').handlers.activate();
  assert.equal(a.launches()[0], 'vscode://file/notes/my%20todo.md');
  assert.equal(a.writes(), 0);
});

test('VS Code launch failures stay visible', () => {
  const a = app('- [ ] Task\n');
  a.failLaunch();
  a.getMenu().children.find(child => child.label === 'Open todo file').handlers.activate();
  assert.match(a.state().opError, /Launch failed/);
  assert.equal(a.writes(), 0);
});

test('first Add creates missing file and writes the task', () => {
  const a = app(null);
  a.setDialog(() => newItem());
  a.handleAddItem();
  assert.equal(a.content(), '- [ ] New task');
});

test('failed toggle remains visible after reload without changing content', () => {
  const text = '- [ ] Task\n';
  const a = app(text);
  a.failWrite();
  a.handleToggle(task(text), text, '/todo.md');
  a.reload();
  assert.match(a.state().opError, /conflict/);
  assert.equal(a.content(), text);
  assert.ok(a.getMenu().children.some(child => child.label?.includes('Write conflict')));
  assert.ok(a.getMenu().children.some(child => child.label === '+  Add new item…'));
});

test('null etag refuses real handler write', () => {
  const text = '- [ ] Task\n';
  const a = app(text);
  a.etag(null);
  a.handleToggle(task(text), text, '/todo.md');
  assert.equal(a.writes(), 0);
  assert.match(a.state().opError, /etags/);
});

test('old checkbox callbacks retain their original snapshot after reload', () => {
  const a = app('# Work\n- [ ] Same\n');
  const oldCheckbox = a.getMenu().children.find(child => child.label === 'Same');
  a.edit('# Home\n- [ ] Same\n');
  a.reload();
  oldCheckbox.handlers.toggled();
  assert.equal(a.writes(), 0);
  assert.match(a.state().opError, /changed/i);
});

test('Add rejects headings changed during the dialog even after watcher reload', () => {
  const a = app('# Work\n- [ ] Task\n');
  a.setDialog(() => {
    a.edit('# New\n# Work\n- [ ] Task\n');
    a.reload();
    return newItem('0');
  });
  a.handleAddItem();
  assert.equal(a.writes(), 0);
  assert.match(a.state().opError, /changed/i);
});

test('Add targets the selected duplicate heading, not the first identical one', () => {
  const a = app('# Work\n- [ ] A\n# Work\n- [ ] B\n');
  a.setDialog(() => newItem('1'));
  a.handleAddItem();
  assert.equal(a.content(), '# Work\n- [ ] A\n# Work\n- [ ] B\n- [ ] New task\n');
});

test('Add does not recreate a file deleted while its dialog was open', () => {
  const a = app('# Work\n- [ ] Task\n');
  a.setDialog(() => { a.edit(null); return newItem('0'); });
  a.handleAddItem();
  assert.equal(a.content(), null);
  assert.match(a.state().opError, /deleted/);
});

test('Add does not overwrite externally created content', () => {
  const a = app(null);
  a.setDialog(() => { a.edit('- [ ] External\n'); return newItem(); });
  a.handleAddItem();
  assert.equal(a.content(), '- [ ] External\n');
  assert.equal(a.writes(), 0);
  assert.match(a.state().opError, /another process/);
});

// ---------------------------------------------------------------------------
// Link menu items (clickable links beneath each task)
// ---------------------------------------------------------------------------

function findLinkItem(menu, label) {
  // Link items have an 'activate' handler (CheckMenuItem has 'toggled').
  return menu.children.find(c => c.label === label && c.handlers.activate);
}

function findCheckItem(menu, label) {
  return menu.children.find(c => c.label === label && c.handlers.toggled);
}

test('link activation launches expected URI and does not toggle or write', () => {
  const text = '# Work\n- [ ] See [docs](https://example.com/docs)\n';
  const a = app(text);
  const menu = a.getMenu();
  // Task label should show cleaned syntax (label, not noisy Markdown).
  const check = findCheckItem(menu, 'See docs');
  assert.ok(check, 'CheckMenuItem with cleaned label should exist');
  assert.equal(check.active, false);
  // Link item should be present and activatable.
  const link = findLinkItem(menu, '    \u21b3 docs');
  assert.ok(link, 'Link menu item should exist beneath task');
  link.handlers.activate();
  assert.deepEqual(a.launches(), ['https://example.com/docs']);
  assert.equal(a.writes(), 0);
  assert.equal(a.content(), text);
  assert.equal(a.state().opError, null);
});

test('task checkbox remains active and correct with links present', () => {
  const text = '# Work\n- [x] Done — see <https://example.com>\n';
  const a = app(text);
  const menu = a.getMenu();
  const check = findCheckItem(menu, 'Done \u2014 see <https://example.com>');
  assert.ok(check);
  assert.equal(check.active, true);
  const link = findLinkItem(menu, '    \u21b3 https://example.com');
  assert.ok(link);
});

test('launch failure sets visible opError', () => {
  const text = '# Work\n- [ ] See https://example.com/page\n';
  const a = app(text);
  a.failLaunch();
  const link = findLinkItem(a.getMenu(), '    \u21b3 https://example.com/page');
  assert.ok(link);
  link.handlers.activate();
  assert.match(a.state().opError, /Launch failed/);
  assert.equal(a.writes(), 0);
});

test('unsafe scheme produces no link entry', () => {
  const text = '# Work\n- [ ] See [run](javascript:alert(1)) and file:///etc\n';
  const a = app(text);
  const menu = a.getMenu();
  // No link items should be present (no 'activate' handlers on link items).
  const linkItems = menu.children.filter(c => c.handlers.activate && c.label?.includes('\u21b3'));
  assert.equal(linkItems.length, 0);
});

test('multiple links in one task each get separate menu items', () => {
  const text = '# Work\n- [ ] See [a](https://a.com) and [b](https://b.com)\n';
  const a = app(text);
  const menu = a.getMenu();
  assert.ok(findLinkItem(menu, '    \u21b3 a'));
  assert.ok(findLinkItem(menu, '    \u21b3 b'));
});

// ---------------------------------------------------------------------------
// Nested entries: child checkboxes + plain bullet notes in the real menu
// ---------------------------------------------------------------------------

function findNoteItem(menu, label) {
  return menu.children.find(c => c.label === label && !c.handlers.toggled && !c.handlers.activate);
}

test('nested user example: parent, indented child checkbox, indented plain bullet', () => {
  const text = '- [ ] parent\n  - [ ] child\n  - child text only\n';
  const a = app(text);
  const menu = a.getMenu();
  // Parent checkbox at depth 0 — no indent prefix.
  const parent = findCheckItem(menu, 'parent');
  assert.ok(parent, 'parent CheckMenuItem should exist');
  assert.equal(parent.active, false);
  // Child checkbox at depth 1 — 2-space indent prefix.
  const child = findCheckItem(menu, '  child');
  assert.ok(child, 'child CheckMenuItem should exist with indent');
  assert.equal(child.active, false);
  // Plain bullet note at depth 1 — 2-space indent + bullet glyph.
  const note = findNoteItem(menu, '  \u2022 child text only');
  assert.ok(note, 'plain bullet MenuItem should exist');
  assert.equal(note.sensitive, false);
});

test('plain bullet note is insensitive and has no toggle/activate handlers', () => {
  const text = '- [ ] parent\n  - [ ] child\n  - child text only\n';
  const a = app(text);
  const menu = a.getMenu();
  const note = findNoteItem(menu, '  \u2022 child text only');
  assert.ok(note);
  assert.equal(note.sensitive, false);
  assert.equal(note.handlers.toggled, undefined);
  assert.equal(note.handlers.activate, undefined);
});

test('child toggle changes only child checkbox — parent and notes remain', () => {
  const text = '- [ ] parent\n  - [ ] child\n  - child text only\n';
  const a = app(text);
  const menu = a.getMenu();
  const child = findCheckItem(menu, '  child');
  assert.ok(child);
  child.handlers.toggled();
  // Content: child checked, parent unchecked, note unchanged.
  assert.equal(a.content(), '- [ ] parent\n  - [x] child\n  - child text only\n');
  assert.equal(a.writes(), 1);
  assert.equal(a.state().opError, null);
  // Menu after reload still shows all three entries.
  const menu2 = a.getMenu();
  assert.ok(findCheckItem(menu2, 'parent'));
  assert.ok(findCheckItem(menu2, '  child'));
  assert.ok(findNoteItem(menu2, '  \u2022 child text only'));
  // Child is now checked.
  assert.equal(findCheckItem(menu2, '  child').active, true);
  assert.equal(findCheckItem(menu2, 'parent').active, false);
});

test('Add inserts after entire nested subtree — parent, child, note', () => {
  const text = '- [ ] parent\n  - [ ] child\n  - child text only\n';
  const a = app(text);
  a.setDialog(() => newItem('__default__'));
  a.handleAddItem();
  assert.equal(a.content(),
    '- [ ] parent\n  - [ ] child\n  - child text only\n- [ ] New task\n');
  assert.equal(a.writes(), 1);
});

test('web links in child notes produce separate clickable link items', () => {
  const text = '- [ ] task\n  - See [docs](https://example.com)\n';
  const a = app(text);
  const menu = a.getMenu();
  // Note label has cleaned link syntax.
  const note = findNoteItem(menu, '  \u2022 See docs');
  assert.ok(note, 'note with cleaned link label should exist');
  // Link item beneath note, indented by note depth + 4 spaces.
  const link = findLinkItem(menu, '      \u21b3 docs');
  assert.ok(link, 'link item beneath note should exist');
  link.handlers.activate();
  assert.deepEqual(a.launches(), ['https://example.com']);
  assert.equal(a.writes(), 0);
  assert.equal(a.state().opError, null);
});

test('nested checkbox link items indented by task depth', () => {
  const text = '# Work\n- [ ] parent\n  - [ ] See [docs](https://example.com)\n';
  const a = app(text);
  const menu = a.getMenu();
  // Child task at depth 1 — link item gets 6-space prefix.
  const link = findLinkItem(menu, '      \u21b3 docs');
  assert.ok(link);
  link.handlers.activate();
  assert.deepEqual(a.launches(), ['https://example.com']);
});
