// Auto rename helper for Unshackle
//
// Provides functionality to rename a list of items sequentially. The
// items are expected to be in the current display order. The caller
// can specify a starting number, a base name, and whether to pad
// numbers with leading zeros. The extension will update the
// filename property of each item and return a mapping of old
// filename → new filename to assist with downloads.

/**
 * Rename items sequentially. Each item's filename is updated in
 * place. Returns an object containing the updated items and a
 * mapping of original filenames to new filenames. Pads numbers if
 * pad > 0.
 *
 * @param {Array<{filename:string,url:string}>} items
 * @param {Object} opts
 * @param {number} [opts.start] Starting number (default 1)
 * @param {string} [opts.base] Base name for files (default 'image')
 * @param {number} [opts.pad] Zero-padding length; 0 means no padding
 * @param {boolean} [opts.keepExt] If true, retain the original file extension (default true)
 * @returns {{ items: Array, mapping: Object }}
 */
export function renameSequential(items, opts = {}) {
  const start = typeof opts.start === 'number' && opts.start > 0 ? Math.floor(opts.start) : 1;
  const base = opts.base || 'image';
  const pad = typeof opts.pad === 'number' && opts.pad > 0 ? Math.floor(opts.pad) : 0;
  const keepExt = opts.keepExt !== false;
  const mapping = {};
  let count = 0;
  items.forEach((it) => {
    count++;
    let newNameNumber = start + count - 1;
    let numberStr = String(newNameNumber);
    if (pad > 0) {
      numberStr = numberStr.padStart(pad, '0');
    }
    let ext = '';
    if (keepExt && it.filename) {
      const idx = it.filename.lastIndexOf('.');
      if (idx >= 0) ext = it.filename.slice(idx);
    }
    const newFilename = `${base}_${numberStr}${ext}`;
    mapping[it.filename] = newFilename;
    it.filename = newFilename;
  });
  return { items, mapping };
}