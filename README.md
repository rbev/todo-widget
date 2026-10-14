# todo-widget

A standalone GNOME top-bar todo indicator backed by a plain markdown file. It runs as a per-user systemd service using GJS (GNOME JavaScript) and the AppIndicator protocol, displaying your tasks as checkbox items in a dropdown menu attached to a panel icon. The todo data lives in a single markdown file you choose — no database, no cloud, no proprietary format.

The indicator is **white/neutral** when everything is on track and turns **red** (checkbox, checkmark, and badge) when any uncompleted task is past its due date. Checkbox toggles, new-item creation, and file-path configuration are all available from the dropdown menu itself.

---

## Requirements

Requires GJS 1.72 or newer (Ubuntu 22.04+ or Debian 12+). Install the following apt packages:

```bash
sudo apt install gjs gir1.2-gtk-3.0 gir1.2-ayatanaappindicator3-0.1
```

`gjs` is the GNOME JavaScript runtime. `gir1.2-gtk-3.0` provides the GTK 3 GObject introspection bindings. `gir1.2-ayatanaappindicator3-0.1` provides the Ayatana AppIndicator library (the maintained successor to the original `libappindicator`). If only the legacy package is available, `gir1.2-appindicator3-0.1` is accepted as a fallback.

You also need the GNOME Shell AppIndicator extension enabled so that AppIndicator-based indicators appear in the top bar. On Ubuntu with the default GNOME session this is typically pre-installed; on other distributions install and enable the **AppIndicator and KStatusNotifierItem Support** extension via <https://extensions.gnome.org> or your distribution's package manager.

---

## Installation

From the repository root:

```bash
./install.sh
```

This copies the application to `~/.local/share/todo-widget/`, installs a systemd user service to `~/.config/systemd/user/todo-widget.service`, enables it, and restarts it so that reinstalling picks up code changes on a running unit. The indicator should appear in the top bar within a few seconds. No root access is required — everything lives under your home directory.

---

## Service management

```bash
systemctl --user start todo-widget      # start
systemctl --user stop todo-widget       # stop
systemctl --user restart todo-widget    # restart (picks up code changes)
systemctl --user status todo-widget     # check status
journalctl --user -u todo-widget -f     # view logs
```

---

## Configuration

**Open todo file** opens the configured Markdown file in VS Code using its `vscode://file` URI handler. VS Code must be installed with that handler registered; launch failures appear in the dropdown.

The todo file path is resolved in priority order:

1. **Config file** — `~/.config/todo-widget/path` containing a single line with the file path. A leading `~/` is expanded to your home directory.
2. **Environment variable** — `TODO_FILE` set in the systemd service environment (or your shell). Also supports `~/`.
3. **Default** — `~/notes/todo.md`

You can change the file at runtime from the dropdown menu via **"Change file…"**, which writes the chosen path to the config file and immediately switches the indicator to the new file.

To set the path manually, write the config file and then restart the service so it picks up the change:

```bash
mkdir -p ~/.config/todo-widget
echo '~/Documents/tasks.md' > ~/.config/todo-widget/path
systemctl --user restart todo-widget
```

---

## Markdown format

The parser recognises two constructs: **ATX headings** (1–6 `#` characters followed by a space) and **checkbox task items** (`- [ ]` or `- [x]`). Everything else in the file (prose, paragraphs, other lists, code) is preserved verbatim and never modified by the indicator.

### Headings (categories)

Any line beginning with 1–6 `#` characters followed by a space is treated as a category heading. Heading level is reflected in the menu via indentation. Duplicate heading text is fine — categories are distinguished by their position in the file.

### Checkbox tasks

```markdown
- [ ] Buy milk
- [x] Send weekly report
```

Both lowercase `[x]` and uppercase `[X]` are recognised as completed; the indicator normalises to lowercase `[x]` when toggling.

### Nested sub-tasks and notes

