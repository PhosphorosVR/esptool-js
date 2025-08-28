async function getMacOnly(): Promise<string | null> {
  try {
    await ensurePaused();
    const resp = await sendJsonCommand('get_serial', {}, 8000);
    const arr = resp?.results || [];
    if (!arr.length) return null;
    let inner: any = arr[0];
    try { if (typeof inner === 'string') inner = JSON.parse(inner); } catch {}
    let payload: any = (inner && typeof inner === 'object' && 'result' in inner) ? inner.result : inner;
    if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch {} }
    return payload?.mac ?? null;
  } catch { return null; }
}
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
// Debug panel elements
const debugLogEl = document.getElementById('debugLog') as HTMLElement | null;
const debugClearBtn = document.getElementById('debugClearBtn') as HTMLButtonElement | null;
const debugAutoScrollEl = document.getElementById('debugAutoScroll') as HTMLInputElement | null;

function appendDebugLine(kind: 'tx'|'rx'|'err'|'info', text: string) {
  if (!debugLogEl) return;
  const ts = new Date().toISOString().slice(11, 19); // HH:MM:SS
  const line = document.createElement('div');
  line.className = `dbg-${kind}`;
  const label = kind === 'tx' ? '>>' : kind === 'rx' ? '<<' : kind === 'err' ? '!!' : '--';
  line.textContent = `[${ts}] ${label} ${text}`;
  debugLogEl.appendChild(line);
  // Auto-scroll if enabled
  try {
    const auto = debugAutoScrollEl ? debugAutoScrollEl.checked : true;
    if (auto) debugLogEl.scrollTop = debugLogEl.scrollHeight;
  } catch {}
}

