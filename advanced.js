// Advanced options UI for Unshackle
//
// This module encapsulates the Advanced drawer UI. It creates DOM
// elements for overlay keyword removal, batch renaming and image
// conversion. When the user interacts with the UI, custom events
// prefixed with 'adv.' are dispatched from the root element. The
// panel script can listen for these events to perform the actions
// externally.

import { DEFAULT_OVERLAY_KEYWORDS } from './overlaynuke.js';

/**
 * Mount the advanced options into the given root element. The root
 * should be an empty container that will be filled with markup. The
 * following custom events are dispatched:
 *
 * - 'adv.nuke': { keywords: Array<string> }
 *   Fired when the user clicks the Nuke button. Contains the
 *   keywords collected from the input and selected tags.
 *
 * - 'adv.rename': { start: number }
 *   Fired when the user clicks the Rename button. Contains the
 *   starting number for renaming.
 *
 * - 'adv.convert': { format: string }
 *   Fired when the user clicks the Convert button. Contains the
 *   target format ('webp','jpg','png').
 *
 * @param {HTMLElement} root
 */
export function mountAdvanced(root) {
  if (!root) return;
  // Build the markup
  root.classList.add('adv-root');
  root.innerHTML = `
    <div class="adv-section">
      <h3 class="adv-heading">Overlay Keywords</h3>
      <input type="text" id="adv-keywords" placeholder="e.g. overlay, cover" />
      <div id="adv-tags" class="adv-tags"></div>
      <button id="adv-nuke" class="adv-btn">Nuke overlays</button>
    </div>
    <div class="adv-section">
      <h3 class="adv-heading">Rename</h3>
      <input type="number" id="adv-rename-start" min="1" value="1" class="adv-input" />
      <button id="adv-rename" class="adv-btn">Rename sequential</button>
    </div>
    <div class="adv-section">
      <h3 class="adv-heading">Convert</h3>
      <button id="adv-convert" class="adv-btn">Convert (WEBP/JPG/PNG)</button>
    </div>
  `;
  // Populate tag suggestions
  const tagsEl = root.querySelector('#adv-tags');
  const inputEl = root.querySelector('#adv-keywords');
  DEFAULT_OVERLAY_KEYWORDS.forEach((kw) => {
    const tag = document.createElement('button');
    tag.type = 'button';
    tag.className = 'adv-tag';
    tag.textContent = kw;
    tag.dataset.keyword = kw;
    tag.addEventListener('click', () => {
      // Toggle selected state
      tag.classList.toggle('selected');
      updateKeywordInput();
    });
    tagsEl.appendChild(tag);
  });
  // Update the input field when tags are toggled
  function updateKeywordInput() {
    const selected = Array.from(tagsEl.querySelectorAll('.adv-tag.selected')).map((t) => t.dataset.keyword);
    const manual = inputEl.value
      .split(/[,\s]+/)
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s);
    // Remove duplicates while preserving manual order
    const set = new Set([...manual, ...selected]);
    inputEl.value = Array.from(set).join(', ');
  }
  // Nuke button handler
  root.querySelector('#adv-nuke').addEventListener('click', () => {
    const kws = inputEl.value
      .split(/[,\s]+/)
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s);
    const event = new CustomEvent('adv.nuke', { detail: { keywords: kws } });
    root.dispatchEvent(event);
  });
  // Rename button handler
  root.querySelector('#adv-rename').addEventListener('click', () => {
    const start = parseInt(root.querySelector('#adv-rename-start').value, 10);
    const event = new CustomEvent('adv.rename', { detail: { start: Number.isFinite(start) && start > 0 ? start : 1 } });
    root.dispatchEvent(event);
  });
  // Convert button handler
  root.querySelector('#adv-convert').addEventListener('click', () => {
    const format = prompt('Convert to (webp, jpg, png):', 'webp');
    if (!format) return;
    const fmt = format.trim().toLowerCase();
    if (!['webp','jpg','png','jpeg'].includes(fmt)) {
      alert('Invalid format. Please enter webp, jpg or png.');
      return;
    }
    const finalFmt = fmt === 'jpeg' ? 'jpg' : fmt;
    const event = new CustomEvent('adv.convert', { detail: { format: finalFmt } });
    root.dispatchEvent(event);
  });
}