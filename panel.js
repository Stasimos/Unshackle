// Main panel controller for Unshackle
//
// This file wires together the various modules (scanners, filtering,
// selection, renaming, conversion and advanced options) and binds
// them to the UI defined in panel.html. It runs in the side panel
// context (or popup as a fallback) and communicates with the
// content script via chrome.tabs.sendMessage.

import { attachProgress, createProgress, updateFromMessage } from './progress.js';
import { parseTypes, filterItems, extOf } from './filtering.js';
import { selectAll, invertSelection } from './auto_select.js';
import { renameSequential } from './auto_rename.js';
import { mountAdvanced } from './advanced.js';

// Internal state
let CACHE = [];            // All scanned items
let VISIBLE = [];          // Filtered items currently shown in the grid
let SELECTED = new Set();  // Set of urls that are selected
let autoScanInterval = null;
let autoCanvasInterval = null;

// Reference UI elements (populated on DOMContentLoaded)
const refs = {};

/**
 * Get the active tab in the current window. Returns a promise
 * resolving to a tab object or null if none is found.
 */
async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs && tabs.length > 0 ? tabs[0] : null;
}

/**
 * Send a message to the content script of the given tab. Returns
 * the response from the content script. If the content script is
 * not yet injected, this helper will inject content.js and retry
 * once.
 *
 * @param {number} tabId
 * @param {Object} payload
 */
async function sendToContent(tabId, payload) {
  // Helper to send a message
  const send = () => new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, payload, (resp) => {
      if (chrome.runtime.lastError) {
        resolve(undefined);
      } else {
        resolve(resp);
      }
    });
  });
  let resp = await send();
  if (resp === undefined) {
    // Attempt to inject the content script and retry
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    } catch (e) {
      console.warn('Unshackle: failed to inject content script', e);
    }
    resp = await send();
  }
  return resp;
}

/**
 * Load the tip and contact links from the packaged text files and
 * update the corresponding anchors. If fetching fails the links
 * remain as-is.
 */
async function loadLinks() {
  try {
    const tipUrl = chrome.runtime.getURL('tip_link.txt');
    const tip = await (await fetch(tipUrl)).text();
    if (refs.tipLink) refs.tipLink.href = tip.trim();
  } catch {}
  try {
    const contactUrl = chrome.runtime.getURL('contact_link.txt');
    const contact = await (await fetch(contactUrl)).text();
    if (refs.contactLink) refs.contactLink.href = contact.trim();
  } catch {}
}

/**
 * Refresh the VISIBLE list based on current filters and update the
 * grid display accordingly.
 */
function applyFilters() {
  // Read filter values
  const minW = parseInt(refs.filterMinW.value, 10) || 0;
  const minH = parseInt(refs.filterMinH.value, 10) || 0;
  const maxW = parseInt(refs.filterMaxW.value, 10) || 0;
  const maxH = parseInt(refs.filterMaxH.value, 10) || 0;
  const selectedOptions = Array.from(refs.filterTypes.selectedOptions || []);
  const typesStr = selectedOptions.map((opt) => opt.value).join(',');
  const types = parseTypes(typesStr);
  VISIBLE = filterItems(CACHE, { minW, minH, maxW, maxH, types });
  renderGrid();
}

/**
 * Render the grid of images based on VISIBLE. Each card shows a
 * thumbnail, filename, dimensions and file type. Selecting a
 * checkbox toggles selection state in SELECTED.
 */
function renderGrid() {
  const grid = refs.grid;
  grid.innerHTML = '';
  VISIBLE.forEach((item, index) => {
    // Create card
    const card = document.createElement('div');
    card.className = 'card';
    // Thumbnail
    const thumb = document.createElement('img');
    thumb.className = 'thumb';
    thumb.src = item.url;
    thumb.alt = item.filename;
    card.appendChild(thumb);
    // Meta info
    const meta = document.createElement('div');
    meta.className = 'meta';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = item.filename;
    const dims = document.createElement('div');
    dims.className = 'dim';
    dims.textContent = `${item.width}×${item.height}`;
    const type = document.createElement('div');
    type.className = 'ext';
    const ext = extOf(item.url);
    type.textContent = ext.toUpperCase();
    meta.appendChild(name);
    meta.appendChild(dims);
    meta.appendChild(type);
    card.appendChild(meta);
    // Checkbox
    const label = document.createElement('label');
    label.className = 'select-box';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = SELECTED.has(item.url);
    cb.addEventListener('change', () => {
      if (cb.checked) SELECTED.add(item.url); else SELECTED.delete(item.url);
      updateSummary();
    });
    label.appendChild(cb);
    card.appendChild(label);
    grid.appendChild(card);
  });
  updateSummary();
}