// Wire Clear button once
try {
  debugClearBtn?.addEventListener('click', () => { if (debugLogEl) debugLogEl.innerHTML = ''; });
} catch {}
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
async function sendJsonCommand(command: string, params?: any, timeoutMs = 10000): Promise<any> {
  if (!transport) throw new Error("Not connected");
  const cmdObj: any = { commands: [{ command }] };
  if (params !== undefined) cmdObj.commands[0].data = params;
  const payload = JSON.stringify(cmdObj) + "\n";
  // Log TX
  try { appendDebugLine('tx', JSON.stringify(cmdObj)); } catch {}

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
  // For scan_networks, track if we saw a networks JSON block already and completion timing
  let sawNetworksJson = false;
  let scanCompletionAt: number | null = null;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const loop = transport.rawRead();
    const { value, done } = await loop.next();
    if (done) break;
    if (!value) continue;
    // Decode only the new chunk, strip ANSI, normalize CRs, then append
    let chunk = dec.decode(value, { stream: true });
    chunk = chunk.replace(/\x1b\[[0-9;]*m/g, "").replace(/\r/g, "\n");
    buffer += chunk;

    // Special handling: scan_networks may emit a raw multi-line JSON {"networks":[...]}
    if (command === 'scan_networks') {
      // Robust regex to locate networks JSON regardless of whitespace/layout
      const re = /\{\s*"networks"\s*:\s*\[[\s\S]*?\]\s*\}/m;
      const m = buffer.match(re);
      if (m && m[0]) {
        const jsonStr = m[0];
        try { JSON.parse(jsonStr); sawNetworksJson = true; } catch {}
        const out = { results: [ JSON.stringify({ result: jsonStr }) ] } as any;
        try { appendDebugLine('rx', JSON.stringify(out)); } catch {}
        return out;
      }
    }
  // Find complete JSON objects in the buffer using brace counting, return only responses with results/error
    let startIdx = buffer.indexOf('{');
    while (startIdx !== -1) {
      let brace = 0;
      let endIdx = -1;
      for (let i = startIdx; i < buffer.length; i++) {
        const ch = buffer[i];
        if (ch === '{') brace++;
        else if (ch === '}') {
          brace--;
          if (brace === 0) { endIdx = i + 1; break; }
        }
      }
      if (endIdx > startIdx) {
    // Extract the complete JSON string as-is; do not collapse whitespace inside JSON strings
    const jsonStr = buffer.slice(startIdx, endIdx).trim();
        // Move buffer forward
        buffer = buffer.slice(endIdx);
        try {
          const obj = JSON.parse(jsonStr);
          // Special handling for scan_networks: return as soon as we can extract networks
          if (command === 'scan_networks') {
            // Helper to find networks array anywhere within nested structures
            const findNetworks = (o: any): any[] | null => {
              if (!o) return null;
              if (Array.isArray(o.networks)) return o.networks;
              // Unwrap common shapes
              if (o.result !== undefined) {
                let p: any = o.result;
                if (typeof p === 'string') { try { p = JSON.parse(p); } catch {}
                }
                const nn = findNetworks(p);
                if (nn) return nn;
              }
              if (Array.isArray(o.results)) {
                for (let e of o.results) {
                  if (typeof e === 'string') { try { e = JSON.parse(e); } catch {} }
                  const nn = findNetworks(e);
                  if (nn) return nn;
                }
              }
              return null;
            };
            const nets = findNetworks(obj);
            // Return only when we actually have at least one network; otherwise keep reading
            if (nets) {
              if (nets.length > 0) {
        const out = { networks: nets };
        try { appendDebugLine('rx', JSON.stringify(out)); } catch {}
        return out;
              }
            }
          }

          if (obj && (Object.prototype.hasOwnProperty.call(obj, 'results') || Object.prototype.hasOwnProperty.call(obj, 'error'))) {
            // For scan_networks, do not return early on generic results like "Networks scanned";
            // only return when we have a networks array (handled above). If we see completion,
            // start a short grace window to allow networks JSON to arrive, then return empty.
            if (command === 'scan_networks') {
              try { appendDebugLine('rx', JSON.stringify(obj)); } catch {}
              // If we saw a completion message, mark the time and keep waiting briefly for networks JSON
              // Ignore the generic completion message; continue waiting for networks JSON until timeout
              try { /* no-op: do not early-return empty */ } catch {}
              // continue accumulating for networks payload
            } else if (command === 'switch_mode') {
              // Acknowledge typically comes as human text; return immediately when present
              try { appendDebugLine('rx', JSON.stringify(obj)); } catch {}
              return obj;
            } else {
              try { appendDebugLine('rx', JSON.stringify(obj)); } catch {}
              return obj;
            }
          }
          // Fast-path: if we're waiting for get_device_mode, try to unwrap mode quickly from typical shapes
          if (command === 'get_device_mode' && obj && Array.isArray(obj.results) && obj.results.length) {
            try {
              let inner: any = obj.results[0];
              if (typeof inner === 'string') inner = JSON.parse(inner);
              let payload: any = (inner && typeof inner === 'object' && 'result' in inner) ? inner.result : inner;
              if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch {} }
              if (payload && (typeof payload.mode === 'string' || typeof payload.value === 'number')) {
                return obj;
              }
            } catch {}
          }
        } catch {}
        // Look for another JSON object in the remaining buffer
        startIdx = buffer.indexOf('{');
        continue;
      } else {
        // No complete JSON yet, keep accumulating
        break;
      }
    }
  }
  // If scan completed but networks JSON never arrived within the grace window, return empty
  if (command === 'scan_networks' && scanCompletionAt && !sawNetworksJson) {
    const out = { results: [ JSON.stringify({ result: '{"networks":[]}' }) ] } as any;
    try { appendDebugLine('rx', JSON.stringify(out)); } catch {}
    return out;
  }
  const err = new Error("Timeout waiting for response");
  try { appendDebugLine('err', `${command}: ${err.message}`); } catch {}
  throw err;
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
  // Scan while paused, same as pytool.py
  await ensurePaused();
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

declare let Terminal; // Terminal is imported in HTML script
declare let CryptoJS; // CryptoJS is imported in HTML script

const term = new Terminal({ cols: 120, rows: 40, convertEol: true, scrollback: 5000 });
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
let chip: string = null; // reserved for flashing context
let esploader: ESPLoader | null = null;
let deviceMac: string = null; // reserved for future use
let lastBaud: number = 115200; // track the active baudrate used for connections
let isConnected = false;
// @ts-ignore
(window as any).isConnected = isConnected;
// Send "pause" once after a successful Connect to keep device in setup mode
let initialPauseSent = false;
// Track whether the device is currently paused (as far as we know)
let pausedActive = false;

