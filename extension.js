import Clutter from 'gi://Clutter';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
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
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const IMAGE_EXTENSIONS = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/bmp': 'bmp',
    'image/tiff': 'tiff',
};
const IMAGE_FILE_PATTERN = /^[0-9a-f]{64}\.[a-z]+$/;
const LEGACY_TEXT_MIMETYPES = ['UTF8_STRING', 'STRING', 'TEXT', 'COMPOUND_TEXT'];

function isTextMimetype(mimetype) {
    return mimetype.startsWith('text/plain') || LEGACY_TEXT_MIMETYPES.includes(mimetype);
}

function pickImageMimetype(mimetypes) {
    return Object.keys(IMAGE_EXTENSIONS).find(mimetype => mimetypes.includes(mimetype)) ?? null;
}

function hashBytes(bytes) {
    return GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256, bytes);
}

function itemKey(item) {
    return item.type === 'image' ? `image:${item.hash}` : `text:${item.text}`;
}

function describeImage(item) {
    const parts = ['Imagem'];
    if (item.width > 0 && item.height > 0)
        parts.push(`${item.width}×${item.height}`);
    if (item.size > 0)
        parts.push(GLib.format_size(item.size));
    return parts.join(' · ');
}

function searchableText(item) {
    return item.type === 'image'
        ? `imagem image ${describeImage(item)}`
        : item.text;
}

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
    constructor(directory, limit) {
        this._directory = directory;
        this._path = GLib.build_filenamev([directory, 'history.json']);
        this._imageDirectory = GLib.build_filenamev([directory, 'images']);
        this._limit = limit;
        this.items = [];
        this._load();
        this._pruneImages();
    }

    setLimit(limit) {
        this._limit = limit;
        this._trim();
        this._save();
    }

    addText(text) {
        const normalized = normalizeText(text);
        if (!normalized.trim())
            return false;

        this._insert({type: 'text', text: normalized});
        return true;
    }

    addImage(bytes, mimetype, hash) {
        const file = `${hash}.${IMAGE_EXTENSIONS[mimetype]}`;
        const path = GLib.build_filenamev([this._imageDirectory, file]);

        try {
            if (!GLib.file_test(path, GLib.FileTest.EXISTS)) {
                GLib.mkdir_with_parents(this._imageDirectory, 0o700);
                GLib.chmod(this._imageDirectory, 0o700);
                GLib.file_set_contents(path, bytes.toArray());
                GLib.chmod(path, 0o600);
            }

            const [format, width, height] = GdkPixbuf.Pixbuf.get_file_info(path);
            if (!format) {
                GLib.unlink(path);
                return false;
            }

            this._insert({
                type: 'image',
                hash,
                file,
                mimetype,
                width,
                height,
                size: bytes.get_size(),
            });
            return true;
        } catch (error) {
            console.error(`ClipVault: não foi possível salvar a imagem: ${error}`);
            return false;
        }
    }

    imagePath(item) {
        return GLib.build_filenamev([this._imageDirectory, item.file]);
    }

    readImage(item) {
        try {
            const [ok, contents] = GLib.file_get_contents(this.imagePath(item));
            return ok ? new GLib.Bytes(contents) : null;
        } catch (error) {
            console.error(`ClipVault: não foi possível ler a imagem: ${error}`);
            return null;
        }
    }

    promote(key) {
        const index = this.items.findIndex(item => itemKey(item) === key);
        if (index < 0)
            return;

        const [item] = this.items.splice(index, 1);
        item.copiedAt = new Date().toISOString();
        this.items.unshift(item);
        this._save();
    }

    togglePinned(key) {
        const item = this.items.find(candidate => itemKey(candidate) === key);
        if (!item)
            return;

        item.pinned = !item.pinned;
        this._save();
    }

    remove(key) {
        this.items = this.items.filter(item => itemKey(item) !== key);
        this._save();
        this._pruneImages();
    }

    clear() {
        this.items = this.items.filter(item => item.pinned);
        this._save();
        this._pruneImages();
    }

    _insert(entry) {
        const key = itemKey(entry);
        const duplicateIndex = this.items.findIndex(item => itemKey(item) === key);
        const duplicate = duplicateIndex >= 0
            ? this.items.splice(duplicateIndex, 1)[0]
            : null;

        this.items.unshift({
            ...entry,
            copiedAt: new Date().toISOString(),
            pinned: duplicate?.pinned ?? false,
        });
        this._trim();
        this._save();
        this._pruneImages();
    }

    _trim() {
        if (this.items.length <= this._limit)
            return;

        const pinned = this.items.filter(item => item.pinned);
        const regular = this.items.filter(item => !item.pinned);
        this.items = [...pinned, ...regular.slice(0, Math.max(0, this._limit - pinned.length))];
    }

    _parseItem(item) {
        if (!item || typeof item !== 'object')
            return null;

        const copiedAt = typeof item.copiedAt === 'string'
            ? item.copiedAt
            : new Date().toISOString();
        const pinned = Boolean(item.pinned);

        if (item.type === 'image') {
            if (typeof item.file !== 'string' || !IMAGE_FILE_PATTERN.test(item.file) ||
                !(item.mimetype in IMAGE_EXTENSIONS))
                return null;

            const parsed = {
                type: 'image',
                hash: item.file.split('.')[0],
                file: item.file,
                mimetype: item.mimetype,
                width: Number(item.width) || 0,
                height: Number(item.height) || 0,
                size: Number(item.size) || 0,
                copiedAt,
                pinned,
            };
            return GLib.file_test(this.imagePath(parsed), GLib.FileTest.EXISTS)
                ? parsed
                : null;
        }

        if (typeof item.text !== 'string' || !item.text.trim())
            return null;

        return {type: 'text', text: normalizeText(item.text), copiedAt, pinned};
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
                .map(item => this._parseItem(item))
                .filter(item => item !== null);
            this._trim();
        } catch (error) {
            console.error(`ClipVault: não foi possível carregar o histórico: ${error}`);
            this.items = [];
            this._loadFailed = true;
        }
    }

    _save() {
        try {
            GLib.mkdir_with_parents(this._directory, 0o700);
            GLib.chmod(this._directory, 0o700);
            GLib.file_set_contents(this._path, JSON.stringify(this.items, null, 2));
            GLib.chmod(this._path, 0o600);
        } catch (error) {
            console.error(`ClipVault: não foi possível salvar o histórico: ${error}`);
        }
    }

    _pruneImages() {
        // Não apaga imagens se o histórico não pôde ser lido.
        if (this._loadFailed)
            return;

        try {
            const directory = Gio.File.new_for_path(this._imageDirectory);
            if (!directory.query_exists(null))
                return;

            const referenced = new Set(this.items
                .filter(item => item.type === 'image')
                .map(item => item.file));
            const enumerator = directory.enumerate_children(
                'standard::name',
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
                null);
            let info;
            while ((info = enumerator.next_file(null))) {
                const name = info.get_name();
                if (IMAGE_FILE_PATTERN.test(name) && !referenced.has(name))
                    directory.get_child(name).delete(null);
            }
            enumerator.close(null);
        } catch (error) {
            console.error(`ClipVault: não foi possível limpar imagens antigas: ${error}`);
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
            .filter(item => !query || searchableText(item).toLocaleLowerCase().includes(query))
            .slice(0, MAX_VISIBLE_ITEMS);

        if (matches.length === 0) {
            const message = this._store.items.length === 0
                ? 'Copie algum texto ou imagem para começar'
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
        if (historyItem.type === 'image') {
            const uri = GLib.filename_to_uri(this._store.imagePath(historyItem), null);
            row.add_child(new St.Widget({
                style_class: 'clipvault-thumbnail',
                style: `background-image: url("${uri}");`,
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }
        const label = new St.Label({
            text: historyItem.type === 'image'
                ? describeImage(historyItem)
                : previewText(historyItem.text),
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        label.add_style_class_name('clipvault-row-label');
        row.add_child(label);

        const pinButton = this._makeActionButton(
            historyItem.pinned ? 'starred-symbolic' : 'non-starred-symbolic',
            historyItem.pinned ? 'Desafixar' : 'Fixar',
            () => {
                this._store.togglePinned(itemKey(historyItem));
                this.render();
            });
        row.add_child(pinButton);

        const deleteButton = this._makeActionButton(
            'edit-delete-symbolic',
            'Excluir',
            () => {
                this._store.remove(itemKey(historyItem));
                this.render();
            });
        row.add_child(deleteButton);

        row.connect('activate', () => this._extension.useItem(historyItem));
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
            dataDirectory,
            this._settings.get_int('history-size'));
        this._clipboard = St.Clipboard.get_default();
        this._selection = Shell.Global.get().get_display().get_selection();
        this._lastSeen = null;
        this._readingClipboard = false;
        this._captureQueued = false;
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

        this._captureQueued = false;
        this._indicator?.destroy();
        this._indicator = null;
        this._virtualKeyboard = null;
        this._clipboard = null;
        this._selection = null;
        this._store = null;
        this._settings = null;
    }

    captureNow() {
        if (!this._clipboard || this._settings.get_boolean('private-mode'))
            return;

        if (this._readingClipboard) {
            this._captureQueued = true;
            return;
        }

        const mimetypes = this._clipboard.get_mimetypes(CLIPBOARD_TYPE);
        if (mimetypes.includes('x-kde-passwordManagerHint'))
            return;

        // Quando há texto e imagem (ex.: células de planilha), o texto vence.
        const imageMimetype = pickImageMimetype(mimetypes);
        if (imageMimetype && !mimetypes.some(isTextMimetype))
            this._captureImage(imageMimetype);
        else
            this._captureText();
    }

    _captureText() {
        this._readingClipboard = true;
        this._clipboard.get_text(CLIPBOARD_TYPE, (_clipboard, text) => {
            try {
                if (!this._store)
                    return;

                const normalized = normalizeText(text);
                if (!normalized || `text:${normalized}` === this._lastSeen)
                    return;

                this._lastSeen = `text:${normalized}`;
                if (this._store.addText(normalized))
                    this._indicator?.render();
            } finally {
                this._finishCapture();
            }
        });
    }

    _captureImage(mimetype) {
        this._readingClipboard = true;
        this._clipboard.get_content(CLIPBOARD_TYPE, mimetype, (_clipboard, bytes) => {
            try {
                if (!this._store || !bytes)
                    return;

                const size = bytes.get_size();
                if (size === 0 || size > MAX_IMAGE_BYTES)
                    return;

                const hash = hashBytes(bytes);
                if (`image:${hash}` === this._lastSeen)
                    return;

                this._lastSeen = `image:${hash}`;
                if (this._store.addImage(bytes, mimetype, hash))
                    this._indicator?.render();
            } finally {
                this._finishCapture();
            }
        });
    }

    _finishCapture() {
        this._readingClipboard = false;
        if (this._captureQueued) {
            this._captureQueued = false;
            this.captureNow();
        }
    }

    useItem(item) {
        if (!this._clipboard)
            return;

        if (item.type === 'image') {
            const bytes = this._store.readImage(item);
            if (!bytes) {
                Main.notify('ClipVault', 'Não foi possível ler esta imagem.');
                return;
            }
            this._clipboard.set_content(CLIPBOARD_TYPE, item.mimetype, bytes);
        } else {
            this._clipboard.set_text(CLIPBOARD_TYPE, item.text);
        }

        this._lastSeen = itemKey(item);
        this._store.promote(itemKey(item));
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
