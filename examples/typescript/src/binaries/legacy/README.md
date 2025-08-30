Legacy firmware folder (source)

Place older/archived firmware .bin files here (src side). On build, ensure they are copied to dist/binaries/legacy.

Two ways to list firmware:
1) Add a manifest.json with { "items": [ { "file": "your.bin", "address": "0x10000" }, ... ] }
2) Without manifest, directory listing fallback may work on some static servers (not guaranteed in dev/preview).

Notes:
- The UI dropdown always shows the filename; tooltips mark legacy.
- Address is required in manifest unless you encode it in the filename as 0x<addr>_<file>.bin or 0x<addr>-<file>.bin.
