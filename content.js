// Content script for Unshackle
//
// This file runs in the context of every page that the user opens.
// It defines functions for scanning images and canvases, managing
// automatic scanning, monitoring canvas changes, and removing
// obstructive overlays. The panel and background scripts send
// messages to this script to trigger scans and other tasks. The
// results of scans are returned via sendResponse.

// Internal state for tracking scanned images and auto scan status.
const STATE = { images: [], lastScanAt: 0 };

// Auto scan configuration. When enabled, Unshackle will
// automatically re-run the scan at a throttled interval whenever the
// page scrolls or resizes. This helps pick up lazy-loaded images and
// newly inserted elements.
const AUTO_SCAN = { enabled: false, handler: null, lastRun: 0, options: {} };

// Canvas watch configuration. When enabled, Unshackle will watch
// canvases for changes and capture frames automatically. Each
// modified frame is added to STATE.images. If autoDownload is true,
// the images will also be downloaded automatically. Frames are
// numbered per canvas to avoid overwriting.
const CANVAS_WATCH = {
  on: false,
  rafId: 0,
  lastHash: new WeakMap(),
  seq: new WeakMap(),
  threshold: 40,
  hashSize: 32,
  autoDownload: false,
  targetTabId: null
};

/* ------------------------------------------------------------------ */
/* Helper functions                                                     */
/* ------------------------------------------------------------------ */

// Convert a relative URL to an absolute URL based on the current
// document location. Returns null if the URL cannot be resolved.
function toAbsURL(url) {
  try {
    return new URL(url, location.href).href;
  } catch {
    return null;
  }
}

// Extract a reasonable filename from an image source. Use
// data-filename, download, alt, title or aria-label attributes on the
// element, fall back to the URL's basename, and finally a generic
// image name. Slugify the name and truncate to 80 characters. This
// helper does not include the extension.
function baseNameFromElement(el, url, index) {
  const candidates = [];
  const getAttr = (attr) => {
    try { return el.getAttribute(attr) || ''; } catch { return ''; }
  };
  candidates.push(getAttr('data-filename'));
  candidates.push(getAttr('download'));
  candidates.push(getAttr('alt'));
  candidates.push(getAttr('title'));
  candidates.push(getAttr('aria-label'));
  // Nearby figcaption text can sometimes describe the image
  try {
    const fig = el.closest('figure');
    if (fig) {
      const caption = fig.querySelector('figcaption');
      if (caption && caption.textContent) candidates.push(caption.textContent.trim());
    }
  } catch {}
  // Use URL basename
  try {
    const u = new URL(url);
    const base = u.pathname.split('/').pop() || '';
    candidates.push(decodeURIComponent(base));
  } catch {}
  // Fallback to document title plus index
  candidates.push(`${document.title || 'image'}-${index + 1}`);
  // Slugify
  const slug = (s) => s.trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._-]+/gi, '')
    .replace(/-+/g, '-')
    .replace(/^[-_.]+|[-_.]+$/g, '')
    .slice(0, 80);
  for (const c of candidates) {
    const s = slug(c);
    if (s) return s;
  }
  return 'image';
}

