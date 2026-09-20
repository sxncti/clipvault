import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const PASTE_DELAY_MS = 120;
const MAX_VISIBLE_ITEMS = 12;
const CLIPBOARD_TYPE = St.ClipboardType.CLIPBOARD;

function normalizeText(text) {
    if (typeof text !== 'string')
        return '';

    return text.replace(/\r\n/g, '\n');
}

function previewText(text, maxLength = 100) {
    const oneLine = text.replace(/\s+/g, ' ').trim();
    if (oneLine.length <= maxLength)
        return oneLine;

    return `${oneLine.slice(0, maxLength - 1)}…`;
}

class HistoryStore {
    constructor(path, limit) {
        this._path = path;
        this._limit = limit;
        this.items = [];
        this._load();
    }

    setLimit(limit) {
        this._limit = limit;
        this._trim();
        this._save();
    }

    add(text) {
        const normalized = normalizeText(text);
        if (!normalized.trim())
            return false;

        const duplicateIndex = this.items.findIndex(item => item.text === normalized);
        const duplicate = duplicateIndex >= 0
            ? this.items.splice(duplicateIndex, 1)[0]
            : null;

        this.items.unshift({
            text: normalized,
            copiedAt: new Date().toISOString(),
            pinned: duplicate?.pinned ?? false,
        });
        this._trim();
        this._save();
        return true;
    }

    togglePinned(text) {
        const item = this.items.find(candidate => candidate.text === text);
        if (!item)
            return;

        item.pinned = !item.pinned;
        this._save();
    }

    remove(text) {
        this.items = this.items.filter(item => item.text !== text);
        this._save();
    }

    clear() {
        this.items = this.items.filter(item => item.pinned);
        this._save();
    }

    _trim() {
        if (this.items.length <= this._limit)
            return;

        const pinned = this.items.filter(item => item.pinned);
        const regular = this.items.filter(item => !item.pinned);
        this.items = [...pinned, ...regular.slice(0, Math.max(0, this._limit - pinned.length))];
    }

    _load() {
        try {
            if (!GLib.file_test(this._path, GLib.FileTest.EXISTS))
                return;

            const [ok, bytes] = GLib.file_get_contents(this._path);
            if (!ok)
                return;

            const parsed = JSON.parse(new TextDecoder().decode(bytes));
            if (!Array.isArray(parsed))
                return;

            this.items = parsed
                .filter(item => item && typeof item.text === 'string' && item.text.trim())
                .map(item => ({
                    text: normalizeText(item.text),
                    copiedAt: typeof item.copiedAt === 'string'
                        ? item.copiedAt
                        : new Date().toISOString(),
                    pinned: Boolean(item.pinned),
                }));
            this._trim();
        } catch (error) {
            console.error(`ClipVault: não foi possível carregar o histórico: ${error}`);
            this.items = [];
        }
    }

    _save() {
        try {
            const directory = GLib.path_get_dirname(this._path);
            GLib.mkdir_with_parents(directory, 0o700);
            GLib.chmod(directory, 0o700);
            GLib.file_set_contents(this._path, JSON.stringify(this.items, null, 2));
            GLib.chmod(this._path, 0o600);
        } catch (error) {
            console.error(`ClipVault: não foi possível salvar o histórico: ${error}`);
        }
    }
}

