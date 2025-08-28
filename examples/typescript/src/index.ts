const baudrates = document.getElementById("baudrates") as HTMLSelectElement;
const connectButton = document.getElementById("connectButton") as HTMLButtonElement;
const traceButton = document.getElementById("copyTraceButton") as HTMLButtonElement;
const disconnectButton = document.getElementById("disconnectButton") as HTMLButtonElement;
const resetButton = document.getElementById("resetButton") as HTMLButtonElement;
const consoleStartButton = document.getElementById("consoleStartButton") as HTMLButtonElement;
const consoleStopButton = document.getElementById("consoleStopButton") as HTMLButtonElement;
const eraseButton = document.getElementById("eraseButton") as HTMLButtonElement;
const addFileButton = document.getElementById("addFile") as HTMLButtonElement;
const programButton = document.getElementById("programButton");
const prebuiltSelect = document.getElementById("prebuiltSelect") as HTMLSelectElement;
const filesDiv = document.getElementById("files");
const terminal = document.getElementById("terminal");
const programDiv = document.getElementById("program");
const consoleDiv = document.getElementById("console");
const lblBaudrate = document.getElementById("lblBaudrate");
// No separate console baud selector; reuse the connected baudrate
const lblConsoleFor = document.getElementById("lblConsoleFor");
const lblConnTo = document.getElementById("lblConnTo");
const table = document.getElementById("fileTable") as HTMLTableElement;
const alertDiv = document.getElementById("alertDiv");

const debugLogging = document.getElementById("debugLogging") as HTMLInputElement;

function switchToConsoleTab() {
  const tabConsole = document.querySelector('#tabs .tab[data-target="console"]') as HTMLElement | null;
  if (tabConsole) {
    tabConsole.classList.remove("disabled");
    tabConsole.click();
    return;
  }
  // Fallback: directly toggle sections if tabs aren't ready yet
  if (programDiv && consoleDiv) {
    programDiv.style.display = "none";
    consoleDiv.style.display = "block";
  }
}



// ---- WiFi Auto-Setup via JSON serial protocol ----
async function sendJsonCommand(command: string, params?: any, timeoutMs = 15000): Promise<any> {
  if (!transport) throw new Error("Not connected");
  const cmdObj: any = { commands: [{ command }] };
  if (params !== undefined) cmdObj.commands[0].data = params;
  const payload = JSON.stringify(cmdObj) + "\n";

  const enc = new TextEncoder();
  const data = enc.encode(payload);
  // @ts-ignore
  const dev: any = transport?.device;
  let writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  try {
    // @ts-ignore
    writer = dev?.writable?.getWriter ? dev.writable.getWriter() : null;
    if (!writer) throw new Error("Writer not available");
    await writer.write(data);
  } finally {
    try { writer?.releaseLock?.(); } catch {}
  }

  const dec = new TextDecoder();
  let buffer = "";
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const loop = transport.rawRead();
    const { value, done } = await loop.next();
    if (done) break;
    if (!value) continue;
    buffer += dec.decode(value, { stream: true });

    // Special handling: scan_networks may emit a raw multi-line JSON {"networks":[...]}
    if (command === 'scan_networks') {
      const m = buffer.match(/\{\s*"networks"\s*:\s*\[([\s\S]*?)\]\s*\}/);
      if (m && m[0]) {
        // Return in a format compatible with existing parser
        return { results: [ JSON.stringify({ result: m[0] }) ] };
      }
    }

    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed);
        return obj;
      } catch {
        const startIdx = trimmed.indexOf("{");
        const endIdx = trimmed.lastIndexOf("}");
        if (startIdx !== -1 && endIdx > startIdx) {
          try {
            const obj = JSON.parse(trimmed.slice(startIdx, endIdx + 1));
            return obj;
          } catch {}
        }
      }
    }
  }
  throw new Error("Timeout waiting for response");
}