// Determine the extension for an image based on its URL or MIME type.
function extensionFrom(url, mime) {
  // Try to extract from URL
  try {
    const u = new URL(url);
    const base = u.pathname.split('/').pop() || '';
    const dot = base.lastIndexOf('.');
    if (dot >= 0) {
      const ext = base.slice(dot + 1).split(/[?#]/)[0].toLowerCase();
      if (ext) {
        if (ext === 'jpeg') return 'jpg';
        return ext;
      }
    }
  } catch {}
  // Derive from data URI
  if (url && url.startsWith('data:image/')) {
    try {
      const m = /data:image\/([a-z0-9+.-]+);/i.exec(url);
      if (m) {
        let ext = m[1].toLowerCase();
        if (ext === 'jpeg') ext = 'jpg';
        return ext;
      }
    } catch {}
  }
  // Fallback to mime type
  if (mime && mime.startsWith('image/')) {
    let ext = mime.split('/')[1].toLowerCase();
    if (ext === 'jpeg') ext = 'jpg';
    return ext;
  }
  return 'png';
}

// De-duplicate filenames by appending a numeric suffix. Uses a set
// stored on STATE to track used filenames across scans.
function uniquifyName(name) {
  if (!STATE._seenNames) STATE._seenNames = new Set();
  const seen = STATE._seenNames;
  if (!seen.has(name)) {
    seen.add(name);
    return name;
  }
  const dot = name.lastIndexOf('.');
  const base = dot >= 0 ? name.slice(0, dot) : name;
  const ext = dot >= 0 ? name.slice(dot) : '';
  let i = 2;
  let candidate;
  do {
    candidate = `${base}-${i}${ext}`;
    i++;
  } while (seen.has(candidate));
  seen.add(candidate);
  return candidate;
}

// Hash a canvas's pixels by downsampling to a small grayscale image and
// thresholding around the mean. The result is a compact Uint8Array
// representing the pattern of light/dark pixels. Returns null if the
// canvas cannot be read (tainted). Borrowed from the original
// unshackle implementation.
function hashCanvasPixels(cv) {
  const size = CANVAS_WATCH.hashSize;
  const off = document.createElement('canvas');
  off.width = size;
  off.height = size;
  const ctx = off.getContext('2d', { willReadFrequently: true });
  try {
    ctx.drawImage(cv, 0, 0, size, size);
  } catch {
    return null;
  }
  const data = ctx.getImageData(0, 0, size, size).data;
  const gray = new Uint8Array(size * size);
  let sum = 0;
  let j = 0;
  for (let i = 0; i < data.length; i += 4) {
    const g = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0;
    gray[j++] = g;
    sum += g;
  }
  const mean = (sum / gray.length) | 0;
  const bits = new Uint8Array((gray.length + 7) >> 3);
  for (let k = 0; k < gray.length; k++) {
    if (gray[k] > mean) bits[k >> 3] |= 1 << (k & 7);
  }
  return bits;
}

// Compute the Hamming distance between two hashes. Returns Infinity if
// arrays differ in length. Borrowed from original implementation.
function hammingDistance(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    let x = a[i] ^ b[i];
    x = x - ((x >>> 1) & 0x55);
    x = (x & 0x33) + ((x >>> 2) & 0x33);
    d += (((x + (x >>> 4)) & 0x0F) * 0x01);
  }
  return d;
}

// Wait for the next paint and optionally an extra delay. Used when
// ensuring an element is visible before taking a screenshot.
async function waitForNextPaint(extraMs = 120) {
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  if (extraMs) await new Promise((r) => setTimeout(r, extraMs));
}

// Scroll an element into view if it's outside the viewport. Returns
// after the element has had time to render.
async function ensureInView(el) {
  const rect = el.getBoundingClientRect();
  if (
    rect.top < 0 ||
    rect.left < 0 ||
    rect.bottom > window.innerHeight ||
    rect.right > window.innerWidth
  ) {
    el.scrollIntoView({ block: 'center', inline: 'center' });
    await waitForNextPaint(150);
  }
}

// Capture a screenshot of the element's bounding rectangle. This is
// used when the canvas is tainted and cannot be read directly. The
// content script sends a message to the background to capture the
// visible tab; then the image is cropped to the element bounds. If
// capture fails, returns null.
async function captureElementRect(el, tabId) {
  await ensureInView(el);
  await waitForNextPaint(140);
  const rect = el.getBoundingClientRect();
  const resp = await chrome.runtime.sendMessage({ action: 'captureVisible', tabId });
  if (!resp || !resp.ok || !resp.dataUrl) return null;
  const img = new Image();
  img.src = resp.dataUrl;
  try {
    await img.decode();
  } catch {
    return null;
  }
  const dpr = window.devicePixelRatio || 1;
  const sx = Math.max(0, Math.round(rect.x * dpr));
  const sy = Math.max(0, Math.round(rect.y * dpr));
  const sw = Math.max(1, Math.round(rect.width * dpr));
  const sh = Math.max(1, Math.round(rect.height * dpr));
  const cv = document.createElement('canvas');
  cv.width = sw;
  cv.height = sh;
  const ctx = cv.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
  try {
    return cv.toDataURL('image/png');
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Scanning functions                                                  */
/* ------------------------------------------------------------------ */

/**
 * Scan for normal images (<img> tags). Returns an array of objects
 * containing url, width, height and filename. Images that cannot be
 * resolved to an absolute URL are ignored. Duplicates are removed
 * based on their URL.
 *
 * @param {Object} opts
 * @param {number} [opts.minWidth]  Minimum width to include
 * @param {number} [opts.minHeight] Minimum height to include
 * @param {number} [opts.maxWidth]  Maximum width (0 = no limit)
 * @param {number} [opts.maxHeight] Maximum height (0 = no limit)
 * @returns {Array<{url:string,width:number,height:number,filename:string,type:string}>}
 */
function scanImages(opts = {}) {
  const minW = opts.minWidth || 0;
  const minH = opts.minHeight || 0;
  const maxW = opts.maxWidth || 0;
  const maxH = opts.maxHeight || 0;
  const out = [];
  let index = 0;
  for (const img of document.images) {
    const url = img.currentSrc || img.src;
    if (!url) continue;
    const abs = toAbsURL(url);
    if (!abs) continue;
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    if (w < minW || h < minH) continue;
    if ((maxW > 0 && w > maxW) || (maxH > 0 && h > maxH)) continue;
    const base = baseNameFromElement(img, abs, index);
    const ext = extensionFrom(abs);
    const filename = uniquifyName(`${base}.${ext}`);
    out.push({ url: abs, width: w, height: h, filename, type: 'img' });
    index++;
  }
  // CSS background images on elements
  for (const el of document.querySelectorAll('*')) {
    const style = getComputedStyle(el);
    const bg = style.getPropertyValue('background-image');
    if (!bg || bg === 'none') continue;
    const urls = Array.from(bg.matchAll(/url\(["']?(.+?)["']?\)/g)).map((m) => m[1]);
    const rect = el.getBoundingClientRect();
    for (const u of urls) {
      const abs = toAbsURL(u);
      if (!abs) continue;
      const w = Math.round(rect.width);
      const h = Math.round(rect.height);
      if (w < minW || h < minH) continue;
      if ((maxW > 0 && w > maxW) || (maxH > 0 && h > maxH)) continue;
      const base = baseNameFromElement(el, abs, index);
      const ext = extensionFrom(abs);
      const filename = uniquifyName(`${base}.${ext}`);
      out.push({ url: abs, width: w, height: h, filename, type: 'css' });
      index++;
    }
  }
  // Deduplicate by URL
  const seen = new Set();
  const unique = [];
  for (const it of out) {
    if (seen.has(it.url)) continue;
    seen.add(it.url);
    unique.push(it);
  }
  return unique;
}

/**
 * Scan for canvas elements. Captures their contents via toDataURL. If
 * a canvas is tainted (due to cross-origin draws) we return null for
 * that canvas. The panel can decide whether to discard or keep those
 * entries. Each canvas is given a sequential filename.
 *
 * @param {Object} opts
 * @param {number|null} [opts.tabId]  Current tab id for capture fallback
 * @returns {Array<{url:string,width:number,height:number,filename:string,type:string}>}
 */
async function scanCanvases(opts = {}) {
  const items = [];
  let count = 1;
  const canvases = document.querySelectorAll('canvas');
  for (const cv of canvases) {
    const w = cv.width;
    const h = cv.height;
    if (w < 1 || h < 1) continue;
    let dataUrl = null;
    try {
      dataUrl = cv.toDataURL('image/png');
    } catch {}
    if (!dataUrl || !dataUrl.startsWith('data:image/')) {
      // Fallback to screenshot
      try {
        dataUrl = await captureElementRect(cv, opts.tabId);
      } catch {}
    }
    if (dataUrl && dataUrl.startsWith('data:image/')) {
      const filename = uniquifyName(`canvas_${count}.png`);
      items.push({ url: dataUrl, width: w, height: h, filename, type: 'canvas' });
      count++;
    }
  }
  return items;
}

/**
 * Perform a comprehensive scan of both normal images and canvases. The
 * options argument controls minimum/maximum dimensions. The tabId
 * should be provided when scanning canvases so the fallback capture
 * mechanism can target the correct tab. Returns an array of items.
 *
 * @param {Object} opts
 * @returns {Promise<Array>}
 */
async function scanAll(opts = {}) {
  const imgs = scanImages(opts);
  const cvs = await scanCanvases(opts);
  const combined = imgs.concat(cvs);
  STATE.images = combined;
  STATE.lastScanAt = Date.now();
  return combined;
}

/* ------------------------------------------------------------------ */
/* Auto scan management                                                */
/* ------------------------------------------------------------------ */

function startAutoScan(opts = {}) {
  if (AUTO_SCAN.enabled) return;
  AUTO_SCAN.enabled = true;
  AUTO_SCAN.options = opts;
  AUTO_SCAN.lastRun = 0;
  const handler = async () => {
    const now = Date.now();
    // throttle scans – don't run more often than every 600ms
    if (now - AUTO_SCAN.lastRun < 600) return;
    AUTO_SCAN.lastRun = now;
    try {
      await scanAll(opts);
      // Notify the panel that new images are available
      chrome.runtime.sendMessage({ action: 'taskProgress', taskId: 'autoScan', phase: 'update', done: 1, total: 1, label: 'Auto scan update' });
    } catch {}
  };
  AUTO_SCAN.handler = handler;
  window.addEventListener('scroll', handler, { passive: true });
  window.addEventListener('resize', handler, { passive: true });
  // Kick off immediately
  handler();
}

function stopAutoScan() {
  if (!AUTO_SCAN.enabled) return;
  window.removeEventListener('scroll', AUTO_SCAN.handler);
  window.removeEventListener('resize', AUTO_SCAN.handler);
  AUTO_SCAN.enabled = false;
  AUTO_SCAN.handler = null;
}

/* ------------------------------------------------------------------ */
/* Canvas watch management                                             */
/* ------------------------------------------------------------------ */

async function tickCanvasWatch() {
  if (!CANVAS_WATCH.on) return;
  const canvases = document.querySelectorAll('canvas');
  for (const cv of canvases) {
    const w = cv.width;
    const h = cv.height;
    if (w < 1 || h < 1) continue;
    const newHash = hashCanvasPixels(cv);
    if (!newHash) continue;
    const prevHash = CANVAS_WATCH.lastHash.get(cv);
    if (!prevHash) {
      CANVAS_WATCH.lastHash.set(cv, newHash);
      continue;
    }
    const dist = hammingDistance(prevHash, newHash);
    if (dist >= CANVAS_WATCH.threshold) {
      CANVAS_WATCH.lastHash.set(cv, newHash);
      const seqNum = (CANVAS_WATCH.seq.get(cv) || 0) + 1;
      CANVAS_WATCH.seq.set(cv, seqNum);
      let dataUrl = null;
      try {
        dataUrl = cv.toDataURL('image/png');
      } catch {}
      if (!dataUrl || !dataUrl.startsWith('data:image/')) {
        try {
          dataUrl = await captureElementRect(cv, CANVAS_WATCH.targetTabId);
        } catch {}
      }
      if (dataUrl && dataUrl.startsWith('data:image/')) {
        const filename = uniquifyName(`canvas_${seqNum}.png`);
        STATE.images.push({ url: dataUrl, width: w, height: h, filename, type: 'canvasWatch' });
        STATE.lastScanAt = Date.now();
        if (CANVAS_WATCH.autoDownload && CANVAS_WATCH.targetTabId != null) {
          chrome.runtime.sendMessage({ action: 'downloadURLs', items: [ { url: dataUrl, filename: `canvas_auto/${filename}` } ] });
        }
      }
    }
  }
  CANVAS_WATCH.rafId = requestAnimationFrame(tickCanvasWatch);
}

function startCanvasWatch(opts = {}) {
  if (CANVAS_WATCH.on) return;
  CANVAS_WATCH.on = true;
  CANVAS_WATCH.autoDownload = opts.autoDownload || false;
  CANVAS_WATCH.targetTabId = opts.tabId || null;
  CANVAS_WATCH.lastHash = new WeakMap();
  CANVAS_WATCH.seq = new WeakMap();
  // Kick off watcher
  CANVAS_WATCH.rafId = requestAnimationFrame(tickCanvasWatch);
}

function stopCanvasWatch() {
  if (!CANVAS_WATCH.on) return;
  CANVAS_WATCH.on = false;
  if (CANVAS_WATCH.rafId) {
    cancelAnimationFrame(CANVAS_WATCH.rafId);
    CANVAS_WATCH.rafId = 0;
  }
}

/* ------------------------------------------------------------------ */
/* Overlay removal                                                     */
/* ------------------------------------------------------------------ */

// Default overlay keywords used for automatic removal. These cover
// common class/id names seen on blocker overlays. This list can be
// extended from the panel by sending keywords via message.
const DEFAULT_OVERLAY_KEYWORDS = [
  'overlay','overlays','cover','wrapper','wrap','shield','modal','popup',
  'subscribe','paywall','consent','banner','veil','mask','promo','ad',
  'signup','cookie','gdpr','backdrop','scrim'
];

// Remove large overlays that block the page. Uses a simple heuristic:
// elements with position fixed/absolute/sticky, covering a large
// portion of the viewport, with a high z-index. After removing large
// overlays, also remove elements whose class/id/attributes contain
// keywords from DEFAULT_OVERLAY_KEYWORDS or user-provided keywords.
function nukeOverlays(opts = {}) {
  const minCoverage = opts.minCoverage ?? 0.55;
  const minZ = opts.minZ ?? 999;
  const keywords = opts.keywords ?? DEFAULT_OVERLAY_KEYWORDS;
  const removed = [];
  const vwArea = window.innerWidth * window.innerHeight;
  // First remove big overlays by heuristic
  for (const el of document.querySelectorAll('body *')) {
    try {
      const cs = getComputedStyle(el);
      if (!cs) continue;
      const pos = cs.position;
      if (!(pos === 'fixed' || pos === 'absolute' || pos === 'sticky')) continue;
      // Skip obvious media elements
      if (/(img|canvas|video|svg|picture)/i.test(el.tagName)) continue;
      const r = el.getBoundingClientRect();
      const area = Math.max(0, Math.min(r.width, window.innerWidth)) * Math.max(0, Math.min(r.height, window.innerHeight));
      const coverage = area / vwArea;
      const zi = parseInt(cs.zIndex || '0', 10);
      if (coverage >= minCoverage && zi >= minZ) {
        el.style.setProperty('pointer-events', 'none', 'important');
        el.style.setProperty('user-select', 'auto', 'important');
        if (parseFloat(cs.opacity || '1') < 0.2 || cs.backgroundImage !== 'none' || cs.backdropFilter !== 'none') {
          el.style.setProperty('z-index', '0', 'important');
        }
        removed.push(el);
      }
    } catch {}
  }
  // Also remove elements whose class/id/attributes contain keywords
  const rx = new RegExp('\\b(' + keywords.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\b', 'i');
  for (const el of document.querySelectorAll('body *')) {
    try {
      if (/(img|canvas|video|svg|picture)/i.test(el.tagName)) continue;
      const name = (el.id + ' ' + el.className).toLowerCase();
      if (rx.test(name)) {
        el.style.setProperty('pointer-events', 'none', 'important');
        el.style.setProperty('opacity', '0', 'important');
        removed.push(el);
      }
    } catch {}
  }
  // Loosen context menu restrictions (enable right-click, drag, etc.)
  ['contextmenu','dragstart','selectstart','mousedown','mouseup','click'].forEach((t) => {
    document.addEventListener(t, (e) => {
      e.stopPropagation();
    }, { capture: true, passive: true });
  });
  return { ok: true, removed: removed.length };
}

// Remove overlays by keywords only. Accepts an array of keywords
// strings. If remove is true, elements will be hidden (opacity 0,
// pointer-events none). Otherwise their z-index will be reduced. Not
// used directly by the panel but exposed for completeness.
function nukeByKeywords(keywords = [], opts = {}) {
  const remove = opts.remove ?? true;
  const keys = (keywords || []).map((k) => (k || '').trim().toLowerCase()).filter(Boolean);
  if (!keys.length) return { ok: true, removed: 0 };
  const rx = new RegExp('\\b(' + keys.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\b', 'i');
  let removed = 0;
  for (const el of document.querySelectorAll('body *')) {
    if (/(img|canvas|video|svg|picture)/i.test(el.tagName)) continue;
    const name = (el.id + ' ' + el.className).toLowerCase();
    if (rx.test(name)) {
      if (remove) {
        el.style.setProperty('opacity', '0', 'important');
      }
      el.style.setProperty('pointer-events', 'none', 'important');
      removed++;
    }
  }
  return { ok: true, removed };
}

/* ------------------------------------------------------------------ */
/* Message handler                                                     */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (!msg || typeof msg !== 'object') return;
      switch (msg.action) {
        case 'scanImages': {
          const images = scanImages(msg.options || {});
          STATE.images = images;
          STATE.lastScanAt = Date.now();
          sendResponse({ ok: true, images });
          break;
        }
        case 'scanCanvases': {
          const cvs = await scanCanvases(msg.options || {});
          STATE.images = cvs;
          STATE.lastScanAt = Date.now();
          sendResponse({ ok: true, images: cvs });
          break;
        }
        case 'scanAll': {
          const all = await scanAll(msg.options || {});
          sendResponse({ ok: true, images: all });
          break;
        }
        case 'startAutoScan': {
          startAutoScan(msg.options || {});
          sendResponse({ ok: true });
          break;
        }
        case 'stopAutoScan': {
          stopAutoScan();
          sendResponse({ ok: true });
          break;
        }
        case 'startCanvasWatch': {
          startCanvasWatch(msg.options || {});
          sendResponse({ ok: true });
          break;
        }
        case 'stopCanvasWatch': {
          stopCanvasWatch();
          sendResponse({ ok: true });
          break;
        }
        case 'nukeOverlays': {
          const res = nukeOverlays(msg.options || {});
          sendResponse(res);
          break;
        }
        case 'nukeByKeywords': {
          const res = nukeByKeywords(msg.keywords || [], msg.options || {});
          sendResponse(res);
          break;
        }
        case 'getCached': {
          sendResponse({ ok: true, images: STATE.images, lastScanAt: STATE.lastScanAt });
          break;
        }
        default:
          // Unknown action – ignore
          break;
      }
    } catch (err) {
      sendResponse({ ok: false, error: String(err) });
    }
  })();
  return true;
});