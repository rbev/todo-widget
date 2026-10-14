#!/usr/bin/env -S gjs -m
// todo-widget — GNOME top-bar todo AppIndicator backed by a markdown file.
//
// Pure parsing/mutation logic lives in ./lib/*.js so it can be tested with
// Node --test independently of GJS/GTK.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk?version=3.0';
import system from 'system';

import { parseMarkdown } from './lib/parser.js';
import { toggleCheckbox, addItem } from './lib/mutation.js';
import { assertUnchanged } from './lib/assert.js';
import { isValidDate, todayString, isOverdue } from './lib/dates.js';
import { extractLinks, cleanLinkSyntax } from './lib/links.js';

const APP_NAME = 'todo-widget';
const ICON_NORMAL = 'todo-normal';
const ICON_OVERDUE = 'todo-overdue';

// --- resolve script / icon directories ---
const _uri = import.meta.url;
const _scriptPath = decodeURIComponent(_uri.replace(/^file:\/\//, ''));
const SCRIPT_DIR = GLib.path_get_dirname(_scriptPath);
const ICONS_DIR = GLib.build_pathv('/', [SCRIPT_DIR, 'icons']);

// --- state ---
let AppIndicator = null;
let indicator = null;
let menu = null;
let todoPath = '';
let currentModel = null;
let opError = null;      // error from a failed toggle/add/create operation
let fileError = null;    // error from reading the file (not NOT_FOUND)
let fileMissing = false; // file is NOT_FOUND
let renderedText = null; // exact file text when last rendered (snapshot guard)
let lastToday = '';
let suppressToggle = false;

let fileMonitor = null;
let dirMonitor = null;
let pollId = 0;
let rolloverId = 0;
let reloadId = 0;
let lastPollMtime = 0;

// ===========================================================================
// Path resolution
// ===========================================================================

function resolveTilde(p) {
  if (p === '~') return GLib.get_home_dir();
  if (p.startsWith('~/')) return GLib.build_pathv('/', [GLib.get_home_dir(), p.slice(2)]);
  return p;
}

function readConfigPath() {
  const configDir = GLib.build_pathv('/', [GLib.get_user_config_dir(), APP_NAME]);
  const configFile = Gio.File.new_for_path(GLib.build_pathv('/', [configDir, 'path']));
  try {
    const [, contents] = configFile.load_contents(null);
    const text = new TextDecoder().decode(contents).trim();
    if (text) return resolveTilde(text);
  } catch (_e) { /* config file optional */ }
  return null;
}

function getTodoPath() {
  const configured = readConfigPath();
  if (configured) return configured;
  const env = GLib.getenv('TODO_FILE');
  if (env) return resolveTilde(env);
  return GLib.build_pathv('/', [GLib.get_home_dir(), 'notes', 'todo.md']);
}

function saveConfigPath(path) {
  const configDir = GLib.build_pathv('/', [GLib.get_user_config_dir(), APP_NAME]);
  GLib.mkdir_with_parents(configDir, 0o755);
  const configFile = Gio.File.new_for_path(GLib.build_pathv('/', [configDir, 'path']));
  const bytes = new TextEncoder().encode(path + '\n');
  configFile.replace_contents(bytes, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
}

// ===========================================================================
// File I/O
// ===========================================================================

function fileExists(path) {
  return Gio.File.new_for_path(path).query_exists(null);
}

function isNotFoundError(e) {
  if (!e) return false;
  try {
    if (typeof e.matches === 'function' &&
        e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) {
      return true;
    }
  } catch (_e) { /* fall through to string check */ }
  return /not.?found|no such file/i.test(e.message || String(e));
}

function readFile(path) {
  // Returns { text, etag } or throws.
  const file = Gio.File.new_for_path(path);
  const [, contents, etag] = file.load_contents(null);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const text = decoder.decode(contents);
  return { text, etag };
}

function writeFileAtomic(path, text, etag) {
  // Refuse writes when etag is unavailable — without it g_file_replace_contents
  // performs no conflict check, so a concurrent external edit could be lost.
  if (!etag) {
    throw new Error('Cannot write safely: filesystem does not provide etags');
  }
  const file = Gio.File.new_for_path(path);
  const bytes = new TextEncoder().encode(text);
  file.replace_contents(bytes, etag, false, Gio.FileCreateFlags.NONE, null);
}

function createFileExclusive(path) {
  // Creates an empty file; throws if it already exists.
  const file = Gio.File.new_for_path(path);
  const parent = file.get_parent();
  if (parent && !parent.query_exists(null)) {
    parent.make_directory_with_parents(null);
  }
  const stream = file.create(Gio.FileCreateFlags.NONE, null);
  stream.close(null);
}

// ===========================================================================
// Model / icon
// ===========================================================================

function hasOverdue(model) {
  const today = todayString();
  for (const cat of model.categories) {
    for (const task of cat.tasks) {
      if (isOverdue(task.due, task.checked, today)) return true;
    }
  }
  return false;
}

function countOverdue(model) {
  const today = todayString();
  let n = 0;
  for (const cat of model.categories) {
    for (const task of cat.tasks) {
      if (isOverdue(task.due, task.checked, today)) n++;
    }
  }
  return n;
}

function updateIcon() {
  if (!indicator) return;
  if (currentModel && hasOverdue(currentModel)) {
    indicator.set_icon_full(ICON_OVERDUE, 'Todo — overdue');
  } else {
    indicator.set_icon_full(ICON_NORMAL, 'Todo');
  }
}

// ===========================================================================
// Reload from file
// ===========================================================================

function reload() {
  // reload() never touches opError — only handlers and explicit refresh do.
  try {
    const { text } = readFile(todoPath);
    const model = parseMarkdown(text);
    currentModel = model;
    renderedText = text;
    fileMissing = false;
    fileError = null;
  } catch (e) {
    if (isNotFoundError(e)) {
      fileMissing = true;
      fileError = null;
    } else {
      fileMissing = false;
      fileError = e.message || String(e);
    }
    currentModel = null;
    renderedText = null;
  }
  lastToday = todayString();
  updateIcon();
  rebuildMenu();
}

function scheduleReload() {
  if (reloadId) GLib.source_remove(reloadId);
  reloadId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
    reloadId = 0;
    reload();
    return false; // one-shot
  });
}

// ===========================================================================
// Menu building
// ===========================================================================

function fmtTaskLabel(task) {
  const depth = Math.min(Math.floor(task.indent / 2), 6);
  const prefix = '  '.repeat(depth);
  const today = todayString();
  let label = cleanLinkSyntax(task.text);
  if (task.due) {
    const overdue = isOverdue(task.due, task.checked, today);
    label += `  —  ${task.due}`;
    if (overdue) label += '  ⚠';
  }
  return `${prefix}${label}`;
}

function fmtNoteLabel(note) {
  const depth = Math.min(Math.floor(note.indent / 2), 6);
  return `${'  '.repeat(depth)}• ${cleanLinkSyntax(note.text)}`;
}

function linkLabel(parentIndent, link) {
  const depth = Math.min(Math.floor(parentIndent / 2), 6);
  return `${'  '.repeat(depth)}    ↳ ${link.label}`;
}

function fmtCatLabel(cat) {
  if (cat.title === null) return 'No category';
  const indent = '  '.repeat(Math.min(cat.level - 1, 3));
  return `${indent}${cat.title}`;
}

function buildMenu() {
  const m = new Gtk.Menu();

  // --- unreadable file error (not missing, not op error) ---
  if (fileError && !fileMissing) {
    if (opError) {
      m.append(new Gtk.MenuItem({ label: `⚠ ${opError}`, sensitive: false }));
      m.append(new Gtk.SeparatorMenuItem());
    }
    const errItem = new Gtk.MenuItem({ label: `⚠ Error: ${fileError}`, sensitive: false });
    m.append(errItem);
    const pathItem = new Gtk.MenuItem({ label: `File: ${todoPath}`, sensitive: false });
    m.append(pathItem);
    m.append(new Gtk.SeparatorMenuItem());
    appendChangeFile(m);
    m.append(new Gtk.SeparatorMenuItem());
    appendQuitItem(m);
    return m;
  }

  // --- missing file: show Create + Add + Change + Quit ---
  if (fileMissing) {
    if (opError) {
      m.append(new Gtk.MenuItem({ label: `⚠ ${opError}`, sensitive: false }));
      m.append(new Gtk.SeparatorMenuItem());
    }
    const missing = new Gtk.MenuItem({ label: 'No todo file found', sensitive: false });
    m.append(missing);
    const pathItem = new Gtk.MenuItem({ label: `Path: ${todoPath}`, sensitive: false });
    m.append(pathItem);
    m.append(new Gtk.SeparatorMenuItem());
    const createItem = new Gtk.MenuItem({ label: 'Create file' });
    createItem.connect('activate', handleCreateFile);
    m.append(createItem);
    const addMenuItem = new Gtk.MenuItem({ label: '+  Add new item…' });
    addMenuItem.connect('activate', handleAddItem);
    m.append(addMenuItem);
    m.append(new Gtk.SeparatorMenuItem());
    appendChangeFile(m);
    m.append(new Gtk.SeparatorMenuItem());
    appendQuitItem(m);
    return m;
  }

  // --- normal: file exists and is readable ---
  // Show operation error at top but keep tasks and actions visible.
  if (opError) {
    m.append(new Gtk.MenuItem({ label: `⚠ ${opError}`, sensitive: false }));
    m.append(new Gtk.SeparatorMenuItem());
  }

  if (currentModel && currentModel.categories.length > 0) {
    // Overdue summary
    const oc = countOverdue(currentModel);
    if (oc > 0) {
      const oi = new Gtk.MenuItem({ label: `⚠ ${oc} overdue task${oc > 1 ? 's' : ''}`, sensitive: false });
      m.append(oi);
      m.append(new Gtk.SeparatorMenuItem());
    }

    // Categories and tasks
    suppressToggle = true;
    for (const cat of currentModel.categories) {
      const header = new Gtk.MenuItem({ label: fmtCatLabel(cat), sensitive: false });
      m.append(header);
      for (const entry of cat.entries) {
        if (entry.kind === 'task') {
          const task = entry.task;
          const item = new Gtk.CheckMenuItem({ label: fmtTaskLabel(task), active: task.checked });
          const snapshot = renderedText;
          const snapshotPath = todoPath;
          item.connect('toggled', () => {
            if (!suppressToggle) handleToggle(task, snapshot, snapshotPath);
          });
          m.append(item);

          // Clickable links beneath each task.
          const links = extractLinks(task.text);
          for (const link of links) {
            const linkItem = new Gtk.MenuItem({ label: linkLabel(task.indent, link) });
            linkItem.connect('activate', () => handleOpenLink(link.url));
            m.append(linkItem);
          }
        } else {
          // Plain bullet note: non-interactive, bullet glyph, no toggle.
          const noteItem = new Gtk.MenuItem({ label: fmtNoteLabel(entry), sensitive: false });
          m.append(noteItem);

          // Links in child notes also produce separate clickable items.
          const links = extractLinks(entry.text);
          for (const link of links) {
            const linkItem = new Gtk.MenuItem({ label: linkLabel(entry.indent, link) });
            linkItem.connect('activate', () => handleOpenLink(link.url));
            m.append(linkItem);
          }
        }
      }
      m.append(new Gtk.SeparatorMenuItem());
    }
    suppressToggle = false;
  } else {
    const empty = new Gtk.MenuItem({ label: 'No tasks yet', sensitive: false });
    m.append(empty);
    m.append(new Gtk.SeparatorMenuItem());
  }

  // --- actions ---
  const addMenuItem = new Gtk.MenuItem({ label: '+  Add new item…' });
  addMenuItem.connect('activate', handleAddItem);
  m.append(addMenuItem);

  m.append(new Gtk.SeparatorMenuItem());

  const openItem = new Gtk.MenuItem({ label: 'Open todo file' });
  openItem.connect('activate', handleOpenFile);
  m.append(openItem);

  const refreshItem = new Gtk.MenuItem({ label: 'Refresh now' });
  refreshItem.connect('activate', () => {
    opError = null;
    reload();
  });
  m.append(refreshItem);

  appendChangeFile(m);

  m.append(new Gtk.SeparatorMenuItem());
  appendQuitItem(m);

  return m;
}

function appendChangeFile(m) {
  const changeItem = new Gtk.MenuItem({ label: 'Change file…' });
  changeItem.connect('activate', handleChangeFile);
  m.append(changeItem);
}

function appendQuitItem(m) {
  const quit = new Gtk.MenuItem({ label: 'Quit' });
  quit.connect('activate', () => {
    cleanup();
    Gtk.main_quit();
  });
  m.append(quit);
}

function rebuildMenu() {
  menu = buildMenu();
  menu.show_all();
  indicator.set_menu(menu);
}

// ===========================================================================
// Event handlers
// ===========================================================================

function handleOpenLink(url) {
  try {
    const uri = GLib.Uri.parse(url, GLib.UriFlags.NONE);
    const scheme = uri.get_scheme();
    if (scheme !== 'http' && scheme !== 'https')
      throw new Error(`Unsafe scheme: ${scheme}`);
    if (!uri.get_host())
      throw new Error('URL has no host');
    Gio.AppInfo.launch_default_for_uri(url, null);
  } catch (e) {
    opError = e.message || String(e);
    rebuildMenu();
  }
}

function handleToggle(task, snapshot, snapshotPath) {
  try {
    if (todoPath !== snapshotPath) {
      throw new Error('File path changed since last render');
    }
    const { text, etag } = readFile(todoPath);
    assertUnchanged(text, snapshot);
    const newText = toggleCheckbox(text, task.line, task.raw);
    writeFileAtomic(todoPath, newText, etag);
    opError = null;
  } catch (e) {
    opError = e.message || String(e);
  }
  reload();
}

function handleAddItem() {
  // Capture snapshot at dialog opening (before nested main loop).
  const snapshot = renderedText;
  const snapshotPath = todoPath;

  const result = showAddDialog();
  if (!result) return;

  if (result.due && !isValidDate(result.due)) {
    opError = `Invalid date: ${result.due}`;
    rebuildMenu();
    return;
  }

  try {
    if (todoPath !== snapshotPath) {
      throw new Error('File path changed since last render');
    }

    // Create file if it doesn't exist (explicit user action).
    if (!fileExists(todoPath)) {
      if (snapshot !== null) throw new Error('File was deleted while adding the item');
      createFileExclusive(todoPath);
    }

    const { text, etag } = readFile(todoPath);

    // Snapshot guard: reject any external change since dialog opened.
    if (snapshot !== null) {
      assertUnchanged(text, snapshot);
    } else if (text !== '') {
      // File was missing when rendered — reject if another process wrote content.
      throw new Error('File was created with content by another process');
    }

    const newText = addItem(text, result.title, result.catId, result.due);
    writeFileAtomic(todoPath, newText, etag);
    opError = null;
  } catch (e) {
    opError = e.message || String(e);
  }
  reload();
}

function handleCreateFile() {
  try {
    createFileExclusive(todoPath);
    opError = null;
  } catch (e) {
    opError = e.message || String(e);
  }
  reload();
}

function handleOpenFile() {
  try {
    const file = Gio.File.new_for_path(todoPath);
    const uri = file.get_uri().replace(/^file:\/\//, 'vscode://file');
    Gio.AppInfo.launch_default_for_uri(uri, null);
  } catch (e) {
    opError = e.message || String(e);
    rebuildMenu();
  }
}

function handleChangeFile() {
  const newPath = showFileChooser();
  if (!newPath) return;
  try {
    saveConfigPath(newPath);
    todoPath = newPath;
    opError = null;
    setupMonitors();
    reload();
  } catch (e) {
    opError = e.message || String(e);
    rebuildMenu();
  }
}

// ===========================================================================
// Dialogs
// ===========================================================================

function showAddDialog() {
  const dialog = new Gtk.Dialog({
    title: 'Add Todo Item',
    modal: true,
    use_header_bar: false,
  });
  dialog.add_button('Cancel', Gtk.ResponseType.CANCEL);
  dialog.add_button('Add', Gtk.ResponseType.OK);
  dialog.set_default_response(Gtk.ResponseType.OK);

  const content = dialog.get_content_area();
  content.set_spacing(8);
  content.set_border_width(12);

  // Title
  const titleEntry = new Gtk.Entry();
  titleEntry.set_placeholder_text('Task title');
  content.pack_start(titleEntry, false, false, 0);

  // Category combo
  const catCombo = new Gtk.ComboBoxText();
  let hasDefault = false;
  if (currentModel) {
    for (const cat of currentModel.categories) {
      if (cat.title === null) {
        catCombo.append(cat.id, 'No category');
        hasDefault = true;
      } else {
        catCombo.append(cat.id, fmtCatLabel(cat));
      }
    }
  }
  if (!hasDefault) {
    catCombo.append('__default__', 'No category');
  }
  catCombo.set_active(0);
  content.pack_start(catCombo, false, false, 0);

  // Due date
  const dateEntry = new Gtk.Entry();
  dateEntry.set_placeholder_text('Due date YYYY-MM-DD (optional)');
  content.pack_start(dateEntry, false, false, 0);

  dialog.show_all();
  const response = dialog.run();

  let result = null;
  if (response === Gtk.ResponseType.OK) {
    const title = titleEntry.get_text().trim();
    const catId = catCombo.get_active_id();
    const due = dateEntry.get_text().trim();
    if (title) {
      result = { title, catId: catId || '__default__', due: due || null };
    }
  }
  dialog.destroy();
  return result;
}

function showFileChooser() {
  const dialog = new Gtk.FileChooserDialog({
    title: 'Choose Todo File',
    action: Gtk.FileChooserAction.OPEN,
    modal: true,
    use_header_bar: false,
  });
  dialog.add_button('Cancel', Gtk.ResponseType.CANCEL);
  dialog.add_button('Select', Gtk.ResponseType.OK);
  dialog.set_default_response(Gtk.ResponseType.OK);

  const filter = new Gtk.FileFilter();
  filter.set_name('Markdown');
  filter.add_pattern('*.md');
  filter.add_pattern('*.markdown');
  dialog.add_filter(filter);

  const allFilter = new Gtk.FileFilter();
  allFilter.set_name('All files');
  allFilter.add_pattern('*');
  dialog.add_filter(allFilter);

  try {
    dialog.set_current_folder(GLib.path_get_dirname(todoPath));
  } catch (_e) { /* ignore */ }

  dialog.show_all();
  const response = dialog.run();
  let path = null;
  if (response === Gtk.ResponseType.OK) {
    path = dialog.get_filename();
  }
  dialog.destroy();
  return path;
}

// ===========================================================================
// File monitoring & timers
// ===========================================================================

function setupFileMonitor() {
  if (fileMonitor) {
    fileMonitor.cancel();
    fileMonitor = null;
  }
  const file = Gio.File.new_for_path(todoPath);
  try {
    fileMonitor = file.monitor_file(Gio.FileMonitorFlags.NONE, null);
    fileMonitor.connect('changed', () => scheduleReload());
  } catch (_e) { /* file may not exist yet */ }
}

function setupDirMonitor() {
  if (dirMonitor) {
    dirMonitor.cancel();
    dirMonitor = null;
  }
  const file = Gio.File.new_for_path(todoPath);
  const dir = file.get_parent();
  if (!dir) return;
  try {
    dirMonitor = dir.monitor_directory(Gio.FileMonitorFlags.NONE, null);
    dirMonitor.connect('changed', (_m, changedFile, _o, eventType) => {
      if (!changedFile) return;
      if (changedFile.get_basename() === file.get_basename()) {
        scheduleReload();
        // File may have been created/deleted — re-setup file monitor.
        setupFileMonitor();
      }
    });
  } catch (_e) { /* directory may not exist */ }
}

function setupPolling() {
  if (pollId) GLib.source_remove(pollId);
  pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 5000, () => {
    try {
      const info = Gio.File.new_for_path(todoPath).query_info(
        'time::modified', Gio.FileQueryInfoFlags.NONE, null);
      const mtime = info.get_attribute_uint64('time::modified');
      if (mtime !== lastPollMtime) {
        lastPollMtime = mtime;
        scheduleReload();
      }
    } catch (_e) {
      if (lastPollMtime !== 0) {
        lastPollMtime = 0;
        scheduleReload();
      }
    }
    return true; // continue
  });
}

function setupRolloverTimer() {
  if (rolloverId) GLib.source_remove(rolloverId);
  rolloverId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 60000, () => {
    const today = todayString();
    if (today !== lastToday) {
      lastToday = today;
      updateIcon();
      rebuildMenu();
    }
    return true; // continue
  });
}