function parseNetworksFromResults(resp: any): Array<{ssid: string; rssi: number; channel: number; auth_mode: number; mac_address?: string}> {
  // 1) Direct format: { networks: [...] }
  if (resp && Array.isArray(resp.networks)) {
    return resp.networks;
  }
  // 2) Nested results formats (strings or objects)
  const resArr = resp?.results || [];
  for (const entry of resArr) {
    try {
      // entry may be a JSON string or an object
      const obj = typeof entry === 'string' ? JSON.parse(entry) : entry;
      let payload: any = obj;
      if (payload && typeof payload.result !== 'undefined') {
        payload = payload.result;
      }
      if (typeof payload === 'string') {
        // If string contains a networks JSON, parse it
        if (payload.indexOf('"networks"') !== -1) {
          const parsed = JSON.parse(payload);
          if (Array.isArray(parsed.networks)) return parsed.networks;
        }
      } else if (payload && Array.isArray(payload.networks)) {
        return payload.networks;
      }
    } catch {}
  }
  return [];
}

async function wifiScanAndDisplay() {
  const statusEl = document.getElementById('wifiStatusMsg') as HTMLElement | null;
  try {
    statusEl && (statusEl.textContent = 'Scanning...');
    await sendJsonCommand('pause', { pause: true }, 5000);
    const scanResp = await sendJsonCommand('scan_networks', undefined, 30000);
    const nets = parseNetworksFromResults(scanResp);
    nets.sort((a, b) => (b.rssi || -999) - (a.rssi || -999));
  const tableEl = document.getElementById('wifiTable') as HTMLElement | null;
  const body = document.getElementById('wifiTableBody') as HTMLElement | null;
  const hintEl = document.getElementById('wifiHint') as HTMLElement | null;
    if (body) body.innerHTML = '';
    const selBox = document.getElementById('wifiSelectionBox') as HTMLElement | null;
    const ssidLabel = document.getElementById('wifiSelectedSsidLabel') as HTMLElement | null;
    const pwdField = document.getElementById('wifiPwdField') as HTMLElement | null;
    if (nets.length === 0) {
      statusEl && (statusEl.textContent = 'No networks found');
      if (tableEl) tableEl.style.display = 'none';
      if (hintEl) hintEl.style.display = 'none';
      return;
    }
    if (tableEl) tableEl.style.display = 'table';
    if (hintEl) hintEl.style.display = 'flex';
    nets.forEach((n, idx) => {
      const tr = document.createElement('tr');
      const open = (n.auth_mode === 0);
      const radioId = `wifiSel_${idx}`;
      const lockIcon = open ? '🔓' : '🔒';
      const label = n.ssid && n.ssid.length ? n.ssid : '<hidden>';
      tr.innerHTML = `
        <td class="col-select"><input type="radio" name="wifiNet" id="${radioId}" /></td>
        <td><label for="${radioId}" class="wifi-ssid">${lockIcon} ${label}</label></td>
        <td>${n.rssi} dBm</td>
      `;
      // When the radio changes, show selection box and set password visibility
      const radio = tr.querySelector('input[type="radio"]') as HTMLInputElement;
      radio.addEventListener('change', () => {
        if (!radio.checked) return;
        Array.from((body as HTMLElement).children).forEach((row) => row.classList.remove('active'));
        tr.classList.add('active');
        if (ssidLabel) ssidLabel.textContent = label.replace('&lt;hidden&gt;', '<hidden>');
        if (selBox) selBox.style.display = 'flex';
        if (pwdField) pwdField.style.display = open ? 'none' : 'inline-block';
        (ssidLabel as any)._auth_mode = n.auth_mode;
        (ssidLabel as any)._ssid = n.ssid || '';
      });
      body?.appendChild(tr);
    });
    statusEl && (statusEl.textContent = `Found ${nets.length} networks`);
  } catch (e) {
    statusEl && (statusEl.textContent = `Scan failed: ${e.message || e}`);
  }
}

