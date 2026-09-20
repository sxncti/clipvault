#!/usr/bin/env bash
set -euo pipefail

uuid="clipvault@sxncti.github.com"
destination="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$uuid"

gnome-extensions disable "$uuid" 2>/dev/null || true

if [[ -d "$destination" ]]; then
    timestamp="$(date +%Y%m%d-%H%M%S)"
    backup="${destination}.removed-${timestamp}"
    mv "$destination" "$backup"
    echo "Extensão removida. Backup recuperável em: $backup"
else
    echo "ClipVault não está instalado."
fi

echo "O histórico foi preservado em: ${XDG_DATA_HOME:-$HOME/.local/share}/clipvault/history.json"
