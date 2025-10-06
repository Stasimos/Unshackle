// Overlay keyword suggestions for Unshackle
//
// This module exports a default list of keywords used for overlay
// removal. The panel imports these keywords to populate the tag
// suggestions in the Advanced Options drawer. Removal of overlays
// happens in the content script via the nukeOverlays and
// nukeByKeywords actions.

export const DEFAULT_OVERLAY_KEYWORDS = [
  'overlay', 'overlays', 'cover', 'wrapper', 'wrap', 'shield', 'modal',
  'popup', 'subscribe', 'paywall', 'consent', 'banner', 'veil', 'mask',
  'promo', 'ad', 'signup', 'cookie', 'gdpr', 'backdrop', 'scrim'
];