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
const lblConnTo = document.getElementById("lblConnTo");
const table = document.getElementById("fileTable") as HTMLTableElement;
const alertDiv = document.getElementById("alertDiv");
// Timer handle for auto-dismissing program alerts (success)
let programAlertTimer: any = null;
// Connection status UI bits (dot and alert in the Connect card)
const connStatusDot = document.getElementById("connStatusDot") as HTMLElement | null;
const connectAlert = document.getElementById("connectAlert") as HTMLElement | null;
const connectAlertMsgEl = document.getElementById("connectAlertMsg") as HTMLElement | null;

function updateConnStatusDot(up: boolean) {
  if (!connStatusDot) return;
  try {
    connStatusDot.classList.toggle('status-green', !!up);
    connStatusDot.classList.toggle('status-red', !up);
    connStatusDot.title = up ? 'Connected' : 'Disconnected';
    connStatusDot.setAttribute('aria-label', up ? 'Connected' : 'Disconnected');
  } catch {}
}

function showConnectAlert(msg: string) {
  try {
    if (connectAlertMsgEl) connectAlertMsgEl.textContent = msg || '';
    if (connectAlert) connectAlert.style.display = 'block';
  } catch {}
}

function hideConnectAlert() {
  try { if (connectAlert) connectAlert.style.display = 'none'; } catch {}
}

const debugLogging = document.getElementById("debugLogging") as HTMLInputElement;
const debugLogEl = document.getElementById('debugLog') as HTMLElement | null;
function dbg(msg: string, dir: 'tx'|'rx'|'info' = 'info') {
  try {
    if (!debugLogEl) return;
    // Always show info-level logs (like pytool.py shows "Sending:" etc.).
    // Gate raw TX/RX noise behind the Debug checkbox.
    if (dir !== 'info' && debugLogging && !debugLogging.checked) return;
    const ts = new Date().toISOString().split('T')[1].replace('Z','');
    let prefix = '--';
    if (dir === 'tx') prefix = '📤';
    else if (dir === 'rx') prefix = '📡';
    debugLogEl.textContent += `[${ts}] ${prefix} ${msg}\n`;
    debugLogEl.scrollTop = debugLogEl.scrollHeight;
  } catch {}
}