async function wifiConnectSelected() {
  const statusEl = document.getElementById('wifiStatusMsg') as HTMLElement | null;
  const ssidLabel = document.getElementById('wifiSelectedSsidLabel') as HTMLElement | null;
  const pwdEl = document.getElementById('wifiPassword') as HTMLInputElement | null;
  const ssid = (ssidLabel as any)?._ssid?.trim();
  const authMode = (ssidLabel as any)?._auth_mode ?? 1;
  if (!ssid) { statusEl && (statusEl.textContent = 'Please select a network first'); return; }
  const open = authMode === 0;
  const password = open ? '' : (pwdEl?.value || '');

  try {
    statusEl && (statusEl.textContent = 'Applying WiFi settings...');
    const setResp = await sendJsonCommand('set_wifi', { name: 'main', ssid, password, channel: 0, power: 0 }, 15000);
    if (setResp.error) throw new Error(setResp.error);
    statusEl && (statusEl.textContent = 'Connecting...');
    await sendJsonCommand('connect_wifi', {}, 10000);
    const start = Date.now();
    let ip: string | null = null;
    while (Date.now() - start < 30000) {
      const st = await sendJsonCommand('get_wifi_status', {}, 5000);
      const arr = st.results || [];
      if (arr.length) {
        try {
          const inner = JSON.parse(arr[0]);
          let payload: any = inner.result;
          if (typeof payload === 'string') payload = JSON.parse(payload);
          const cand = payload?.ip_address;
          if (cand && cand !== '0.0.0.0') { ip = cand; break; }
        } catch {}
      }
      await new Promise(r => setTimeout(r, 500));
    }
    statusEl && (statusEl.textContent = ip ? `Connected: ${ip}` : 'Connection not confirmed');
  } catch (e) {
    statusEl && (statusEl.textContent = `Error: ${e.message || e}`);
  }
}

// This is a frontend example of Esptool-JS using local bundle file
// To optimize use a CDN hosted version like
// https://unpkg.com/esptool-js@0.5.0/bundle.js
import { ESPLoader, FlashOptions, LoaderOptions, Transport } from "../../../lib";
import { serial } from "web-serial-polyfill";

const serialLib = !navigator.serial && navigator.usb ? serial : navigator.serial;

declare let Terminal; // Terminal is imported in HTML script
declare let CryptoJS; // CryptoJS is imported in HTML script

const term = new Terminal({ cols: 120, rows: 40, convertEol: true, scrollback: 5000 });
// Expose globally for UI resize logic
// @ts-ignore
;(window as any).term = term;
term.open(terminal);
// Helper: adjust terminal rows to match small/fullscreen modes so bottom is visible
function adjustTerminalSize() {
  try {
    const wrap = document.getElementById('terminalWrapper');
    const isFull = wrap?.classList.contains('fullscreen');
    // Small mode uses ~20 rows, fullscreen uses ~40 rows
    term.resize(120, isFull ? 40 : 20);
  } catch {}
}
// Expose for inline scripts
// @ts-ignore
(window as any).adjustTerminalSize = adjustTerminalSize;
// When console section becomes visible, size terminal and scroll to bottom
try {
  const consoleSection = document.getElementById('console');
  if (consoleSection) {
    const mo = new MutationObserver(() => {
      if ((consoleSection as HTMLElement).style.display !== 'none') {
        setTimeout(() => { adjustTerminalSize(); try { term.scrollToBottom(); } catch {} }, 50);
      }
    });
    mo.observe(consoleSection, { attributes: true, attributeFilter: ['style'] });
  }
} catch {}
// Also react to window resizes
try { window.addEventListener('resize', () => { adjustTerminalSize(); }); } catch {}
// Track whether we're at the bottom to auto-scroll new output unless user scrolled up
let autoScroll = true;
function isAtBottom(): boolean {
  try {
    // @ts-ignore
    const buf = (term as any).buffer?.active;
    if (!buf) return true;
    // At bottom when viewport is at baseY
    return buf.viewportY === buf.baseY;
  } catch { return true; }
}
try {
  // @ts-ignore
  term.onScroll?.(() => {
    autoScroll = isAtBottom();
  });
} catch {}
// Allow Ctrl/Cmd+C to copy selected text instead of sending ^C
try {
  // @ts-ignore
  term.attachCustomKeyEventHandler((ev: KeyboardEvent) => {
    const isCopy = (ev.ctrlKey || ev.metaKey) && (ev.key === 'c' || ev.key === 'C');
    if (isCopy) {
      const sel = (term as any).getSelection ? (term as any).getSelection() : '';
      if (sel && sel.length) {
        try { navigator.clipboard?.writeText(sel); } catch {}
        // Prevent terminal from handling this as input (^C)
        ev.preventDefault?.();
        return false;
      }
    }
    return true;
  });
} catch {}

