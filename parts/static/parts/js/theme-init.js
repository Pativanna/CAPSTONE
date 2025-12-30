/**
 * Early theme initialization - runs synchronously before page render
 * This prevents flash of wrong theme (FOWT) on page load/reload
 */
(function() {
  'use strict';
  var STORAGE_KEY = 'parts:theme-preference';
  var stored = null;
  
  try {
    stored = localStorage.getItem(STORAGE_KEY);
  } catch (e) { /* ignore */ }
  
  // Only apply dark theme if explicitly stored as 'dark'
  // Default to light theme for consistency
  if (stored === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
  } else if (stored === 'light') {
    document.documentElement.removeAttribute('data-theme');
  }
  // If nothing stored, leave as default (light) - don't use OS preference here
  // to avoid flash. The full theme-preferences.js will handle OS preference later.
})();