const demoModeEl = document.getElementById("demoMode") as HTMLInputElement | null;

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
  // Always show user-intent command sends like pytool.py
  try { dbg(`Sending: ${payload.trim()}`, 'info'); } catch {}
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
    try {
      if (buffer) {
        // Raw chunks only when Debug is enabled
        dbg(`Raw: ${JSON.stringify(buffer)}`, 'rx');
        // Also mirror a short buffer tail when in debug for easier inspection
        const tail = buffer.slice(-200);
        if (tail && tail.length < buffer.length) dbg(`Buffer: ${JSON.stringify(tail)}`, 'rx');
      }
    } catch {}

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
  try { dbg(`Received: ${JSON.stringify(obj)}`, 'info'); } catch {}
        return obj;
      } catch {
        const startIdx = trimmed.indexOf("{");
        const endIdx = trimmed.lastIndexOf("}");
        if (startIdx !== -1 && endIdx > startIdx) {
            try {
              const obj = JSON.parse(trimmed.slice(startIdx, endIdx + 1));
              try { dbg(`Received: ${JSON.stringify(obj)}`, 'info'); } catch {}
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
    // Parse and normalize results
    const raw = parseNetworksFromResults(scanResp) || [];
    // 1) Drop hidden networks (no SSID)
    // 2) Deduplicate by SSID, keeping the strongest RSSI
    const bestBySsid = new Map<string, {ssid: string; rssi: number; channel: number; auth_mode: number; mac_address?: string}>();
    for (const n of raw) {
      const ssid = (n?.ssid || '').trim();
      if (!ssid) continue; // skip hidden
      const prev = bestBySsid.get(ssid);
      if (!prev || ((n?.rssi ?? -999) > (prev?.rssi ?? -999))) {
        bestBySsid.set(ssid, n);
      }
    }
    const nets = Array.from(bestBySsid.values());
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
      const label = n.ssid; // hidden SSIDs were filtered out
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
  if (ssidLabel) ssidLabel.textContent = label;
        if (selBox) selBox.style.display = 'flex';
        if (pwdField) pwdField.style.display = open ? 'none' : 'inline-block';
        (ssidLabel as any)._auth_mode = n.auth_mode;
        (ssidLabel as any)._ssid = n.ssid || '';
  // Hide the 'Found X networks' status once a network is selected
  try { if (statusEl) statusEl.textContent = ''; } catch {}
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

// Attach global serial disconnect handler and a polling fallback to detect port removal
let serialEventsAttached = false;
let portMonitorTimer: any = null;
function attachSerialEventHandlers() {
  const serAny = serialLib as any;
  if (serialEventsAttached || !(serAny && serAny.addEventListener)) return;
  try {
    serAny.addEventListener('disconnect', (event: any) => {
      const evPort = (event && (event.target || event.port || event.detail?.port)) || null;
      if (device && (!evPort || evPort === device)) {
        handlePortDisconnected('Device disconnected');
      }
    });
  } catch {}
  serialEventsAttached = true;
}
attachSerialEventHandlers();

function startPortPresenceMonitor() {
  if (portMonitorTimer) return;
  portMonitorTimer = setInterval(async () => {
    try {
      const ports = await (serialLib as any)?.getPorts?.();
      if (!device) return;
      if (Array.isArray(ports) && ports.indexOf(device) === -1) {
        await handlePortDisconnected('Device disconnected');
      }
    } catch {}
  }, 2000);
}

function stopPortPresenceMonitor() {
  if (portMonitorTimer) {
    try { clearInterval(portMonitorTimer); } catch {}
    portMonitorTimer = null;
  }
}

// Gracefully handle underlying serial port disconnection
async function handlePortDisconnected(reason: string = 'Device disconnected') {
  try { dbg(`Port disconnected: ${reason}`, 'info'); } catch {}
  try { stopPortPresenceMonitor(); } catch {}
  try { isConsoleClosed = true; } catch {}
  try {
    if (transport) {
      try { await transport.disconnect(); } catch {}
      try { await transport.waitForUnlock(500); } catch {}
    }
  } catch {}
  try {
    isConnected = false;
    // @ts-ignore
    (window as any).isConnected = false;
    updateConnStatusDot(false);
    if (lblConnTo) (lblConnTo as HTMLElement).style.display = 'none';
    if (lblBaudrate) (lblBaudrate as HTMLElement).style.display = 'initial';
    if (baudrates) (baudrates as any).style.display = 'initial';
    if (connectButton) connectButton.style.display = 'initial';
    if (disconnectButton) disconnectButton.style.display = 'none';
    if (traceButton) traceButton.style.display = 'none';
    if (eraseButton) eraseButton.style.display = 'none';
    if (filesDiv) (filesDiv as HTMLElement).style.display = 'none';
    showConnectAlert(reason);
  } catch {}
}

declare let Terminal; // Terminal is imported in HTML script
declare let CryptoJS; // CryptoJS is imported in HTML script

const term = new Terminal({ cols: 120, rows: 39, convertEol: true, scrollback: 5000 });
// Expose globally for UI resize logic
// @ts-ignore
;(window as any).term = term;
term.open(terminal);
// Helper to get xterm's scrollable viewport element
function getTerminalViewport(): HTMLElement | null {
  try {
    const container = document.getElementById('terminal');
    return (container?.querySelector('.xterm-viewport') as HTMLElement) || null;
  } catch { return null; }
}
// Helper: adjust terminal rows to match small/fullscreen modes so bottom is visible
function adjustTerminalSize() {
  try {
    const wrap = document.getElementById('terminalWrapper');
    const isFull = wrap?.classList.contains('fullscreen');
  // Small mode uses ~20 rows, fullscreen uses ~39 rows (avoids bottom clipping)
  term.resize(120, isFull ? 39 : 20);
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
        setTimeout(() => {
          adjustTerminalSize();
          // Initialize autoScroll based on current position; scroll only if already at bottom
          try { autoScroll = isAtBottom(); if (autoScroll) term.scrollToBottom(); } catch {}
        }, 50);
      }
    });
    mo.observe(consoleSection, { attributes: true, attributeFilter: ['style'] });
  }
} catch {}
// Also react to window resizes
try { window.addEventListener('resize', () => { adjustTerminalSize(); /* keep position; no forced scroll */ }); } catch {}
// Track whether we're at the bottom to auto-scroll new output unless user scrolled up
let autoScroll = true;
function isAtBottom(): boolean {
  const vp = getTerminalViewport();
  if (!vp) return true;
  // Consider at-bottom if the viewport is scrolled to the end (allow tiny rounding tolerance)
  return (vp.scrollTop + vp.clientHeight) >= (vp.scrollHeight - 2);
}
// Update autoScroll on terminal/viewport scroll
try {
  // Prefer DOM viewport scroll; fall back to xterm event
  const vp = getTerminalViewport();
  if (vp) {
    vp.addEventListener('scroll', () => { autoScroll = isAtBottom(); });
  }
  // @ts-ignore
  term.onScroll?.(() => { autoScroll = isAtBottom(); });
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
let isConsoleClosed = true;
// @ts-ignore
(window as any).isConnected = isConnected;

disconnectButton.style.display = "none";
traceButton.style.display = "none";
eraseButton.style.display = "none";
consoleStopButton.style.display = "none";
resetButton.style.display = "none";
filesDiv.style.display = "none";

// --- Demo mode helpers ---
function setTabsEnabled(enabled: boolean) {
  try {
    const tabProgram = document.querySelector('#tabs .tab[data-target="program"]') as HTMLElement | null;
    const tabConsole = document.querySelector('#tabs .tab[data-target="console"]') as HTMLElement | null;
    const tabTools = document.querySelector('#tabs .tab[data-target="tools"]') as HTMLElement | null;
  const tabUpdate = document.querySelector('#tabs .tab[data-target="update"]') as HTMLElement | null;
  [tabProgram, tabConsole, tabTools, tabUpdate].forEach(t => t && t.classList.toggle('disabled', !enabled));
  } catch {}
}

function enterDemoMode() {
  // Simulate connected UI without a real transport
  isConnected = true;
  // @ts-ignore
  (window as any).isConnected = true;
  updateConnStatusDot(true);
  try {
    if (lblConnTo) {
      lblConnTo.innerHTML = 'Connected: Demo device · 921600 baud';
      lblConnTo.style.display = 'block';
    }
    lblBaudrate && (lblBaudrate.style.display = 'none');
    baudrates && ((baudrates as any).style.display = 'none');
    connectButton.style.display = 'none';
    disconnectButton.style.display = 'initial';
    traceButton.style.display = 'initial';
    eraseButton.style.display = 'initial';
    filesDiv.style.display = 'initial';
  } catch {}
  setTabsEnabled(true);
  // Switch to Flashing tab to show content
  const tabProgram = document.querySelector('#tabs .tab[data-target="program"]') as HTMLElement | null;
  if (tabProgram) tabProgram.click();
}

function exitDemoMode() {
  // Revert to disconnected UI
  isConnected = false;
  // @ts-ignore
  (window as any).isConnected = false;
  updateConnStatusDot(false);
  try {
    lblBaudrate && (lblBaudrate.style.display = 'initial');
    baudrates && ((baudrates as any).style.display = 'initial');
    connectButton.style.display = 'initial';
    disconnectButton.style.display = 'none';
    traceButton.style.display = 'none';
    eraseButton.style.display = 'none';
    if (lblConnTo) lblConnTo.style.display = 'none';
    filesDiv.style.display = 'none';
    alertDiv && (alertDiv.style.display = 'none');
  } catch {}
  setTabsEnabled(false);
  // Hide sections; Connect card remains
  ['program','console','tools'].forEach(id => {
    const el = document.getElementById(id);
    if (el) (el as HTMLElement).style.display = 'none';
  });
}

if (demoModeEl) {
  demoModeEl.addEventListener('change', () => {
    if (demoModeEl.checked) enterDemoMode(); else exitDemoMode();
  });
  // If enabled on load, immediately enter demo mode
  if (demoModeEl.checked) enterDemoMode();
}

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

// Load prebuilt firmware list dynamically from ./binaries at runtime
// 1) Try ./binaries/manifest.json (simple JSON you can edit in dist without rebuild)
// 2) If not found, try to parse directory listing HTML of ./binaries/ for *.bin files
type FirmwareItem = { name?: string; file: string; address?: string; source?: 'binaries' | 'legacy' };
let prebuiltItems: Array<FirmwareItem> = [];
let legacyItems: Array<FirmwareItem> = [];
async function fetchJson(url: string) {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  }
}
async function fetchText(url: string) {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    // Only accept HTML/text for listing fallbacks
    if (!/text\/(html|plain)|application\/xhtml\+xml/i.test(ct) && ct) return null;
    return await res.text();
  } catch (_) {
    return null;
  }
}
function parseAddrFromName(filename: string): string | undefined {
  // Support filenames like "0x10000_firmware.bin" or "0x10000-firmware.bin"
  const m = filename.match(/^0x([0-9a-fA-F]+)[_-]/);
  return m ? `0x${m[1]}` : undefined;
}
async function loadPrebuiltManifest() {
  try {
    // 1) Preferred: plain file next to the built app
    const json = await fetchJson("./binaries/manifest.json");
    if (Array.isArray(json?.items)) {
      prebuiltItems = json.items
        .map((it: any) => {
          if (typeof it === 'string') {
            const file = it;
            return { file, name: file, address: parseAddrFromName(file), source: 'binaries' } as FirmwareItem;
          }
          const file = it?.file || (typeof it?.name === 'string' && it.name.endsWith('.bin') ? it.name : undefined);
          if (!file) return null;
          const address = it?.address ?? parseAddrFromName(file);
          return { file, name: it?.name, address, source: 'binaries' } as FirmwareItem;
        })
        .filter(Boolean) as FirmwareItem[];
    } else {
      // 2) Fallback: try directory listing (works on some static servers)
      const html = await fetchText("./binaries/");
      if (html) {
        const binSet = new Set<string>();
        const re = /href=\"([^\"]+\.bin)\"/gi;
        let m: RegExpExecArray | null;
        while ((m = re.exec(html))) {
          let href = m[1];
          // Normalize to relative within ./binaries
          if (href.startsWith("http") || href.startsWith("//")) continue; // skip absolute
          if (href.startsWith("/")) continue; // skip root-absolute
          href = href.replace(/^\.\//, "");
          // Only take direct children (no subfolders) for safety
          if (href.includes("/")) continue;
          binSet.add(href);
        }
        prebuiltItems = Array.from(binSet).sort().map((file) => ({
          file,
          name: file,
          address: parseAddrFromName(file),
          source: 'binaries',
        }));
      } else {
        prebuiltItems = [];
      }
    }
    // Move any entries that were accidentally listed under binaries with a 'legacy/' prefix over to legacyItems
    try {
      const movedToLegacy: FirmwareItem[] = [];
      prebuiltItems = prebuiltItems.filter((it) => {
        if (typeof it.file === 'string' && it.file.startsWith('legacy/')) {
          const basename = it.file.replace(/^legacy\//, '');
          movedToLegacy.push({ ...it, file: basename, source: 'legacy' });
          return false;
        }
        return true;
      });
      if (movedToLegacy.length) {
        legacyItems = [...movedToLegacy, ...legacyItems];
      }
    } catch {}

    if (prebuiltSelect) {
      // Clear existing options except placeholder
      for (let i = prebuiltSelect.options.length - 1; i >= 1; i--) {
        prebuiltSelect.remove(i);
      }
      prebuiltItems.forEach((it, idx) => {
        const opt = document.createElement("option");
        opt.value = String(idx);
        // Always show the filename as label as requested
        const label = it.file;
        opt.textContent = label;
        opt.title = it.source === 'legacy' ? `${label} (legacy)` : label; // show source on hover
        prebuiltSelect.appendChild(opt);
      });
    }
  } catch (e) {
    console.warn("No prebuilt list or failed to load.", e);
  }
}
loadPrebuiltManifest();

// Load legacy firmware list (similar flow as binaries)
async function loadLegacyManifest() {
  try {
  const json = await fetchJson("./binaries/legacy/manifest.json");
    if (Array.isArray(json?.items)) {
      legacyItems = json.items
        .map((it: any) => {
          if (typeof it === 'string') {
            const file = it;
            return { file, name: file, address: parseAddrFromName(file), source: 'legacy' } as FirmwareItem;
          }
          const file = it?.file || (typeof it?.name === 'string' && it.name.endsWith('.bin') ? it.name : undefined);
          if (!file) return null;
          const address = it?.address ?? parseAddrFromName(file);
          return { file, name: it?.name, address, source: 'legacy' } as FirmwareItem;
        })
        .filter(Boolean) as FirmwareItem[];
    } else {
  const html = await fetchText("./binaries/legacy/");
      if (html) {
        const binSet = new Set<string>();
        const re = /href=\"([^\"]+\.bin)\"/gi;
        let m: RegExpExecArray | null;
        while ((m = re.exec(html))) {
          let href = m[1];
          if (href.startsWith("http") || href.startsWith("//")) continue;
          if (href.startsWith("/")) continue;
          href = href.replace(/^\.\//, "");
          if (href.includes("/")) continue;
          binSet.add(href);
        }
        legacyItems = Array.from(binSet).sort().map((file) => ({
          file,
          name: file,
          address: parseAddrFromName(file),
          source: 'legacy',
        }));
      } else {
        legacyItems = [];
      }
    }
  } catch (_) {
    legacyItems = [];
  }
}

const showLegacyEl = document.getElementById('showLegacy') as HTMLInputElement | null;
if (showLegacyEl) {
  showLegacyEl.addEventListener('change', async () => {
    if (showLegacyEl.checked) {
      if (!legacyItems.length) await loadLegacyManifest();
      // Merge legacy at the bottom
      const combined = [...prebuiltItems, ...legacyItems];
      // Rebuild dropdown options using filenames
      for (let i = prebuiltSelect.options.length - 1; i >= 1; i--) {
        prebuiltSelect.remove(i);
      }
      combined.forEach((it, idx) => {
        const opt = document.createElement('option');
        opt.value = String(idx);
        opt.textContent = it.file;
        opt.title = it.source === 'legacy' ? `${it.file} (legacy)` : it.file;
        prebuiltSelect.appendChild(opt);
      });
      // Keep a shadow copy that program uses based on index mapping
      // Overwrite prebuiltItems reference to combined for selection consistency
      prebuiltItems = combined;
    } else {
      // Revert to only prebuilt list
      await loadPrebuiltManifest();
    }
  });
  // If the checkbox is already enabled on load, populate immediately
  if (showLegacyEl.checked) {
    // Trigger the same logic as on change to ensure options include legacy
    showLegacyEl.dispatchEvent(new Event('change'));
  }
}

connectButton.onclick = async () => {
  try {
    try { dbg('Connect clicked', 'info'); } catch {}
    // Prepare UI: clear any alert and set dot to disconnected until success
    hideConnectAlert();
    updateConnStatusDot(false);
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
    try { dbg(`Connected to chip ${chip}${deviceMac ? ' MAC ' + deviceMac : ''}`, 'info'); } catch {}
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
    // Update status indicator to connected
    updateConnStatusDot(true);
    hideConnectAlert();
    // Do not force-hide console panel; tabs manage visibility
    // Explicitly switch to Flashing tab after connect
    const tabProgram = document.querySelector('#tabs .tab[data-target="program"]') as HTMLElement | null;
    if (tabProgram) tabProgram.click();
    // Begin monitoring port in case it disappears
    startPortPresenceMonitor();
  } catch (e) {
    console.error(e);
    term.writeln(`Error: ${e.message}`);
    isConnected = false;
    // @ts-ignore
    (window as any).isConnected = false;
    updateConnStatusDot(false);
    showConnectAlert(`Connection failed: ${e?.message || e}`);
    try { dbg(`Connect error ${e?.message || e}`, 'info'); } catch {}
  }
};

traceButton.onclick = async () => {
  if (transport) {
    try { dbg('Trace requested', 'info'); } catch {}
    transport.returnTrace();
  }
};

eraseButton.onclick = async () => {
  try { dbg('Erase flash requested', 'info'); } catch {}
  eraseButton.disabled = true;
  try {
    // Ensure console loop is stopped before erase
    isConsoleClosed = true;
    // Switch to Console view when erase starts
    switchToConsoleTab();
    await esploader.eraseFlash();
    try { dbg('Erase flash done', 'info'); } catch {}
  } catch (e) {
    console.error(e);
    term.writeln(`Error: ${e.message}`);
    try { dbg(`Erase error ${e?.message || e}`, 'info'); } catch {}
  } finally {
    eraseButton.disabled = false;
  }
};

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
    // No console header label; leave just spacing and buttons
    consoleStartButton.style.display = 'none';
    consoleStopButton.style.display = 'initial';
    resetButton.style.display = 'initial';
    // Ensure we start scrolled to bottom in case prior content overflows
    try {
      adjustTerminalSize();
      autoScroll = isAtBottom();
      if (autoScroll) term.scrollToBottom();
    } catch {}

    // Ensure transport is connected before starting read loop. Some browsers need an explicit connect after a prior disconnect.
    try {
      // Fallback to UI baud if lastBaud isn't set yet
      const baud = lastBaud || parseInt(baudrates?.value || '115200');
      lastBaud = baud;
      await transport.connect(baud);
      try { dbg(`Console transport connected ${baud}`, 'info'); } catch {}
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
          let lineIdx = consoleBuf.lastIndexOf("\n");
          if (lineIdx !== -1) {
            const lines = consoleBuf.slice(0, lineIdx + 1);
            consoleBuf = consoleBuf.slice(lineIdx + 1);
            term.write(lines.replace(/\r?\n/g, "\r\n"));
            try { dbg(`Console rx ${JSON.stringify(lines)}`, 'rx'); } catch {}
          }
        }
      } catch (_) {}
    }
  } catch (e) {
    console.error(e);
    term.writeln(`Error: ${e.message}`);
  }
};