/**
 * Update the summary text showing counts of total, visible and
 * selected items.
 */
function updateSummary() {
  const total = CACHE.length;
  const visible = VISIBLE.length;
  const selected = Array.from(SELECTED).filter((url) => VISIBLE.some((it) => it.url === url)).length;
  refs.summary.textContent = `Total: ${total} • Visible: ${visible} • Selected: ${selected}`;
}

/**
 * Perform a full scan (images + canvases). Populates CACHE and
 * updates the UI. Shows a progress indicator while scanning.
 */
async function runScanAll() {
  const tab = await getActiveTab();
  if (!tab) return;
  // Start progress
  const prog = createProgress('scan');
  prog.start(1, 'Scanning…');
  // Request scanAll from content script
  const res = await sendToContent(tab.id, { action: 'scanAll', options: {} });
  if (res && res.images) {
    CACHE = [];
    SELECTED.clear();
    let idCounter = 1;
    res.images.forEach((it) => {
      // Assign a unique id and ensure filename exists
      it._id = idCounter++;
      if (!it.filename) {
        // Fallback to slug from URL
        const nameBase = (() => {
          try {
            const u = new URL(it.url);
            return u.pathname.split('/').pop() || 'image';
          } catch {
            return 'image';
          }
        })();
        const ext = extOf(it.url) || 'png';
        it.filename = `${nameBase}.${ext}`;
      }
      CACHE.push(it);
    });
  }
  prog.end('Scan complete');
  applyFilters();
}

/**
 * Remove overlays using default keywords. This triggers the
 * content script to perform heuristics + keyword sweep and then
 * shows a short progress indicator.
 */
async function runNukeOverlays() {
  const tab = await getActiveTab();
  if (!tab) return;
  const keywords = ['overlay', 'overlays', 'wrap', 'wrapper', 'cover'];
  const prog = createProgress('nuke');
  prog.start(1, 'Removing overlays…');
  await sendToContent(tab.id, { action: 'nukeByKeywords', keywords });
  // Also run heuristic nuke in case there are overlays without these names
  await sendToContent(tab.id, { action: 'nukeOverlays' });
  prog.end('Overlays removed');
}

/**
 * Start or stop auto scan. When enabled, the content script will
 * monitor scroll/resize and periodically re-scan the page. The
 * panel will poll for updated results and refresh the grid.
 */
async function handleAutoScanChange(e) {
  const tab = await getActiveTab();
  if (!tab) return;
  if (e.target.checked) {
    // Start auto scan in content script
    await sendToContent(tab.id, { action: 'startAutoScan', options: { debounceMs: 800, scanOptions: {} } });
    // Poll for updates
    autoScanInterval = setInterval(async () => {
      const res = await sendToContent(tab.id, { action: 'getCached' });
      if (res && res.images) {
        // Replace CACHE and refresh filters + grid
        CACHE = [];
        SELECTED.clear();
        let idCounter = 1;
        res.images.forEach((it) => {
          it._id = idCounter++;
          if (!it.filename) {
            const ext = extOf(it.url) || 'png';
            const name = (() => {
              try {
                const u = new URL(it.url);
                return u.pathname.split('/').pop() || 'image';
              } catch {
                return 'image';
              }
            })();
            it.filename = `${name}.${ext}`;
          }
          CACHE.push(it);
        });
        applyFilters();
      }
    }, 1500);
  } else {
    // Stop auto scan
    await sendToContent(tab.id, { action: 'stopAutoScan' });
    if (autoScanInterval) clearInterval(autoScanInterval);
    autoScanInterval = null;
  }
}

