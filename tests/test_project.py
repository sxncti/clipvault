#!/usr/bin/env python3
import json
import pathlib
import re
import unittest
import xml.etree.ElementTree as ET


ROOT = pathlib.Path(__file__).resolve().parents[1]


class ProjectTests(unittest.TestCase):
    def test_metadata(self):
        metadata = json.loads((ROOT / "metadata.json").read_text())
        self.assertEqual(metadata["uuid"], "clipvault@sxncti.github.com")
        self.assertIn("50", metadata["shell-version"])
        self.assertEqual(
            metadata["settings-schema"],
            "org.gnome.shell.extensions.clipvault",
        )

    def test_schema_has_expected_settings(self):
        schema_path = ROOT / "schemas/org.gnome.shell.extensions.clipvault.gschema.xml"
        tree = ET.parse(schema_path)
        keys = {node.attrib["name"] for node in tree.findall(".//key")}
        self.assertEqual(
            keys,
            {"toggle-menu", "history-size", "auto-paste", "private-mode"},
        )

    def test_extension_registers_and_removes_keybinding(self):
        source = (ROOT / "extension.js").read_text()
        self.assertRegex(source, r"addKeybinding\(\s*'toggle-menu'")
        self.assertIn("removeKeybinding('toggle-menu')", source)

    def test_clipboard_listener_is_event_driven(self):
        source = (ROOT / "extension.js").read_text()
        self.assertIn("'owner-changed'", source)
        self.assertNotIn("POLL_INTERVAL_MS", source)
        self.assertIn("x-kde-passwordManagerHint", source)

    def test_panel_subclass_has_gtype(self):
        source = (ROOT / "extension.js").read_text()
        self.assertIn("import GObject from 'gi://GObject'", source)
        self.assertRegex(
            source,
            r"GObject\.registerClass\(\s*class ClipboardIndicator",
        )
        self.assertIn("super._init(0.0, 'ClipVault')", source)

    def test_no_obvious_secrets(self):
        combined = "\n".join(
            path.read_text(errors="replace")
            for path in ROOT.rglob("*")
            if path.is_file() and ".git" not in path.parts
        )
        forbidden = [
            r"ghp_[A-Za-z0-9]{30,}",
            r"github_pat_[A-Za-z0-9_]{30,}",
            r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----",
        ]
        for pattern in forbidden:
            self.assertIsNone(re.search(pattern, combined), pattern)


if __name__ == "__main__":
    unittest.main()
