// Filtering utilities for Unshackle
//
// Provides helpers for filtering scanned items by dimension and
// extension. Supports detection of WEBP and SVG from data URIs and
// URLs. Parsing of type strings is forgiving (comma or space
// separated, case-insensitive).

/**
 * Determine the extension/type of an image based on its URL. This
 * function will return one of the supported types (png, jpg, jpeg,
 * webp, gif, svg) or an empty string if unknown.
 *
 * @param {string} url
 * @returns {string}
 */
export function extOf(url) {
  if (!url) return '';
  // Data URI detection
  if (url.startsWith('data:image/')) {
    try {
      const m = /data:image\/([a-z0-9+.-]+);/i.exec(url);
      if (m) {
        const ext = m[1].toLowerCase();
        if (ext === 'jpeg') return 'jpg';
        return ext;
      }
    } catch {}
  }
  // Otherwise parse extension from pathname
  try {
    const u = new URL(url);
    const name = u.pathname.split('/').pop() || '';
    const dot = name.lastIndexOf('.');
    if (dot >= 0) {
      let ext = name.slice(dot + 1).toLowerCase().split(/[?#]/)[0];
      if (ext === 'jpeg') ext = 'jpg';
      return ext;
    }
  } catch {}
  return '';
}

/**
 * Parse a comma- or space-separated list of extensions into a Set.
 * Allowed values include jpg, jpeg, png, gif, webp, svg. The
 * resulting Set normalizes jpeg → jpg. If the string is empty, an
 * empty Set is returned (meaning no filtering on type).
 *
 * @param {string|Array<string>} types
 * @returns {Set<string>}
 */
export function parseTypes(types) {
  if (!types) return new Set();
  if (Array.isArray(types)) {
    return new Set(types.map((t) => t.trim().toLowerCase()).filter(Boolean).map((t) => (t === 'jpeg' ? 'jpg' : t)));
  }
  return new Set(
    String(types)
      .split(/[,\s]+/)
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean)
      .map((t) => (t === 'jpeg' ? 'jpg' : t))
  );
}

/**
 * Filter an array of items by dimensions and allowed types. Each item
 * should have width, height and url properties. If no filters are
 * specified (or sets are empty), the original array is returned.
 *
 * @param {Array<{width:number,height:number,url:string}>} items
 * @param {Object} opts
 * @param {number} [opts.minW]
 * @param {number} [opts.minH]
 * @param {number} [opts.maxW]
 * @param {number} [opts.maxH]
 * @param {Set<string>} [opts.types]
 * @returns {Array}
 */
export function filterItems(items, opts = {}) {
  const minW = opts.minW || 0;
  const minH = opts.minH || 0;
  const maxW = opts.maxW || 0;
  const maxH = opts.maxH || 0;
  const types = opts.types instanceof Set ? opts.types : new Set();
  const out = [];
  for (const it of items) {
    if (!it) continue;
    const w = it.width || 0;
    const h = it.height || 0;
    if (w < minW || h < minH) continue;
    if ((maxW > 0 && w > maxW) || (maxH > 0 && h > maxH)) continue;
    if (types.size) {
      const ext = extOf(it.url);
      // For svg files, extOf can return 'svg' even if the URL
      // technically ends with .xml or has parameters. Accept either.
      const match = ext === 'svg' ? (types.has('svg') || types.has('xml')) : types.has(ext);
      if (!match) continue;
    }
    out.push(it);
  }
  return out;
}