/**
 * Start or stop watching canvases for changes. When enabled, the
 * content script will monitor canvases and add new frames to the
 * cache. The panel polls for updates similarly to auto scan.
 */
async function handleAutoCanvasChange(e) {
  const tab = await getActiveTab();
  if (!tab) return;
  if (e.target.checked) {
    await sendToContent(tab.id, { action: 'startCanvasWatch', options: { autoDownload: false } });
    autoCanvasInterval = setInterval(async () => {
      const res = await sendToContent(tab.id, { action: 'getCached' });
      if (res && res.images) {
        CACHE = [];
        SELECTED.clear();
        let idCounter = 1;
        res.images.forEach((it) => {
          it._id = idCounter++;
          if (!it.filename) {
            const ext = extOf(it.url) || 'png';
            const name = (() => {
              try {
                const u = new URL(it.url);
                return u.pathname.split('/').pop() || 'canvas';
              } catch {
                return 'canvas';
              }
            })();
            it.filename = `${name}.${ext}`;
          }
          CACHE.push(it);
        });
        applyFilters();
      }
    }, 2000);
  } else {
    await sendToContent(tab.id, { action: 'stopCanvasWatch' });
    if (autoCanvasInterval) clearInterval(autoCanvasInterval);
    autoCanvasInterval = null;
  }
}

/**
 * Handle custom events from the Advanced drawer. The event.detail
 * object contains parameters depending on the action.
 *
 * - adv.nuke: detail.keywords: array of strings
 * - adv.rename: detail.start: starting number
 * - adv.convert: detail.format: target format (webp/jpg/png)
 */
async function handleAdvancedEvent(evt) {
  const type = evt.type;
  const detail = evt.detail || {};
  if (type === 'adv.nuke') {
    await runNukeByKeywords(detail.keywords || []);
  } else if (type === 'adv.rename') {
    await runRename(detail.start);
  } else if (type === 'adv.convert') {
    await runConvert(detail.format);
  }
}

/**
 * Remove overlays by specified keywords. Wraps runNukeOverlays but
 * passes a custom list of keywords. Shows progress during the
 * operation.
 *
 * @param {Array<string>} keywords
 */
async function runNukeByKeywords(keywords) {
  const tab = await getActiveTab();
  if (!tab) return;
  if (!Array.isArray(keywords) || keywords.length === 0) {
    return runNukeOverlays();
  }
  const prog = createProgress('nukeCustom');
  prog.start(1, 'Removing overlays…');
  await sendToContent(tab.id, { action: 'nukeByKeywords', keywords });
  await sendToContent(tab.id, { action: 'nukeOverlays' });
  prog.end('Overlays removed');
}

/**
 * Rename selected items sequentially. Items are processed in the
 * order they appear in VISIBLE. After renaming the grid is
 * re-rendered.
 *
 * @param {number} startNum
 */
async function runRename(startNum) {
  const start = typeof startNum === 'number' && startNum > 0 ? Math.floor(startNum) : 1;
  // Gather selected visible items in display order
  const itemsToRename = VISIBLE.filter((it) => SELECTED.has(it.url));
  if (itemsToRename.length === 0) return;
  const prog = createProgress('rename');
  prog.start(itemsToRename.length, 'Renaming…');
  // Perform rename
  renameSequential(itemsToRename, { start, base: 'image', pad: 0, keepExt: true });
  // Since renameSequential updates filenames in place, we don't need mapping
  prog.end('Renamed');
  renderGrid();
}

/**
 * Convert selected items to the specified format. Fetches each
 * image, converts via canvas and triggers downloads individually.
 *
 * @param {string} fmt 'webp' | 'jpg' | 'png'
 */