const ClipboardIndicator = GObject.registerClass(
class ClipboardIndicator extends PanelMenu.Button {
    _init(extension, store, settings) {
        super._init(0.0, 'ClipVault');
        this._extension = extension;
        this._store = store;
        this._settings = settings;
        this._visibleRows = [];

        this.add_child(new St.Icon({
            icon_name: 'edit-paste-symbolic',
            style_class: 'system-status-icon',
        }));

        this._searchItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        this._searchEntry = new St.Entry({
            hint_text: 'Pesquisar no histórico…',
            style_class: 'clipvault-search',
            can_focus: true,
            x_expand: true,
        });
        this._searchEntry.set_primary_icon(new St.Icon({
            icon_name: 'system-search-symbolic',
        }));
        this._searchItem.add_child(this._searchEntry);
        this.menu.addMenuItem(this._searchItem);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._historySection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._historySection);

        this._footerSeparator = new PopupMenu.PopupSeparatorMenuItem();
        this.menu.addMenuItem(this._footerSeparator);

        this._privateModeItem = new PopupMenu.PopupSwitchMenuItem(
            'Modo privado (pausar captura)',
            this._settings.get_boolean('private-mode'));
        this._privateModeItem.connect('toggled', (_item, state) => {
            this._settings.set_boolean('private-mode', state);
        });
        this.menu.addMenuItem(this._privateModeItem);

        this._clearItem = new PopupMenu.PopupMenuItem('Limpar itens não fixados');
        this._clearItem.connect('activate', () => {
            this._store.clear();
            this.render();
        });
        this.menu.addMenuItem(this._clearItem);

        this._searchEntry.clutter_text.connect('text-changed', () => this.render());
        this._searchEntry.clutter_text.connect('key-press-event', (_actor, event) => {
            const symbol = event.get_key_symbol();
            if (symbol === Clutter.KEY_Escape) {
                this.menu.close();
                return Clutter.EVENT_STOP;
            }
            if (symbol === Clutter.KEY_Down && this._visibleRows.length > 0) {
                this._visibleRows[0].grab_key_focus();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open) {
                this._extension.captureNow();
                this.render();
                GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    this._searchEntry.grab_key_focus();
                    return GLib.SOURCE_REMOVE;
                });
            } else {
                this._searchEntry.set_text('');
            }
        });

        this.render();
    }

    toggleMenu() {
        this.menu.toggle();
    }

    render() {
        if (!this._historySection)
            return;

        this._historySection.removeAll();
        this._visibleRows = [];

        const query = this._searchEntry.get_text().trim().toLocaleLowerCase();
        const matches = this._store.items
            .filter(item => !query || item.text.toLocaleLowerCase().includes(query))
            .slice(0, MAX_VISIBLE_ITEMS);

        if (matches.length === 0) {
            const message = this._store.items.length === 0
                ? 'Copie algum texto para começar'
                : 'Nenhum resultado';
            const empty = new PopupMenu.PopupMenuItem(message, {reactive: false});
            empty.label.add_style_class_name('clipvault-empty');
            this._historySection.addMenuItem(empty);
        } else {
            for (const item of matches)
                this._addHistoryRow(item);
        }

        const hasRegularItems = this._store.items.some(item => !item.pinned);
        this._clearItem.visible = hasRegularItems;
    }

    _addHistoryRow(historyItem) {
        const row = new PopupMenu.PopupBaseMenuItem({
            reactive: true,
            can_focus: true,
            style_class: 'clipvault-row',
        });
        const label = new St.Label({
            text: previewText(historyItem.text),
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        label.add_style_class_name('clipvault-row-label');
        row.add_child(label);

        const pinButton = this._makeActionButton(
            historyItem.pinned ? 'starred-symbolic' : 'non-starred-symbolic',
            historyItem.pinned ? 'Desafixar' : 'Fixar',
            () => {
                this._store.togglePinned(historyItem.text);
                this.render();
            });
        row.add_child(pinButton);

        const deleteButton = this._makeActionButton(
            'edit-delete-symbolic',
            'Excluir',
            () => {
                this._store.remove(historyItem.text);
                this.render();
            });
        row.add_child(deleteButton);

        row.connect('activate', () => this._extension.useItem(historyItem.text));
        this._historySection.addMenuItem(row);
        this._visibleRows.push(row);
    }

    _makeActionButton(iconName, accessibleName, callback) {
        const button = new St.Button({
            style_class: 'clipvault-action-button',
            can_focus: true,
            reactive: true,
            accessible_name: accessibleName,
            child: new St.Icon({icon_name: iconName}),
        });
        button.connect('clicked', callback);
        return button;
    }
});