let device = null;
let transport: Transport;
let chip: string = null;
let esploader: ESPLoader;
let deviceMac: string = null;
let lastBaud: number = 115200; // track the active baudrate used for connections
let isConnected = false;
// @ts-ignore
(window as any).isConnected = isConnected;

disconnectButton.style.display = "none";
traceButton.style.display = "none";
eraseButton.style.display = "none";
consoleStopButton.style.display = "none";
resetButton.style.display = "none";
filesDiv.style.display = "none";

function extractDeviceInfo(dev: any): { serial?: string; product?: string; manufacturer?: string; comName?: string } {
  const out: { serial?: string; product?: string; manufacturer?: string; comName?: string } = {};
  try {
    const usb = dev?.device || dev?.device_ || dev?.usbDevice || dev?._device || dev?.port_?.device;
    if (usb) {
      out.serial = usb.serialNumber || usb.serial || usb.sn || undefined;
      out.product = usb.productName || usb.product || undefined;
      out.manufacturer = usb.manufacturerName || usb.manufacturer || undefined;
    }
    // Browsers do not expose COM port names via Web Serial for privacy; keep undefined.
  } catch (_) {
    // Ignore
  }
  return out;
}

function cleanChipName(name: string): string {
  // Remove any parenthetical info like (QFN56), (revision v1.0), etc.
  return typeof name === "string" ? name.replace(/\s*\(.*?\)/g, "").trim() : name;
}

// Ensure we have a usable, connected transport at the desired baud.
async function ensureTransportConnected(baud?: number) {
  if (device === null) {
    device = await serialLib.requestPort({});
  }
  if (transport) {
    try { await transport.disconnect(); } catch {}
    try { await transport.waitForUnlock(500); } catch {}
  }
  transport = new Transport(device, true);
  const b = baud || lastBaud || parseInt(baudrates?.value || '115200');
  lastBaud = b;
  await transport.connect(b);
}

/**
 * The built in Event object.
 * @external Event
 * @see {@link https://developer.mozilla.org/en-US/docs/Web/API/Event}
 */

/**
 * File reader handler to read given local file.
 * @param {Event} evt File Select event
 */
function handleFileSelect(evt) {
  const file = evt.target.files[0];

  if (!file) return;

  const reader = new FileReader();

  reader.onload = (ev: ProgressEvent<FileReader>) => {
    evt.target.data = ev.target.result;
  };

  reader.readAsBinaryString(file);
}

const espLoaderTerminal = {
  clean() {
    term.clear();
  },
  writeLine(data) {
    term.writeln(data);
  },
  write(data) {
    term.write(data);
  },
};

// Load prebuilt firmware manifest (prefer bundler URL, fallback to relative URL)
let prebuiltItems: Array<{ name?: string; file: string; address?: string }> = [];
async function fetchJson(url: string) {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  }
}
async function loadPrebuiltManifest() {
  try {
    const manifestUrl = new URL("./binaries/manifest.json", import.meta.url).toString();
    let json = await fetchJson(manifestUrl);
    if (!json) {
      // Fallback: relative to page
      json = await fetchJson("./binaries/manifest.json");
    }
    prebuiltItems = Array.isArray(json?.items) ? json.items : [];
    if (prebuiltSelect) {
      // Clear existing options except placeholder
      for (let i = prebuiltSelect.options.length - 1; i >= 1; i--) {
        prebuiltSelect.remove(i);
      }
      prebuiltItems.forEach((it, idx) => {
        const opt = document.createElement("option");
        opt.value = String(idx);
  const label = it.name || it.file;
  opt.textContent = label;
  opt.title = label; // show full name on hover
        prebuiltSelect.appendChild(opt);
      });
    }
  } catch (e) {
    console.warn("No prebuilt manifest or failed to load.", e);
  }
}
loadPrebuiltManifest();