function setupMonitors() {
  setupFileMonitor();
  setupDirMonitor();
}

function cleanup() {
  if (fileMonitor) fileMonitor.cancel();
  if (dirMonitor) dirMonitor.cancel();
  if (pollId) GLib.source_remove(pollId);
  if (rolloverId) GLib.source_remove(rolloverId);
  if (reloadId) GLib.source_remove(reloadId);
}

// ===========================================================================
// Initialisation (top-level await for optional AppIndicator import)
// ===========================================================================

Gtk.init(null);

// Resolve AppIndicator library (Ayatana first, then legacy).
try {
  AppIndicator = (await import('gi://AyatanaAppIndicator3?version=0.1')).default;
} catch (_e) {
  try {
    AppIndicator = (await import('gi://AppIndicator3?version=0.1')).default;
  } catch (_e2) {
    printerr('No AppIndicator library found. Install gir1.2-ayatanaappindicator3-0.1');
    system.exit(1);
  }
}

// Add icon directory to theme search path.
const theme = Gtk.IconTheme.get_default();
theme.append_search_path(ICONS_DIR);

// Create indicator.
indicator = AppIndicator.Indicator.new(
  APP_NAME, ICON_NORMAL, AppIndicator.IndicatorCategory.APPLICATION_STATUS);
indicator.set_icon_theme_path(ICONS_DIR);
indicator.set_status(AppIndicator.IndicatorStatus.ACTIVE);

// Resolve path and start.
todoPath = getTodoPath();
lastToday = todayString();
setupMonitors();
setupPolling();
setupRolloverTimer();
reload();

Gtk.main();