Checkbox tasks may be nested by indenting child lines with spaces (or tabs). Indented checkbox items appear as separate checkboxes in the dropdown, indented to reflect their source depth. Plain bullet lines (`- text` without a checkbox) that are indented beneath a task appear as non-interactive, read-only notes with a bullet glyph — useful for sub-points, context, or follow-up details.

```markdown
- [ ] Parent task
  - [ ] Child checkbox task
  - Plain note child
```

All three lines are displayed in source order: the parent checkbox, the indented child checkbox (independently toggleable), and the indented plain bullet note. Web links in child notes are extracted into separate clickable menu items just like links in task text.

Only plain bullets that are descendants of a checkbox task block are shown — standalone top-level bullets or indented bullets after unindented prose are not displayed. Blank lines within a subtree are fine; a new heading, unindented prose, or an unindented fenced code block ends the subtree.

### Due dates

An optional due-date prefix may appear immediately after the checkbox, enclosed in square brackets in `YYYY-MM-DD` format:

```markdown
- [ ] [2026-03-15] Submit tax return
```

The date must be a valid calendar date. An expression like `- [ ] [urgent] call boss` is **not** treated as a due date — the bracketed text does not match the date format, so it remains part of the task title.

### Fenced code blocks

Headings and checkbox lines inside fenced code blocks (`` ``` `` or `~~~`) are ignored. A closing fence must be at least as long as the opening fence (e.g. `` ```` `` opens, `~~~` does **not** close it).

### Default (unheaded) category

Tasks that appear before the first heading belong to a "No category" section at the top of the dropdown menu.

---

## Due-date semantics

- An **uncompleted** task whose due date is **strictly before** today (in your local timezone) is **overdue**.
- A task due **today** is **not** overdue.
- A **completed** task is **never** overdue, regardless of its due date.
- A task with **no due date** or an **invalid** due date is never overdue.

When any uncompleted task is overdue, the panel icon turns red. A warning count appears at the top of the dropdown menu. A 60-second timer checks for date rollover so that tasks become overdue at midnight without manual refresh.

---

## External edit conflict behaviour

The indicator is designed to **never silently overwrite your edits**:

- **Automatic detection.** The todo file's parent directory is monitored with `GFileMonitor`, and a 5-second polling fallback checks the file's modification time. External edits — including atomic replacement (e.g. `:w` in Vim, `git checkout`, redirecting output) — are picked up and the menu is refreshed.

- **Conservative snapshot guard.** When the menu is rendered, the indicator stores the exact file text. Each checkbox captures that text and the current file path when its menu item is built; the Add dialog captures them when it opens. On any action (toggle or add), the indicator re-reads the file fresh and compares it byte-for-byte to the snapshot. If **anything** changed — even a single character — the operation is **rejected** and the menu refreshes to show the current state. This conservative equality check prevents duplicate task lines, changed category indexes, or fence context from causing writes to the wrong item. The user can retry the action after the refresh.

- **Etag-guarded atomic write.** The mutated content is written with `g_file_replace_contents`, passing the etag from the fresh read. If the file changed between the read and the write (a race condition), the write **fails** and no data is lost. Writes require an etag-supporting filesystem; on filesystems that return a null etag (some NFS or FUSE configurations), writes are refused with a clear error to avoid best-effort overwrites.

- **Failed operations stay visible.** When a toggle, add, or create fails, the error message is shown at the top of the menu but the current tasks and all actions remain available — the menu is not locked to Change/Quit only. The error persists until the next successful action or an explicit "Refresh now".

- **Deleted file.** If the todo file is deleted, the indicator shows a "No todo file found" message with **Create file** and **Add new item** actions. It never recreates the file automatically. When you add the first item to a missing file, the file is created with exclusive creation (`O_CREAT | O_EXCL` semantics) so that a file created by another process in the meantime is not clobbered.

- **Line-ending preservation.** CRLF (`\r\n`) and LF (`\n`) line endings are detected per line and preserved. Mixed-EOL files are reconstructed byte-for-byte; only genuinely new lines use the file's dominant EOL style. The presence or absence of a trailing newline is preserved. Prose, blank lines, and completed tasks are never touched.

---

## Adding items

Click **"+ Add new item…"** in the dropdown to open a dialog with:

- **Task title** — the text of the new task. Must be a single non-empty line; blank or multiline titles are rejected.
- **Category** — a dropdown of existing headings (plus "No category"). The new task is inserted under the chosen heading, after the last task's entire block — including any indented sub-bullets, nested checkboxes, and blank lines between them — and before the next heading or unindented content, so nested structure is never corrupted.
- **Due date** — optional `YYYY-MM-DD`. Invalid dates are rejected.

If the file does not yet exist, adding an item creates it (with exclusive creation to avoid races).

---

## Clickable links in tasks

Web links embedded in task text are extracted and displayed as separate, indented menu items beneath each task's checkbox. Because AppIndicator menu labels are plain text with no inline click regions, links cannot be made clickable inside the checkbox label itself — they appear as standalone items prefixed with `↳`. Activating a link item opens the URL in your system's default application via `Gio.AppInfo.launch_default_for_uri`; if the launch fails the error is shown at the top of the menu.

The following Markdown link syntaxes are recognised:

- **Inline links** — `[label](https://example.com)` — the label is shown in the menu item, and the raw `[label](url)` syntax is replaced with just the label in the checkbox label for cleaner display.
- **Bare URLs** — `https://example.com/path` — the URL itself is shown.
- **Angle-bracket autolinks** — `<https://example.com>` — the URL itself is shown.

Only `http` and `https` URLs are extracted and launched. Other schemes (`javascript:`, `file:`, `data:`, `mailto:`, etc.) are silently ignored — no link menu item is created for them. URLs are validated with the standard URL parser before launching, and duplicate URLs within a single task are deduplicated. Common trailing punctuation (periods, commas, semicolons, etc.) and unmatched closing parentheses are trimmed from bare URLs, while balanced parentheses inside URLs (e.g. Wikipedia articles) are preserved.

The raw Markdown on disk is never modified by link extraction or display — the task text remains exactly as you wrote it.

---

## Testing

Pure parsing, mutation, date-logic, and assertion modules are tested with Node's built-in test runner — no external dependencies required:

```bash
node --test
```

This covers markdown parsing (headings, checkboxes, due dates, fences, CRLF, mixed EOL, fence length, no trailing newline, empty file, duplicate headings, nested sub-tasks and plain bullet notes, tab indentation, block-context boundaries), date validation and overdue logic, checkbox toggling and item addition with byte-level EOL preservation, sub-bullet insertion after nested blocks, stale rejection and snapshot guard, multiline title rejection, link extraction with URL validation and deduplication, real handler tests with mocked platform APIs (including nested entry display, child toggle isolation, link activation in child notes, and launch failure), service module-mode contract assertions, and install-script smoke testing.

---

## Uninstallation

```bash
./uninstall.sh
```

This stops and disables the service, removes the service file, and deletes `~/.local/share/todo-widget/`. Your **todo file** and **config** (`~/.config/todo-widget/`) are preserved.

---

## Limitations

- **GUI runtime untested in this environment.** GJS and GTK are not installed in the development sandbox; only the pure logic modules, shell scripts, and contract assertions have been validated. The indicator was written following the GJS ES module and GTK 3 GObject-introspection APIs but has not been run end-to-end.
- The AppIndicator protocol does not support text-entry widgets inside the dropdown menu, so new items are created via a separate Gtk dialog window.
- **Host rendering limit.** The checkbox appearance of `Gtk.CheckMenuItem` items in the dropdown depends on the AppIndicator implementation and GNOME Shell panel extension. On some desktop environments or panel extensions the checkmark glyph may render differently or not at all; the completion state is still tracked correctly regardless of visual appearance.
- `setext` headings (underlined with `=` or `-`) are not treated as categories — only ATX (`#`) headings are recognised.
- Tasks inside blockquotes or HTML blocks are not specially handled; only checkbox list items outside fenced code blocks are treated as tasks.