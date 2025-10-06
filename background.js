// Background script for Unshackle extension.
//
// This module sets up event listeners to open the UI (either in a side
// panel or a popup window) and exposes a few helper endpoints for the
// content and panel scripts. It also provides a captureVisible handler
// used by the content script when a canvas is tainted and must be
// screenshotted.

// Import the settings helper. This file lives at the root of the
// extension. We load it lazily when needed to avoid circular
// dependencies. Because the service worker is a module (see manifest),
// we can import other ES modules directly.
import * as settings from './settings.js';

// When the extension is installed or updated, apply any side panel
// configuration. This sets up the Side Panel API so clicking the
// toolbar icon opens our panel by default. Without this call the
// sidePanel API will not automatically open the panel.
chrome.runtime.onInstalled.addListener(async () => {
  try {
    await settings.applyOnInstalled();
  } catch (err) {
    // It's safe to ignore errors here – if the API isn't available
    // (older Chromium), the settings helper will no-op.
    console.warn('Unshackle: applyOnInstalled error', err);
  }
});

// Handle clicks on the extension action. Depending on user preference
// (stored via settings.js) this will open either the side panel or
// fallback to a popup window. See settings.openUI for details.
chrome.action.onClicked.addListener(async (tab) => {
  try {
    const { uiMode } = await settings.getSettings();
    // Always call openUI – it decides whether to open the side panel
    // or create a popup window. It accepts a tabId when opening the
    // side panel so the panel attaches to the correct tab.
    await settings.openUI(tab?.id ?? null);
  } catch (err) {
    console.warn('Unshackle: openUI failed, falling back to popup', err);
    // Fallback: open panel.html in a popup window. Use a sensible
    // default size; the user can resize it if desired.
    chrome.windows.create({ url: 'panel.html', type: 'popup', width: 420, height: 760 });
  }
});

// Capture the visible portion of the active tab. This is used by the
// content script when a canvas is tainted (due to CORS) and cannot be
// read directly. The content script sends a capture request and then
// crops the screenshot to the element's bounding rect. We must
// activate the tab's window first or Chrome will capture the wrong
// window when the extension panel has focus.
async function captureVisible(tabId) {
  if (!tabId) return { ok: false, dataUrl: null };
  try {
    // Get info about the tab to retrieve its windowId. Some versions
    // of Chrome will error if we do not have permission to access
    // this tab; in that case just return failure.
    const tab = await chrome.tabs.get(tabId);
    // If the tab exists, activate it before capturing. Without
    // activation Chrome.captureVisibleTab may capture another tab.
    await chrome.tabs.update(tabId, { active: true });
    const dataUrl = await new Promise((resolve) => {
      chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }, (url) => {
        if (chrome.runtime.lastError || !url) {
          resolve(null);
        } else {
          resolve(url);
        }
      });
    });
    return { ok: !!dataUrl, dataUrl };
  } catch (err) {
    console.warn('Unshackle: captureVisible failed', err);
    return { ok: false, dataUrl: null };
  }
}

// Download multiple URLs using the downloads API. The panel sends a
// list of objects with url and filename fields. Each file will be
// downloaded with the given name. If there is an error the promise
// resolves with false and lastError.
async function downloadURLs(items, saveAs=false) {
  const results = [];
  for (const item of items) {
    try {
      const id = await new Promise((resolve, reject) => {
        chrome.downloads.download({ url: item.url, filename: item.filename, saveAs, conflictAction: 'uniquify' }, (downloadId) => {
          if (chrome.runtime.lastError) {
            return reject(chrome.runtime.lastError);
          }
          resolve(downloadId);
        });
      });
      results.push({ id, ok: true });
    } catch (err) {
      console.warn('Unshackle: download failed', item.url, err);
      results.push({ ok: false, error: String(err) });
    }
  }
  return results;
}

// Listen for messages from panel and content scripts. Each handler
// returns a promise or synchronous value. All results are sent back
// via sendResponse. Without returning true from the listener, Chrome
// will treat asynchronous responses as undefined.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.action === 'captureVisible') {
        const resp = await captureVisible(msg.tabId ?? sender?.tab?.id);
        sendResponse(resp);
      } else if (msg?.action === 'downloadURLs') {
        const results = await downloadURLs(msg.items ?? [], msg.saveAs ?? false);
        sendResponse({ ok: true, results });
      } else {
        // Unknown action – no response necessary
      }
    } catch (err) {
      sendResponse({ ok: false, error: String(err) });
    }
  })();
  // Indicate the response will be sent asynchronously
  return true;
});