connectButton.onclick = async () => {
  try {
  // If console loop is running, stop it before (re)connecting
  isConsoleClosed = true;
    if (device === null) {
      device = await serialLib.requestPort({});
    }
    // Always create a fresh Transport on (re)connect to avoid stale locks
    transport = new Transport(device, true);
    const flashOptions = {
      transport,
      baudrate: parseInt(baudrates.value),
      terminal: espLoaderTerminal,
      debugLogging: debugLogging.checked,
    } as LoaderOptions;
    lastBaud = parseInt(baudrates.value) || 115200;
    esploader = new ESPLoader(flashOptions);

    chip = await esploader.main();
    try {
      deviceMac = await esploader.chip.readMac(esploader);
    } catch (e) {
      console.warn("Could not read MAC:", e);
      deviceMac = null;
    }

  // Temporarily broken
  // await esploader.flashId();
  console.log("Settings done for :" + chip);
  lblBaudrate.style.display = "none";
  // Build a friendly connection info line (chip · VID/PID · baud)
  const info = extractDeviceInfo(transport?.device);
  const parts: string[] = [];
  if (chip) parts.push(cleanChipName(chip));
  if (info.serial && info.product) parts.push(`${info.product} (SN ${info.serial})`);
  else if (info.serial) parts.push(`SN ${info.serial}`);
  else if (info.product && info.manufacturer) parts.push(`${info.manufacturer} ${info.product}`);
  if (deviceMac) parts.push(deviceMac.toUpperCase());
  if (baudrates?.value) parts.push(`${baudrates.value} baud`);
  lblConnTo.innerHTML = `Connected: ${parts.join(" · ")}`;
    lblConnTo.style.display = "block";
    baudrates.style.display = "none";
    connectButton.style.display = "none";
    disconnectButton.style.display = "initial";
    traceButton.style.display = "initial";
    eraseButton.style.display = "initial";
    filesDiv.style.display = "initial";
  isConnected = true;
  // @ts-ignore
  (window as any).isConnected = true;
  // Do not force-hide console panel; tabs manage visibility
  // Explicitly switch to Flashing tab after connect
  const tabProgram = document.querySelector('#tabs .tab[data-target="program"]') as HTMLElement | null;
  if (tabProgram) tabProgram.click();
  } catch (e) {
    console.error(e);
    term.writeln(`Error: ${e.message}`);
  isConnected = false;
  // @ts-ignore
  (window as any).isConnected = false;
  }
};

traceButton.onclick = async () => {
  if (transport) {
    transport.returnTrace();
  }
};

resetButton.onclick = async () => {
  if (transport) {
    await transport.setDTR(false);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await transport.setDTR(true);
  }
};

eraseButton.onclick = async () => {
  eraseButton.disabled = true;
  try {
  // Ensure console loop is stopped before erase
  isConsoleClosed = true;
  // Switch to Console view when erase starts
  switchToConsoleTab();
    await esploader.eraseFlash();
  } catch (e) {
    console.error(e);
    term.writeln(`Error: ${e.message}`);
  } finally {
    eraseButton.disabled = false;
  }
};

addFileButton.onclick = () => {
  const rowCount = table.rows.length;
  const row = table.insertRow(rowCount);

  //Column 1 - Offset
  const cell1 = row.insertCell(0);
  const element1 = document.createElement("input");
  element1.type = "text";
  element1.id = "offset" + rowCount;
  element1.value = "0x0";
  cell1.appendChild(element1);

  // Column 2 - File selector
  const cell2 = row.insertCell(1);
  const element2 = document.createElement("input");
  element2.type = "file";
  element2.id = "selectFile" + rowCount;
  element2.name = "selected_File" + rowCount;
  element2.addEventListener("change", handleFileSelect, false);
  cell2.appendChild(element2);

  // Column 3  - Progress
  const cell3 = row.insertCell(2);
  cell3.classList.add("progress-cell");
  cell3.style.display = "none";
  cell3.innerHTML = `<progress value="0" max="100"></progress>`;

  // Column 4  - Remove File
  const cell4 = row.insertCell(3);
  cell4.classList.add("action-cell");
  if (rowCount > 1) {
    const element4 = document.createElement("input");
    element4.type = "button";
    const btnName = "button" + rowCount;
    element4.name = btnName;
    element4.setAttribute("class", "btn");
    element4.setAttribute("value", "Remove"); // or element1.value = "button";
    element4.onclick = function () {
      removeRow(row);
    };
    cell4.appendChild(element4);
  }
};