export default class ClipVaultExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        const dataDirectory = GLib.build_filenamev([
            GLib.get_user_data_dir(),
            'clipvault',
        ]);
        this._store = new HistoryStore(
            GLib.build_filenamev([dataDirectory, 'history.json']),
            this._settings.get_int('history-size'));
        this._clipboard = St.Clipboard.get_default();
        this._selection = Shell.Global.get().get_display().get_selection();
        this._lastSeen = null;
        this._readingClipboard = false;
        this._pasteTimeoutId = 0;

        this._indicator = new ClipboardIndicator(this, this._store, this._settings);
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        Main.wm.addKeybinding(
            'toggle-menu',
            this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._indicator?.toggleMenu());

        this._historySizeChangedId = this._settings.connect(
            'changed::history-size',
            () => {
                this._store.setLimit(this._settings.get_int('history-size'));
                this._indicator?.render();
            });

        this._privateModeChangedId = this._settings.connect(
            'changed::private-mode',
            () => {
                const enabled = this._settings.get_boolean('private-mode');
                if (this._indicator?._privateModeItem.state !== enabled)
                    this._indicator?._privateModeItem.setToggleState(enabled);
                if (!enabled)
                    this.captureNow();
            });

        this._selectionChangedId = this._selection.connect(
            'owner-changed',
            (_selection, selectionType) => {
                if (selectionType === Meta.SelectionType.SELECTION_CLIPBOARD)
                    this.captureNow();
            });

        this.captureNow();
    }

    disable() {
        Main.wm.removeKeybinding('toggle-menu');

        if (this._pasteTimeoutId) {
            GLib.source_remove(this._pasteTimeoutId);
            this._pasteTimeoutId = 0;
        }
        if (this._historySizeChangedId) {
            this._settings.disconnect(this._historySizeChangedId);
            this._historySizeChangedId = 0;
        }
        if (this._privateModeChangedId) {
            this._settings.disconnect(this._privateModeChangedId);
            this._privateModeChangedId = 0;
        }
        if (this._selectionChangedId) {
            this._selection.disconnect(this._selectionChangedId);
            this._selectionChangedId = 0;
        }

        this._indicator?.destroy();
        this._indicator = null;
        this._virtualKeyboard = null;
        this._clipboard = null;
        this._selection = null;
        this._store = null;
        this._settings = null;
    }

    captureNow() {
        if (!this._clipboard || this._readingClipboard ||
            this._settings.get_boolean('private-mode'))
            return;

        const mimetypes = this._clipboard.get_mimetypes(CLIPBOARD_TYPE);
        if (mimetypes.includes('x-kde-passwordManagerHint'))
            return;

        this._readingClipboard = true;
        this._clipboard.get_text(CLIPBOARD_TYPE, (_clipboard, text) => {
            this._readingClipboard = false;
            if (!this._store)
                return;

            const normalized = normalizeText(text);
            if (!normalized || normalized === this._lastSeen)
                return;

            this._lastSeen = normalized;
            if (this._store.add(normalized))
                this._indicator?.render();
        });
    }

    useItem(text) {
        if (!this._clipboard)
            return;

        this._lastSeen = text;
        this._clipboard.set_text(CLIPBOARD_TYPE, text);
        this._store.add(text);
        this._indicator?.menu.close();

        if (!this._settings.get_boolean('auto-paste'))
            return;

        if (this._pasteTimeoutId)
            GLib.source_remove(this._pasteTimeoutId);
        this._pasteTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            PASTE_DELAY_MS,
            () => {
                this._pasteTimeoutId = 0;
                this._sendPasteShortcut();
                return GLib.SOURCE_REMOVE;
            });
    }

    _sendPasteShortcut() {
        try {
            if (!this._virtualKeyboard) {
                const seat = Clutter.get_default_backend().get_default_seat();
                this._virtualKeyboard = seat.create_virtual_device(
                    Clutter.InputDeviceType.KEYBOARD_DEVICE);
            }

            const time = GLib.get_monotonic_time();
            this._virtualKeyboard.notify_keyval(
                time, Clutter.KEY_Control_L, Clutter.KeyState.PRESSED);
            this._virtualKeyboard.notify_keyval(
                time, Clutter.KEY_v, Clutter.KeyState.PRESSED);
            this._virtualKeyboard.notify_keyval(
                time, Clutter.KEY_v, Clutter.KeyState.RELEASED);
            this._virtualKeyboard.notify_keyval(
                time, Clutter.KEY_Control_L, Clutter.KeyState.RELEASED);
        } catch (error) {
            console.error(`ClipVault: falha ao colar automaticamente: ${error}`);
            Main.notify('ClipVault', 'Item copiado. Use Ctrl+V para colar.');
        }
    }
}
