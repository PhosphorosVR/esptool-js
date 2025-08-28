Place your prebuilt firmware .bin files in this folder and list them in manifest.json like:

{
  "items": [
    { "name": "firmware-v1.0.bin", "file": "firmware-v1.0.bin", "address": "0x0" },
    { "name": "bootloader.bin", "file": "bootloader.bin", "address": "0x1000" }
  ]
}

- name: Label shown in dropdown (defaults to filename if omitted)
- file: relative path to the .bin in this folder
- address: default flash address for this file (hex string)