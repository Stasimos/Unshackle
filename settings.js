// Settings helper for Unshackle
//
// This module exposes functions to persist and retrieve user
// preferences. Currently only the UI mode (sidepanel vs popup) is
// stored, but additional settings can be added without changing the
// public API.

const KEY = 'unshackle-settings';

/**
 * Retrieve settings from chrome.storage.sync. Defaults to sidepanel.
 *
 * @returns {Promise<{ uiMode: 'sidepanel' | 'popup' }>} current settings
 */
export async function getSettings() {
  const res = await chrome.storage.sync.get(KEY);
  return res[KEY] ?? { uiMode: 'sidepanel' };
}

/**
 * Persist a complete settings object. Unknown keys are ignored by
 * callers. Use setSetting() when updating a single key.
 *
 * @param {Object} obj
 */
async function setSettings(obj) {
  await chrome.storage.sync.set({ [KEY]: obj });
}

/**
 * Set a specific key on the settings object.
 *
 * @param {string} key
 * @param {any} value
 */
export async function setSetting(key, value) {
  const current = await getSettings();
  current[key] = value;
  await setSettings(current);
}

/**
 * Set the UI mode. Accepts 'sidepanel' or 'popup'. If an invalid
 * value is provided, it falls back to 'sidepanel'.
 *
 * @param {'sidepanel'|'popup'} mode
 */
export async function setUIMode(mode) {
  const valid = mode === 'popup' ? 'popup' : 'sidepanel';
  await setSetting('uiMode', valid);
}

/**
 * Watch for changes to the settings. The callback will be invoked
 * whenever the stored settings object changes. Useful for reacting
 * to user changes in the panel.
 *
 * @param {(settings:Object) => void} callback
 */
export function watchSettings(callback) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes[KEY]) {
      callback(changes[KEY].newValue);
    }
  });
}

/**
 * Open the UI according to the current preference. When the side
 * panel mode is selected and the API is available, the side panel
 * is opened for the provided tab. Otherwise a popup window is
 * created. If tabId is null, the popup will be used.
 *
 * @param {number|null} tabId
 */
export async function openUI(tabId) {
  const { uiMode } = await getSettings();
  if (uiMode === 'sidepanel' && chrome.sidePanel && tabId != null) {
    try {
      await chrome.sidePanel.setOptions({ tabId, path: 'panel.html', enabled: true });
      await chrome.sidePanel.open({ tabId });
      return;
    } catch (err) {
      console.warn('Unshackle: sidePanel open failed, falling back to popup', err);
    }
  }
  // Fallback: open as a popup
  chrome.windows.create({ url: 'panel.html', type: 'popup', width: 420, height: 760 });
}

/**
 * Apply side panel behavior when the extension is installed. This
 * function should be called from background.js on install. It
 * configures the side panel to open automatically when clicking the
 * extension action button if the user selects sidepanel mode. On
 * unsupported platforms this call is ignored.
 */
export async function applyOnInstalled() {
  const { uiMode } = await getSettings();
  if (uiMode === 'sidepanel' && chrome.sidePanel?.setPanelBehavior) {
    try {
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    } catch (err) {
      console.warn('Unshackle: setPanelBehavior failed', err);
    }
  }
}