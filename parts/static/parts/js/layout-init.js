(function () {
  'use strict';

  var MOBILE_BREAKPOINT = 991.98;
  var UI_MODE_KEY = 'ui_mode';
  var THEME_KEY = 'ui_theme_preference';

  function getIsMobile() {
    try {
      if (window.matchMedia) {
        return window.matchMedia('(max-width: ' + MOBILE_BREAKPOINT + 'px)').matches;
      }
      var viewport = window.visualViewport ? window.visualViewport.width : null;
      var width = viewport || Math.max(document.documentElement.clientWidth || 0, window.innerWidth || 0);
      return width < (MOBILE_BREAKPOINT + 0.02);
    } catch (_err) {
      return false;
    }
  }

  function applyViewportClass(isMobile) {
    try {
      var root = document.documentElement;
      if (!root) return;
      root.classList.toggle('force-mobile', !!isMobile);
      root.classList.toggle('force-desktop', !isMobile);
    } catch (_err) { /* no-op */ }
  }

  function persistUIMode(isMobile) {
    try {
      sessionStorage.setItem(UI_MODE_KEY, isMobile ? 'mobile' : 'desktop');
    } catch (_err) { /* ignore */ }
  }

  function loadPersistedMode() {
    try {
      return sessionStorage.getItem(UI_MODE_KEY);
    } catch (_err) {
      return null;
    }
  }

  function initViewportFlags() {
    var stored = loadPersistedMode();
    var isMobile = stored ? stored === 'mobile' : getIsMobile();
    applyViewportClass(isMobile);
    persistUIMode(isMobile);
    window.addEventListener('resize', throttle(function () {
      var viewMobile = getIsMobile();
      applyViewportClass(viewMobile);
      persistUIMode(viewMobile);
    }, 100));
  }

  function readThemePreference() {
    try {
      var stored = localStorage.getItem(THEME_KEY);
      if (stored === 'light' || stored === 'dark') {
        return stored;
      }
    } catch (_err) { /* ignore */ }
    try {
      return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light';
    } catch (_err2) {
      return 'light';
    }
  }

  function applyTheme(theme) {
    try {
      document.documentElement.setAttribute('data-theme', theme);
    } catch (_err) { /* no-op */ }
  }

  function initTheme() {
    var current = readThemePreference();
    applyTheme(current);
  }

  function throttle(fn, wait) {
    var last = 0;
    var timeout;
    return function () {
      var now = Date.now();
      var remaining = wait - (now - last);
      var args = arguments;
      if (remaining <= 0) {
        clearTimeout(timeout);
        timeout = null;
        last = now;
        fn.apply(null, args);
      } else if (!timeout) {
        timeout = setTimeout(function () {
          last = Date.now();
          timeout = null;
          fn.apply(null, args);
        }, remaining);
      }
    };
  }

  window.__persistUIMode = function () {
    persistUIMode(getIsMobile());
  };

  document.addEventListener('DOMContentLoaded', function () {
    initViewportFlags();
    initTheme();
  });

  // Run asap for initial paint
  initViewportFlags();
  initTheme();
})();