// Helper to ensure the app is paused; if already paused, it's a no-op
async function ensurePaused(): Promise<boolean> {
  if (pausedActive) return true;
  try {
    await sendJsonCommand('pause', { pause: true }, 3000);
    pausedActive = true;
    return true;
  } catch (e: any) {
    try { appendDebugLine('info', `ensurePaused failed: ${e?.message || e}`); } catch {}
    return false;
  }
}

// (runWithDeviceActive removed; we run scan in paused mode like pytool.py)

// Helper: try to pause the app with a few retries to cover post-connect settle time
async function pauseWithRetries(initialDelayMs = 600, attempts = 3, retryDelayMs = 500): Promise<boolean> {
  try { await new Promise(r => setTimeout(r, initialDelayMs)); } catch {}
  for (let i = 0; i < attempts; i++) {
    try {
      await sendJsonCommand('pause', { pause: true }, 3000);
  pausedActive = true;
      return true;
    } catch (e:any) {
      if (i === attempts - 1) {
        try { appendDebugLine('info', `Initial pause failed after ${attempts} attempts: ${e?.message || e}`); } catch {}
        return false;
      }
      try { await new Promise(r => setTimeout(r, retryDelayMs)); } catch {}
    }
  }
  return false;
}

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

// function cleanChipName(name: string): string {
//   // Remove any parenthetical info like (QFN56), (revision v1.0), etc.)
//   return typeof name === "string" ? name.replace(/\s*\(.*?\)/g, "").trim() : name;
// }

// Ensure we have a usable, connected transport at the desired baud.
async function ensureTransportConnected(baud?: number) {
  if (device === null) {
    device = await serialLib.requestPort({});
  }
  const b = baud || lastBaud || parseInt(baudrates?.value || '115200');
  lastBaud = b;
  if (!transport) {
    transport = new Transport(device, true);
  }
  try {
    await transport.connect(b);
  } catch (_) {
    // If connect fails (stale reader, prior state), rebuild transport once
    try { await transport.disconnect(); } catch {}
    try { await transport.waitForUnlock(500); } catch {}
    transport = new Transport(device, true);
    await transport.connect(b);
  }
}

// Prepare ESPLoader only when needed (flash/erase). This will toggle into bootloader and handshake.
async function ensureEsploaderReady(): Promise<void> {
  // Always ensure a fresh transport connection first
  await ensureTransportConnected();
  const flashOptions = {
    transport,
    baudrate: lastBaud || parseInt(baudrates?.value || '115200'),
    terminal: espLoaderTerminal,
    debugLogging: debugLogging.checked,
  } as LoaderOptions;
  esploader = new ESPLoader(flashOptions);
  chip = await esploader.main();
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
      prebuiltItems = json.items;
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
        }));
      } else {
        prebuiltItems = [];
      }
    }
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
    console.warn("No prebuilt list or failed to load.", e);
  }
}
loadPrebuiltManifest();

