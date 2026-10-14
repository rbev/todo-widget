#!/usr/bin/env bash
set -euo pipefail

APP_NAME="todo-widget"
INSTALL_DIR="$HOME/.local/share/$APP_NAME"
SERVICE_DIR="$HOME/.config/systemd/user"
SERVICE_FILE="$SERVICE_DIR/${APP_NAME}.service"

echo "Uninstalling ${APP_NAME}…"

# Stop and disable the service.
systemctl --user stop "${APP_NAME}.service" 2>/dev/null || true
systemctl --user disable "${APP_NAME}.service" 2>/dev/null || true

# Remove service file and reload.
rm -f "$SERVICE_FILE"
systemctl --user daemon-reload

# Remove installed application files.
rm -rf "$INSTALL_DIR"

echo ""
echo "Done.  Your todo file and config (~/.config/${APP_NAME}/) have been preserved."