/**
 * The built in HTMLTableRowElement object.
 * @external HTMLTableRowElement
 * @see {@link https://developer.mozilla.org/en-US/docs/Web/API/HTMLTableRowElement}
 */

/**
 * Remove file row from HTML Table
 * @param {HTMLTableRowElement} row Table row element to remove
 */
function removeRow(row: HTMLTableRowElement) {
  const rowIndex = Array.from(table.rows).indexOf(row);
  table.deleteRow(rowIndex);
}

/**
 * Clean devices variables on chip disconnect. Remove stale references if any.
 */
function cleanUp() {
  device = null;
  transport = null;
  chip = null;
  deviceMac = null;
}

disconnectButton.onclick = async () => {
  if (transport) await transport.disconnect();

  term.reset();
  lblBaudrate.style.display = "initial";
  baudrates.style.display = "initial";
  connectButton.style.display = "initial";
  disconnectButton.style.display = "none";
  traceButton.style.display = "none";
  eraseButton.style.display = "none";
  lblConnTo.style.display = "none";
  filesDiv.style.display = "none";
  alertDiv.style.display = "none";
  // In tabbed layout: hide both Program and Console sections and disable tabs
  programDiv.style.display = "none";
  consoleDiv.style.display = "none";
  const tabProgram = document.querySelector('#tabs .tab[data-target="program"]') as HTMLElement | null;
  const tabConsole = document.querySelector('#tabs .tab[data-target="console"]') as HTMLElement | null;
  [tabProgram, tabConsole].forEach((t) => {
    if (t) {
      t.classList.add("disabled");
      t.classList.remove("active");
    }
  });
  cleanUp();
  isConnected = false;
  // @ts-ignore
  (window as any).isConnected = false;
};