// Stop console loop and restore buttons
consoleStopButton.onclick = () => {
  try { dbg('Console stop requested', 'info'); } catch {}
  isConsoleClosed = true;
  consoleStartButton.style.display = 'initial';
  consoleStopButton.style.display = 'none';
  resetButton.style.display = 'none';
};

// Disconnect handler (user initiated)
disconnectButton.onclick = async () => {
  await handlePortDisconnected('Disconnected by user');
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
  // Ensure alert starts clean (remove success state)
  try { alertDiv.classList.remove('success'); } catch {}
  // Clear any pending auto-dismiss timer from previous runs
  try { if (programAlertTimer) { clearTimeout(programAlertTimer); programAlertTimer = null; } } catch {}
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
  // No separate erase column; only show progress during flashing

  fileArray.push({ data: fileData, address: offset });
  }

  // If a prebuilt is selected, fetch and add it (from ./binaries at runtime)
  if (prebuiltSelect && prebuiltSelect.value) {
    try {
      const idx = parseInt(prebuiltSelect.value, 10);
      const item = prebuiltItems[idx];
      if (item && item.file) {
  const base = item.source === 'legacy' ? './binaries/legacy' : './binaries';
  const res = await fetch(`${base}/${item.file}`, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
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
    // Success UI: show a green success alert and write to console
    try {
      alertMsg.textContent = 'Flashing successful.';
      alertDiv.classList.add('success');
      alertDiv.style.display = 'block';
      // Auto-hide after 5 seconds
      if (programAlertTimer) { try { clearTimeout(programAlertTimer); } catch {} }
      programAlertTimer = setTimeout(() => {
        try { alertDiv.style.display = 'none'; alertDiv.classList.remove('success'); } catch {}
        programAlertTimer = null;
      }, 5000);
    } catch {}
    try { term.writeln('\r\n[Flashing successful]'); } catch {}
  } catch (e) {
    console.error(e);
    term.writeln(`Error: ${e.message}`);
  } finally {
    // Hide progress bars and show erase buttons
    for (let index = 1; index < table.rows.length; index++) {
      table.rows[index].cells[2].style.display = "none";
    }
  }
};

// Add File row creation
function addRow(defaultOffset: string = '0x10000') {
  const tbody = document.getElementById('tableBody') as HTMLTableSectionElement | null;
  const tbl = table as HTMLTableElement;
  const row = (tbody ? tbody.insertRow(-1) : tbl.insertRow(-1));
  // Offset cell
  const c0 = row.insertCell(0);
  const off = document.createElement('input');
  off.type = 'text';
  off.value = defaultOffset;
  off.className = 'offset-input';
  c0.appendChild(off);
  // File cell
  const c1 = row.insertCell(1);
  const inp = document.createElement('input') as HTMLInputElement & { data?: string };
  inp.type = 'file';
  inp.accept = '.bin,application/octet-stream';
  inp.addEventListener('change', handleFileSelect as any);
  c1.appendChild(inp);
  // Progress cell
  const c2 = row.insertCell(2);
  c2.className = 'progress-cell';
  const prog = document.createElement('progress') as HTMLProgressElement;
  prog.max = 100; prog.value = 0;
  c2.style.display = 'none';
  c2.appendChild(prog);
}

addFileButton.onclick = () => addRow();
