// Auto selection helpers for Unshackle
//
// These functions operate on the list of items currently displayed in
// the grid. They return a new Set containing the urls of selected
// items. Selection is based on order, file type or inversion.

import { extOf } from './filtering.js';

/**
 * Select all items.
 * @param {Array<{url:string}>} items
 * @returns {Set<string>}
 */
export function selectAll(items) {
  const s = new Set();
  items.forEach((it) => it.url && s.add(it.url));
  return s;
}

/**
 * Select the top N items in the current view.
 * @param {Array<{url:string}>} items
 * @param {number} n
 * @returns {Set<string>}
 */
export function selectTopN(items, n) {
  const s = new Set();
  const limit = Math.min(n || 0, items.length);
  for (let i = 0; i < limit; i++) {
    const it = items[i];
    if (it && it.url) s.add(it.url);
  }
  return s;
}

/**
 * Select only items matching the given file extensions. Extensions
 * should be lower-case and not include dots (e.g. ['jpg','png']).
 * @param {Array<{url:string}>} items
 * @param {Array<string>} types
 * @returns {Set<string>}
 */
export function selectByType(items, types) {
  const typeSet = new Set((types || []).map((t) => t.toLowerCase()));
  const s = new Set();
  items.forEach((it) => {
    const ext = extOf(it.url);
    if (typeSet.has(ext)) s.add(it.url);
  });
  return s;
}

/**
 * Invert the selection for the given list. Returns a new Set of urls
 * that were not previously selected. Useful for quickly selecting
 * unselected images.
 *
 * @param {Array<{url:string}>} items
 * @param {Set<string>} selected
 * @returns {Set<string>}
 */
export function invertSelection(items, selected) {
  const s = new Set();
  items.forEach((it) => {
    if (!selected.has(it.url)) s.add(it.url);
  });
  return s;
}