let isConsoleClosed = false;
async function softStopConsole() {
  // Stop only the read loop; keep transport open for other operations (flash/erase)
  isConsoleClosed = true;
  try { term.reset(); } catch {}
  try { consoleStartButton.style.display = 'initial'; } catch {}
  try { consoleStopButton.style.display = 'none'; } catch {}
  try { resetButton.style.display = 'none'; } catch {}
  try { lblConsoleFor.style.display = 'none'; } catch {}
}
// @ts-ignore
;(window as any).softStopConsole = softStopConsole;
consoleStartButton.onclick = async () => {
  try {
    // Show Console tab
    switchToConsoleTab();

    // Always ensure we have a fresh Transport for console to avoid stale reader locks
    if (device === null) {
      device = await serialLib.requestPort({});
    }
    // If an old transport exists, disconnect and wait for reader to unlock
    if (transport) {
      try { await transport.disconnect(); } catch {}
      try { await transport.waitForUnlock(500); } catch {}
    }
    transport = new Transport(device, true);
  // Console header: keep it minimal here, detailed info stays in the top connect section
  lblConsoleFor.textContent = 'Connected';
  lblConsoleFor.style.display = 'block';
    consoleStartButton.style.display = 'none';
    consoleStopButton.style.display = 'initial';
    resetButton.style.display = 'initial';
  // Ensure we start scrolled to bottom in case prior content overflows
  try { adjustTerminalSize(); term.scrollToBottom(); } catch {}

  // Ensure transport is connected before starting read loop. Some browsers need an explicit connect after a prior disconnect.
    try {
      // Fallback to UI baud if lastBaud isn't set yet
      const baud = lastBaud || parseInt(baudrates?.value || '115200');
      lastBaud = baud;
      await transport.connect(baud);
    } catch (e) {
      // If already connected or transient, try once more after a brief delay.
      await new Promise(r => setTimeout(r, 100));
      try { await transport.connect(lastBaud); } catch (e2) { console.warn('Console connect issue:', e2); }
    }
  isConsoleClosed = false;

    const dec = new TextDecoder();
    let consoleBuf = '';
    while (!isConsoleClosed) {
      try {
        const readLoop = transport.rawRead();
        const { value, done } = await readLoop.next();
        if (done) break;
        if (!value || (value as any).length === 0) {
          await new Promise(r => setTimeout(r, 30));
          continue;
        }
        // Normalize output so JSON "heartbeats" are on separate lines without leading spaces
        let text = '';
        try { text = dec.decode(value as any, { stream: true }); } catch { /* fallback to raw */ }
        if (text) {
          consoleBuf += text;
          // 1) Convert bare CR to LF (preserve existing CRLF/LF)
          consoleBuf = consoleBuf.replace(/\r(?!\n)/g, '\n');
          // 2) Put adjacent JSON objects on their own lines: ...}{... -> ...}\n{...
          consoleBuf = consoleBuf.replace(/}\s*{/g, '}\n{');
          // 3) Remove indentation spaces at start of line before a JSON object
          consoleBuf = consoleBuf.replace(/(^|\n)[ \t]+(?=\{)/g, '$1');
          // 4) Flush complete lines, keep last partial in buffer
          const lines = consoleBuf.split('\n');
          consoleBuf = lines.pop() || '';
          const shouldAuto = autoScroll;
          if (lines.length > 0) {
            const flushText = lines.join('\n') + '\n';
            // Scroll after render using write callback
            // @ts-ignore
            term.write(flushText, () => { if (shouldAuto) { try { term.scrollToBottom(); } catch {} } });
          }
        } else {
          // Fallback for non-text chunks
          try {
            // @ts-ignore
            term.write(String(value), () => { if (autoScroll) { try { term.scrollToBottom(); } catch {} } });
          } catch {
            try { term.scrollToBottom(); } catch {}
          }
        }
      } catch (loopErr) {
        // Transient read error; brief backoff then continue unless stopped
        await new Promise(r => setTimeout(r, 50));
      }
    }
    console.log('quitting console');
  } catch (err) {
    console.error('Console start failed', err);
    term.writeln(`Error starting console: ${err?.message || err}`);
  }
};

consoleStopButton.onclick = async () => {
  isConsoleClosed = true;
  // Disconnect to release reader locks so the next Start works reliably
  if (transport) {
    try { await transport.disconnect(); } catch {}
    try { await transport.waitForUnlock(1500); } catch {}
  }
  term.reset();
  consoleStartButton.style.display = "initial";
  consoleStopButton.style.display = "none";
  resetButton.style.display = "none";
  lblConsoleFor.style.display = "none";
  // Stay on Console tab after stopping; user can start again without switching views
};

// Wire WiFi UI
const wifiScanButton = document.getElementById('wifiScanButton') as HTMLButtonElement | null;
const wifiConnectButton = document.getElementById('wifiConnectButton') as HTMLButtonElement | null;
if (wifiScanButton) {
  wifiScanButton.onclick = async () => {
  // Ensure a clean, connected transport (handles disconnected-but-present cases)
  await ensureTransportConnected();
    await wifiScanAndDisplay();
  };
}
if (wifiConnectButton) {
  wifiConnectButton.onclick = async () => {
  // Ensure a clean, connected transport (handles disconnected-but-present cases)
  await ensureTransportConnected();
    await wifiConnectSelected();
  };
}

/**
 * Validate the provided files images and offset to see if they're valid.
 * @returns {string} Program input validation result
 */
function validateProgramInputs() {
  const offsetArr = [];
  const rowCount = table.rows.length;
  let row;
  let offset = 0;

  // check for mandatory fields
  for (let index = 1; index < rowCount; index++) {
    row = table.rows[index];
    // If there's no file selected in this row, skip validation for it
    const fileObj = row.cells[1].childNodes[0] as ChildNode & { data?: string };
    const fileData = fileObj?.data;
    if (fileData == null) {
      continue;
    }

    // offset fields checks (only for rows that have a file)
    const offSetObj = row.cells[0].childNodes[0] as HTMLInputElement;
    offset = parseInt(offSetObj.value);

    // Non-numeric or blank offset
    if (Number.isNaN(offset)) return "Offset field in row " + index + " is not a valid address!";
    // Repeated offset used
    else if (offsetArr.includes(offset)) return "Offset field in row " + index + " is already in use!";
    else offsetArr.push(offset);
  }
  return "success";
}

programButton.onclick = async () => {
  const alertMsg = document.getElementById("programAlertMsg");
  // Require either a prebuilt firmware selection or at least one uploaded file
  const hasPrebuilt = !!(prebuiltSelect && prebuiltSelect.value);
  let hasCustom = false;
  for (let index = 1; index < table.rows.length; index++) {
    const row = table.rows[index];
    const fileObj = row?.cells?.[1]?.childNodes?.[0] as (ChildNode & { data?: string }) | undefined;
    if (fileObj && fileObj.data) { hasCustom = true; break; }
  }
  if (!hasPrebuilt && !hasCustom) {
    alertMsg.textContent = "Please select a firmware from the dropdown or upload a file first.";
    alertDiv.style.display = "block";
    return;
  }

  const err = validateProgramInputs();

  if (err != "success") {
    alertMsg.innerHTML = "<strong>" + err + "</strong>";
    alertDiv.style.display = "block";
    return;
  }

  // Hide error message
  alertDiv.style.display = "none";

  const fileArray = [] as Array<{ data: string; address: number }>;
  const progressBars: HTMLProgressElement[] = [];

  for (let index = 1; index < table.rows.length; index++) {
    const row = table.rows[index];

  const fileObj = row.cells[1].childNodes[0] as ChildNode & { data?: string };
  const fileData = fileObj?.data;
  // Skip rows without a selected file
  if (!fileData) continue;

  const offSetObj = row.cells[0].childNodes[0] as HTMLInputElement;
  const offset = parseInt(offSetObj.value);

  const progressBar = row.cells[2].childNodes[0] as HTMLProgressElement;
  progressBar.value = 0;
  progressBars.push(progressBar);

  row.cells[2].style.display = "initial";
  row.cells[3].style.display = "none";

  fileArray.push({ data: fileData, address: offset });
  }

  // If a prebuilt is selected, fetch and add it
  if (prebuiltSelect && prebuiltSelect.value) {
    try {
      const idx = parseInt(prebuiltSelect.value, 10);
      const item = prebuiltItems[idx];
      if (item && item.file) {
        let res: Response | null = null;
        try {
          const binUrl = new URL(`./binaries/${item.file}`, import.meta.url).toString();
          res = await fetch(binUrl, { cache: "no-store" });
          if (!res.ok) res = null;
        } catch (_) {}
        if (!res) {
          // Fallback: relative to page
          res = await fetch(`./binaries/${item.file}`, { cache: "no-store" });
        }
        const blob = await res.blob();
        const arrayBuf = await blob.arrayBuffer();
        const bytes = new Uint8Array(arrayBuf);
        let bin = "";
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        const addr = item.address ? parseInt(item.address) : 0x0;
        fileArray.push({ data: bin, address: addr });
      }
    } catch (e) {
      console.error("Failed to load prebuilt firmware:", e);
  alertMsg.textContent = "Failed to load selected firmware.";
      alertDiv.style.display = "block";
      return;
    }
  }

  try {
  // Switch to Console view when flashing starts
  switchToConsoleTab();
  // Stop console loop during flashing to avoid interleaved reads
  isConsoleClosed = true;
  const flashOptions: FlashOptions = {
      fileArray: fileArray,
      flashSize: "keep",
      eraseAll: false,
      compress: true,
      reportProgress: (fileIndex, written, total) => {
        const bar = progressBars[fileIndex];
        if (bar) bar.value = (written / total) * 100;
      },
      calculateMD5Hash: (image) => CryptoJS.MD5(CryptoJS.enc.Latin1.parse(image)),
    } as FlashOptions;
    await esploader.writeFlash(flashOptions);
    await esploader.after();
  } catch (e) {
    console.error(e);
    term.writeln(`Error: ${e.message}`);
  } finally {
    // Hide progress bars and show erase buttons
    for (let index = 1; index < table.rows.length; index++) {
      table.rows[index].cells[2].style.display = "none";
      table.rows[index].cells[3].style.display = "initial";
    }
  }
};

addFileButton.onclick(this);
