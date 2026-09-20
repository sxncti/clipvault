#!/usr/bin/env bash
set -euo pipefail

uuid="clipvault@sxncti.github.com"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
destination="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$uuid"

mkdir -p "$destination/schemas"
install -m 0644 "$script_dir/extension.js" "$destination/extension.js"
install -m 0644 "$script_dir/metadata.json" "$destination/metadata.json"
install -m 0644 "$script_dir/stylesheet.css" "$destination/stylesheet.css"
install -m 0644 \
    "$script_dir/schemas/org.gnome.shell.extensions.clipvault.gschema.xml" \
    "$destination/schemas/org.gnome.shell.extensions.clipvault.gschema.xml"
glib-compile-schemas "$destination/schemas"

echo "ClipVault instalado em: $destination"

current_tray_binding="$(
    gsettings get org.gnome.shell.keybindings toggle-message-tray 2>/dev/null || true
)"
if [[ "${current_tray_binding,,}" == *"<super>v"* ]]; then
    echo
    echo "O GNOME usa Super+V para a bandeja de notificações."
    answer="n"
    if [[ -t 0 ]]; then
        read -r -p "Liberar Super+V para o ClipVault? [S/n] " answer
        answer="${answer:-s}"
    fi

    if [[ "${answer,,}" != "n" && "${answer,,}" != "no" ]]; then
        data_directory="${XDG_DATA_HOME:-$HOME/.local/share}/clipvault"
        mkdir -p "$data_directory"
        printf '%s\n' "$current_tray_binding" > "$data_directory/message-tray-binding.backup"
        chmod 0600 "$data_directory/message-tray-binding.backup"

        filtered_binding="$(python3 - "$current_tray_binding" <<'PY'
import ast
import sys

bindings = ast.literal_eval(sys.argv[1])
print(repr([item for item in bindings if item.lower() != '<super>v']))
PY
)"
        gsettings set org.gnome.shell.keybindings toggle-message-tray "$filtered_binding"
        echo "Super+V liberado. A configuração anterior foi salva em:"
        echo "  $data_directory/message-tray-binding.backup"
    else
        echo "Super+V não foi alterado. Veja no README como liberá-lo manualmente."
    fi
fi

echo "Saia e entre novamente na sessão e execute:"
echo "  gnome-extensions enable $uuid"