async function runConvert(fmt) {
  fmt = (fmt || '').toLowerCase();
  if (!['webp','jpg','png'].includes(fmt)) return;
  const items = VISIBLE.filter((it) => SELECTED.has(it.url));
  if (items.length === 0) return;
  const total = items.length;
  const prog = createProgress('convert');
  prog.start(total, `Converting to ${fmt.toUpperCase()}…`);
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    try {
      // Fetch the blob
      const blob = await fetch(it.url).then((r) => r.blob());
      const converted = await convertBlob(blob, fmt);
      // Create a URL for download
      const blobUrl = URL.createObjectURL(converted);
      const ext = fmt;
      const baseName = it.filename ? it.filename.replace(/\.[^.]+$/, '') : `image-${i+1}`;
      const filename = `${baseName}.${ext}`;
      // Trigger download via background script
      await chrome.runtime.sendMessage({ action: 'downloadURLs', items: [{ url: blobUrl, filename }], saveAs: false });
      URL.revokeObjectURL(blobUrl);
    } catch (err) {
      console.warn('Unshackle: conversion failed', err);
    }
    prog.tick();
  }
  prog.end('Converted');
}

/**
 * Convert a blob into a given image format using an offscreen
 * canvas (if available) or an in-page canvas fallback. Returns a
 * Blob of the converted image. Quality is set to 0.92 for JPEG.
 *
 * @param {Blob} blob Source image
 * @param {string} fmt Target format (webp | jpg | png)
 * @returns {Promise<Blob>}
 */
async function convertBlob(blob, fmt) {
  const mime = fmt === 'jpg' ? 'image/jpeg' : (fmt === 'png' ? 'image/png' : 'image/webp');
  // Use OffscreenCanvas if available
  if (typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(bmp.width, bmp.height);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bmp, 0, 0);
      return await canvas.convertToBlob({ type: mime, quality: fmt === 'jpg' ? 0.92 : 0.95 });
    } catch {}
  }
  // Fallback to regular canvas
  return new Promise((resolve, reject) => {
    const img = document.createElement('img');
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        canvas.toBlob((result) => {
          if (result) resolve(result); else reject(new Error('Conversion failed'));
        }, mime, fmt === 'jpg' ? 0.92 : 0.95);
      } catch (e) {
        reject(e);
      }
    };
    img.onerror = (e) => reject(e);
    img.src = URL.createObjectURL(blob);
  });
}

/**
 * Download selected items as individual files. Uses the background
 * script's downloadURLs API. Selected items must be visible.
 */
async function runDownloadSelected() {
  const items = VISIBLE.filter((it) => SELECTED.has(it.url));
  if (items.length === 0) return;
  const task = createProgress('download');
  task.start(items.length, 'Downloading…');
  const payload = items.map((it) => ({ url: it.url, filename: it.filename }));
  await chrome.runtime.sendMessage({ action: 'downloadURLs', items: payload, saveAs: false });
  task.end('Downloaded');
}

/**
 * Create a ZIP of selected items and download it. Uses JSZip from
 * the global scope (loaded in panel.html). Each file is fetched,
 * optionally converted (future), then added to the ZIP. Once
 * complete the ZIP is downloaded via a blob URL.
 */
async function runZipSelected() {
  const items = VISIBLE.filter((it) => SELECTED.has(it.url));
  if (!items.length) return;
  const zip = new JSZip();
  const task = createProgress('zip');
  task.start(items.length, 'Zipping…');
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    try {
      const resp = await fetch(it.url);
      const buf = await resp.arrayBuffer();
      const ext = extOf(it.url) || 'png';
      let name = it.filename || `image-${i+1}.${ext}`;
      // Prevent duplicate file names in zip
      let candidate = name;
      let j = 2;
      while (zip.file(candidate)) {
        const dot = name.lastIndexOf('.');
        const base = dot >= 0 ? name.slice(0, dot) : name;
        const ex = dot >= 0 ? name.slice(dot) : '';
        candidate = `${base}-${j}${ex}`;
        j++;
      }
      zip.file(candidate, buf);
    } catch (err) {
      console.warn('Unshackle: ZIP fetch failed', err);
    }
    task.tick();
  }
  const blob = await zip.generateAsync({ type: 'blob' });
  const zipUrl = URL.createObjectURL(blob);
  const filename = `unshackle_${Date.now()}.zip`;
  await chrome.runtime.sendMessage({ action: 'downloadURLs', items: [{ url: zipUrl, filename }], saveAs: true });
  URL.revokeObjectURL(zipUrl);
  task.end('Zipped');
}

