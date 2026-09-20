UUID := clipvault@sxncti.github.com
BUILD_DIR := build

.PHONY: check install package clean

check:
	glib-compile-schemas --strict --dry-run schemas
	bash -n install.sh uninstall.sh
	python3 tests/test_project.py

install: check
	./install.sh

package: check
	rm -rf $(BUILD_DIR)
	mkdir -p $(BUILD_DIR)/$(UUID)/schemas
	cp extension.js metadata.json stylesheet.css $(BUILD_DIR)/$(UUID)/
	cp schemas/*.xml $(BUILD_DIR)/$(UUID)/schemas/
	glib-compile-schemas $(BUILD_DIR)/$(UUID)/schemas
	cd $(BUILD_DIR)/$(UUID) && zip -qr ../clipvault.zip .

clean:
	rm -rf $(BUILD_DIR)
