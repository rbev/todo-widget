#!/usr/bin/env bash
set -euo pipefail

APP_NAME="todo-widget"
INSTALL_DIR="$HOME/.local/share/$APP_NAME"
SERVICE_DIR="$HOME/.config/systemd/user"
SERVICE_FILE="$SERVICE_DIR/$APP_NAME.service"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Installing ${APP_NAME}…"

# Create install directories (mkdir targets so cp never nests on reinstall).
mkdir -p "$INSTALL_DIR" "$INSTALL_DIR/lib" "$INSTALL_DIR/icons"
cp "$SCRIPT_DIR/indicator.js" "$INSTALL_DIR/"
cp -r "$SCRIPT_DIR/lib/." "$INSTALL_DIR/lib/"
cp -r "$SCRIPT_DIR/icons/." "$INSTALL_DIR/icons/"
chmod +x "$INSTALL_DIR/indicator.js"

# Install systemd user service.
mkdir -p "$SERVICE_DIR"
cp "$SCRIPT_DIR/${APP_NAME}.service" "$SERVICE_FILE"
systemctl --user daemon-reload
# Enable then restart so reinstall picks up code changes on a running unit.
systemctl --user enable "${APP_NAME}.service"
systemctl --user restart "${APP_NAME}.service"

echo ""
echo "Done.  The indicator should appear in the GNOME top bar."
echo ""
echo "  Config file: ~/.config/${APP_NAME}/path"
echo "  Default todo: ~/notes/todo.md"
echo ""
echo "Manage the service with:"
echo "  systemctl --user start ${APP_NAME}"
echo "  systemctl --user stop ${APP_NAME}"
echo "  systemctl --user restart ${APP_NAME}"