/**
 * Initialize the UI: cache DOM references, attach progress bar,
 * load links, mount advanced drawer, and attach event listeners.
 */
function initUI() {
  // Cache DOM references
  refs.btnScanAll = document.getElementById('btnScanAll');
  refs.btnNukeOverlays = document.getElementById('btnNukeOverlays');
  refs.tipLink = document.getElementById('tipLink');
  refs.contactLink = document.getElementById('contactLink');
  refs.settingsBtn = document.getElementById('settingsBtn');
  refs.progressWrap = document.getElementById('progressWrap');
  refs.progressBar = document.getElementById('progressBar');
  refs.progressText = document.getElementById('progressText');
  refs.toggleAutoScan = document.getElementById('toggleAutoScan');
  refs.toggleAutoCanvas = document.getElementById('toggleAutoCanvas');
  refs.btnAdvanced = document.getElementById('btnAdvanced');
  refs.advancedSection = document.getElementById('advancedSection');
  refs.filterMinW = document.getElementById('filterMinW');
  refs.filterMinH = document.getElementById('filterMinH');
  refs.filterMaxW = document.getElementById('filterMaxW');
  refs.filterMaxH = document.getElementById('filterMaxH');
  refs.filterTypes = document.getElementById('filterTypes');
  refs.btnApplyFilter = document.getElementById('btnApplyFilter');
  refs.summary = document.getElementById('summary');
  refs.grid = document.getElementById('grid');
  refs.btnAutoSelect = document.getElementById('btnAutoSelect');
  refs.btnAutoRename = document.getElementById('btnAutoRename');
  refs.btnConvert = document.getElementById('btnConvert');
  refs.btnDownload = document.getElementById('btnDownload');
  refs.btnZip = document.getElementById('btnZip');
  // Attach progress bar
  attachProgress({ wrap: refs.progressWrap, bar: refs.progressBar, text: refs.progressText });
  // Load tip/contact links
  loadLinks();
  // Mount advanced options once when expanded
  let advancedMounted = false;
  refs.btnAdvanced.addEventListener('click', () => {
    refs.advancedSection.classList.toggle('hide');
    if (!advancedMounted) {
      mountAdvanced(refs.advancedSection);
      // Listen for advanced events
      refs.advancedSection.addEventListener('adv.nuke', handleAdvancedEvent);
      refs.advancedSection.addEventListener('adv.rename', handleAdvancedEvent);
      refs.advancedSection.addEventListener('adv.convert', handleAdvancedEvent);
      advancedMounted = true;
    }
  });
  // Bind primary buttons
  refs.btnScanAll.addEventListener('click', runScanAll);
  refs.btnNukeOverlays.addEventListener('click', runNukeOverlays);
  // Toggles
  refs.toggleAutoScan.addEventListener('change', handleAutoScanChange);
  refs.toggleAutoCanvas.addEventListener('change', handleAutoCanvasChange);
  // Filtering
  refs.btnApplyFilter.addEventListener('click', applyFilters);
  // Batch controls
  refs.btnAutoSelect.addEventListener('click', () => {
    // Select all visible
    SELECTED = selectAll(VISIBLE);
    renderGrid();
  });
  refs.btnAutoRename.addEventListener('click', () => {
    // Use prompt for start number
    const startStr = prompt('Start numbering from:', '1');
    const start = parseInt(startStr, 10);
    runRename(start);
  });
  refs.btnConvert.addEventListener('click', () => {
    const fmt = prompt('Convert selected to (webp, jpg, png):', 'webp');
    if (fmt) runConvert(fmt.trim().toLowerCase());
  });
  refs.btnDownload.addEventListener('click', runDownloadSelected);
  refs.btnZip.addEventListener('click', runZipSelected);
  // Progress updates from content
  chrome.runtime.onMessage.addListener((msg) => {
    // Listen for taskProgress messages from content script
    if (msg && msg.action === 'taskProgress' && msg.taskId) {
      updateFromMessage(msg);
    }
  });
}

// Initialize after DOM ready
document.addEventListener('DOMContentLoaded', initUI);