connectButton.onclick = async () => {
  try {
    // Prepare UI
    hideConnectAlert();
    updateConnStatusDot(false);
    isConsoleClosed = true;

    // Select port and connect to the running application (not bootloader)
    await ensureTransportConnected(parseInt(baudrates.value));
    lastBaud = parseInt(baudrates.value) || 115200;

    // Build connection info from USB descriptors and baud
    const info = extractDeviceInfo(transport?.device);
    const parts: string[] = [];
    if (info.product && info.manufacturer) parts.push(`${info.manufacturer} ${info.product}`);
    else if (info.product) parts.push(info.product);
    if (info.serial) parts.push(`SN ${info.serial}`);
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
    updateConnStatusDot(true);
    hideConnectAlert();
    // Switch to Flashing tab on connect to keep previous behavior
    const tabProgram = document.querySelector('#tabs .tab[data-target="program"]') as HTMLElement | null;
    if (tabProgram) tabProgram.click();
    startPortPresenceMonitor();

  // One-time initial pause with retries to keep app in setup mode
  if (!initialPauseSent) { initialPauseSent = true; await pauseWithRetries(); }
  } catch (e:any) {
    console.error(e);
    term.writeln(`Error: ${e?.message || e}`);
    isConnected = false;
    // @ts-ignore
    (window as any).isConnected = false;
    updateConnStatusDot(false);
    showConnectAlert(`Connection failed: ${e?.message || e}`);
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
  await ensureEsploaderReady();
  await esploader!.eraseFlash();
  try { await esploader!.after(); } catch {}
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

  stopPortPresenceMonitor();
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

// Force UI back to Connect state if serial port is unplugged or vanishes
async function handlePortDisconnected(msg?: string) {
  if (!isConnected && !transport) return; // nothing to do
  // Stop console loop and disconnect transport to release locks
  try { isConsoleClosed = true; } catch {}
  try { await transport?.disconnect?.(); } catch {}
  try { await transport?.waitForUnlock?.(500); } catch {}
  stopPortPresenceMonitor();
  // Allow initial pause again on next connect
  initialPauseSent = false;
  pausedActive = false;
  // Reset UI similar to manual Disconnect
  try { term.reset(); } catch {}
  try { lblBaudrate.style.display = "initial"; } catch {}
  try { baudrates.style.display = "initial"; } catch {}
  try { connectButton.style.display = "initial"; } catch {}
  try { disconnectButton.style.display = "none"; } catch {}
  try { traceButton.style.display = "none"; } catch {}
  try { eraseButton.style.display = "none"; } catch {}
  try { lblConnTo.style.display = "none"; } catch {}
  try { filesDiv.style.display = "none"; } catch {}
  try { alertDiv.style.display = "none"; } catch {}
  // Update status indicator and show alert in Connect card
  updateConnStatusDot(false);
  showConnectAlert(msg || 'COM port disconnected.');
  try { programDiv.style.display = "none"; } catch {}
  try { consoleDiv.style.display = "none"; } catch {}
  try {
    const tabProgram = document.querySelector('#tabs .tab[data-target="program"]') as HTMLElement | null;
    const tabConsole = document.querySelector('#tabs .tab[data-target="console"]') as HTMLElement | null;
    const tabTools = document.querySelector('#tabs .tab[data-target="tools"]') as HTMLElement | null;
    [tabProgram, tabConsole, tabTools].forEach((t) => {
      if (t) { t.classList.add('disabled'); t.classList.remove('active'); }
    });
    const toolsSec = document.getElementById('tools') as HTMLElement | null;
    if (toolsSec) toolsSec.style.display = 'none';
  } catch {}
  cleanUp();
  isConnected = false;
  // @ts-ignore
  (window as any).isConnected = false;
  // Optional: inform the user in the console if visible
  try { if (msg) term.writeln(`\r\n[${msg}]`); } catch {}
}

disconnectButton.onclick = async () => {
  if (transport) await transport.disconnect();
  stopPortPresenceMonitor();

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
  updateConnStatusDot(false);
  showConnectAlert('COM port disconnected.');
  // In tabbed layout: hide both Program and Console sections and disable tabs
  programDiv.style.display = "none";
  consoleDiv.style.display = "none";
  const tabProgram = document.querySelector('#tabs .tab[data-target="program"]') as HTMLElement | null;
  const tabConsole = document.querySelector('#tabs .tab[data-target="console"]') as HTMLElement | null;
  const tabTools = document.querySelector('#tabs .tab[data-target="tools"]') as HTMLElement | null;
  [tabProgram, tabConsole, tabTools].forEach((t) => {
    if (t) {
      t.classList.add("disabled");
      t.classList.remove("active");
    }
  });
  // Hide Tools section as well
  const toolsSec = document.getElementById('tools') as HTMLElement | null;
  if (toolsSec) toolsSec.style.display = 'none';
  cleanUp();
  isConnected = false;
  // @ts-ignore
  (window as any).isConnected = false;
  // Allow initial pause again on next connect
  initialPauseSent = false;
  pausedActive = false;
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
            term.write(flushText, () => {
              if (shouldAuto) {
                try { term.scrollToBottom(); } catch {}
              }
            });
          }
        } else {
          // Fallback for non-text chunks
          try {
            // @ts-ignore
            term.write(String(value), () => {
              if (autoScroll) {
                try { term.scrollToBottom(); } catch {}
              }
            });
          } catch {
            // Don't force-scroll if user scrolled up
            if (autoScroll) { try { term.scrollToBottom(); } catch {} }
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

// ---- Device Mode (WiFi/UVC/Auto) ----
async function getDeviceMode(): Promise<string | null> {
  try {
  // Ensure the device stays in setup mode so it responds to control commands (one-time per session)
  await ensurePaused();
  const resp = await sendJsonCommand('get_device_mode', {}, 15000);
    const arr = resp?.results || [];
    if (arr.length) {
      // Results entries may be JSON strings or already-parsed objects
      let inner: any = arr[0];
      try { if (typeof inner === 'string') inner = JSON.parse(inner); } catch {}
      let payload: any = (inner && typeof inner === 'object' && 'result' in inner) ? inner.result : inner;
      if (typeof payload === 'string') {
        try { payload = JSON.parse(payload); } catch {}
      }
      const mode = payload?.mode;
      return typeof mode === 'string' ? mode : null;
    }
  } catch {}
  return null;
}

async function setDeviceMode(mode: 'wifi'|'uvc'|'auto'): Promise<boolean> {
  try {
  const resp = await sendJsonCommand('switch_mode', { mode }, 5000);
    return !resp?.error;
  } catch { return false; }
}

function updateModeUI(mode: string | null) {
  const statusEl = document.getElementById('modeStatus');
  const msgEl = document.getElementById('modeMsg');
  const radios = document.querySelectorAll<HTMLInputElement>('input[name="devMode"]');
  if (statusEl) statusEl.textContent = mode || '-';
  if (msgEl) msgEl.textContent = '';
  radios.forEach(r => { r.checked = (mode && r.value.toLowerCase() === mode.toLowerCase()); });
}

async function refreshMode() {
  const msgEl = document.getElementById('modeMsg');
  try {
    // Use existing transport if available to avoid extra connect overhead
    if (!transport) {
      await ensureTransportConnected();
    }
    const mode = await getDeviceMode();
    updateModeUI(mode);
    if (msgEl) msgEl.textContent = mode ? '' : 'Unable to read mode';
  } catch (e:any) {
    if (msgEl) msgEl.textContent = `Error: ${e?.message || e}`;
  }
}

function wireModePanel() {
  const btnApply = document.getElementById('modeApplyButton') as HTMLButtonElement | null;
  if (btnApply) btnApply.onclick = async () => {
    const msgEl = document.getElementById('modeMsg');
    const selected = document.querySelector<HTMLInputElement>('input[name="devMode"]:checked');
    if (!selected) { if (msgEl) msgEl.textContent = 'Select a mode'; return; }
    try {
  if (!transport) { await ensureTransportConnected(); }
      const ok = await setDeviceMode(selected.value as any);
      if (ok) {
        if (msgEl) msgEl.textContent = 'Mode updated. Please restart the device for changes to take effect.';
        await refreshMode();
      } else {
        if (msgEl) msgEl.textContent = 'Failed to set mode';
      }
    } catch (e:any) {
      if (msgEl) msgEl.textContent = `Error: ${e?.message || e}`;
    }
  };
}

// Wire on load
try { wireModePanel(); } catch {}

// Also auto-refresh the mode panel when the Device Mode subtab is opened
try {
  const toolTabs = document.getElementById('toolTabs');
  if (toolTabs) {
    toolTabs.addEventListener('click', (ev) => {
      const t = ev.target as HTMLElement;
      const li = t?.closest?.('li.subtab') as HTMLElement | null;
      if (li && li.dataset.target === 'tool-mode') {
        // Only refresh if connected
        // @ts-ignore
        if ((window as any).isConnected) refreshMode();
      }
      if (li && li.dataset.target === 'tool-pwm') {
        // @ts-ignore
        if ((window as any).isConnected) refreshPwm();
      }
      if (li && li.dataset.target === 'tool-summary') {
        // @ts-ignore
        if ((window as any).isConnected) refreshSummary();
      }
    });
  }
} catch {}

// ---- PWM Duty (LED external PWM) ----
let pwmCurrent: number | null = null;           // last known value from device
let pwmLastApplied: number | null = null;       // last value we successfully set
let pwmPendingTimer: any = null;                // debounce timer for stable value
let pwmSending = false;                         // in-flight
let pwmLastThresholdTs = 0;                     // last immediate threshold send time

async function getLedDuty(): Promise<number | null> {
  try {
    await ensurePaused();
    const resp = await sendJsonCommand('get_led_duty_cycle', {}, 10000);
    const arr = resp?.results || [];
    if (!arr.length) return null;
    let inner: any = arr[0];
    try { if (typeof inner === 'string') inner = JSON.parse(inner); } catch {}
    let payload: any = (inner && typeof inner === 'object' && 'result' in inner) ? inner.result : inner;
    if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch {} }
    const v = payload?.led_external_pwm_duty_cycle;
    return (typeof v === 'number') ? v : (typeof v === 'string' ? parseInt(v, 10) : null);
  } catch { return null; }
}

async function setLedDuty(duty: number): Promise<boolean> {
  try {
    const resp = await sendJsonCommand('set_led_duty_cycle', { dutyCycle: duty }, 8000);
    return !resp?.error;
  } catch { return false; }
}

function updatePwmUI(value: number | null) {
  const statusEl = document.getElementById('pwmStatus');
  const slider = document.getElementById('pwmSlider') as HTMLInputElement | null;
  const num = document.getElementById('pwmNumber') as HTMLInputElement | null;
  if (statusEl) statusEl.textContent = (value == null || Number.isNaN(value)) ? '-' : `${value}%`;
  if (typeof value === 'number' && slider) slider.value = String(Math.max(0, Math.min(100, Math.round(value))));
  if (typeof value === 'number' && num) num.value = String(Math.max(0, Math.min(100, Math.round(value))));
  // Track device-known values
  pwmCurrent = (typeof value === 'number') ? Math.max(0, Math.min(100, Math.round(value))) : pwmCurrent;
  pwmLastApplied = pwmCurrent;
}

async function refreshPwm() {
  const msgEl = document.getElementById('pwmMsg');
  try {
    if (!transport) await ensureTransportConnected();
    const v = await getLedDuty();
    updatePwmUI(v);
  if (msgEl) msgEl.textContent = (v == null) ? 'Unable to read duty' : '';
  } catch (e:any) {
    if (msgEl) msgEl.textContent = `Error: ${e?.message || e}`;
  }
}

function wirePwmPanel() {
  const slider = document.getElementById('pwmSlider') as HTMLInputElement | null;
  const num = document.getElementById('pwmNumber') as HTMLInputElement | null;
  if (slider && num) {
    const sync = (from: 'slider'|'num') => {
      const val = from === 'slider' ? parseInt(slider.value, 10) : parseInt(num.value, 10);
      const clamped = Math.max(0, Math.min(100, isNaN(val) ? 0 : val));
      slider.value = String(clamped);
      num.value = String(clamped);
      handlePwmInputChange(clamped);
    };
    slider.addEventListener('input', () => sync('slider'));
    num.addEventListener('input', () => sync('num'));
  }
}

try { wirePwmPanel(); } catch {}

// ---- Summary (aggregated GET) ----
// Identity: show MAC only

async function getWifiStatus(): Promise<{status?: string; ip?: string; configured?: number} | null> {
  try {
    await ensurePaused();
    const resp = await sendJsonCommand('get_wifi_status', {}, 8000);
    const arr = resp?.results || [];
    if (!arr.length) return null;
    let inner: any = arr[0];
    try { if (typeof inner === 'string') inner = JSON.parse(inner); } catch {}
    let payload: any = (inner && typeof inner === 'object' && 'result' in inner) ? inner.result : inner;
    if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch {} }
    return {
      status: payload?.status,
      ip: payload?.ip_address,
      configured: payload?.networks_configured
    };
  } catch { return null; }
}

async function refreshSummary() {
  const msgEl = document.getElementById('sumMsg');
  const elMac = document.getElementById('sumMac');
  const elLed = document.getElementById('sumLed');
  const elMode = document.getElementById('sumMode');
  const elWifiStatus = document.getElementById('sumWifiStatus');
  const elWifiIp = document.getElementById('sumWifiIp');
  const elWifiCfg = document.getElementById('sumWifiConfigured');
  try {
    if (!transport) await ensureTransportConnected();
    // Fetch sequentially; each call is fast and keeps code simple
  const mac = await getMacOnly();
  const led = await getLedDuty();
    const mode = await getDeviceMode();
    const wifi = await getWifiStatus();
  if (elMac) elMac.textContent = mac || '-';
  if (elLed) elLed.textContent = (typeof led === 'number') ? `${led}%` : '-';
    if (elMode) elMode.textContent = mode || '-';
    if (elWifiStatus) elWifiStatus.textContent = wifi?.status || '-';
    if (elWifiIp) elWifiIp.textContent = wifi?.ip || '-';
    if (elWifiCfg) elWifiCfg.textContent = (wifi?.configured != null) ? String(wifi.configured) : '-';
    if (msgEl) msgEl.textContent = '';
  } catch (e:any) {
    if (msgEl) msgEl.textContent = `Error: ${e?.message || e}`;
  }
}

function handlePwmInputChange(value: number) {
  // Debounce: if user leaves the value unchanged for 1s, apply it
  if (pwmPendingTimer) { try { clearTimeout(pwmPendingTimer); } catch {} }
  pwmPendingTimer = setTimeout(() => {
    sendPwm(value, 'debounced');
  }, 1000);

  // Threshold-triggered live feel: send immediately if >=5 difference from last applied/current
  const baseline = (pwmLastApplied != null ? pwmLastApplied : (pwmCurrent != null ? pwmCurrent : value));
  if (Math.abs(value - baseline) >= 5) {
    const now = Date.now();
    // Rate limit immediate sends to avoid flooding while dragging
    if (now - pwmLastThresholdTs >= 400 && !pwmSending) {
      pwmLastThresholdTs = now;
      sendPwm(value, 'threshold');
    }
  }
}

async function sendPwm(value: number, reason: 'debounced'|'threshold') {
  const msgEl = document.getElementById('pwmMsg');
  const v = Math.max(0, Math.min(100, Math.round(value)));
  if (pwmSending) return; // Another send in flight; debounce will catch the latest
  pwmSending = true;
  try {
    if (!transport) await ensureTransportConnected();
    const ok = await setLedDuty(v);
    if (ok) {
      // Optional short confirmation only for debounced (final) sends to minimize noise
      if (reason === 'debounced' && msgEl) {
        msgEl.textContent = 'Brightness updated';
        try { setTimeout(() => { if (msgEl.textContent === 'Brightness updated') msgEl.textContent = ''; }, 5000); } catch {}
      }
      pwmLastApplied = v;
      // Read back current value (cheap GET); keeps UI in sync
      const read = await getLedDuty();
      updatePwmUI(read != null ? read : v);
    } else {
  if (msgEl) msgEl.textContent = 'Failed to update brightness';
    }
  } catch (e:any) {
    if (msgEl) msgEl.textContent = `Error: ${e?.message || e}`;
  } finally {
    pwmSending = false;
  }
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

  // If a prebuilt is selected, fetch and add it (from ./binaries at runtime)
  if (prebuiltSelect && prebuiltSelect.value) {
    try {
      const idx = parseInt(prebuiltSelect.value, 10);
      const item = prebuiltItems[idx];
      if (item && item.file) {
        const res = await fetch(`./binaries/${item.file}`, { cache: "no-store" });
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
  await ensureEsploaderReady();
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
    await esploader!.writeFlash(flashOptions);
    await esploader!.after();
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
