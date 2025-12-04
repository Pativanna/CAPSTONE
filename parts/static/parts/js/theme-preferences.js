(function () {
  'use strict';

  var STORAGE_KEY = 'parts:theme-preference';
  var toggleBtn = null;
  var prefersDark = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  var manualPreference = null;

  function readStoredTheme() {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch (_err) {
      return null;
    }
  }

  function persistTheme(theme) {
    manualPreference = theme;
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch (_err) { /* ignore */ }
  }

  function resolveTheme() {
    if (manualPreference) {
      return manualPreference;
    }
    var stored = readStoredTheme();
    if (stored) {
      manualPreference = stored;
      return stored;
    }
    if (prefersDark && typeof prefersDark.matches === 'boolean') {
      return prefersDark.matches ? 'dark' : 'light';
    }
    return 'light';
  }

  function updateToggleLabel(theme) {
    if (!toggleBtn) return;
    var icon = toggleBtn.querySelector('.tile-icon i');
    var label = toggleBtn.querySelector('.label');
    var isDark = theme === 'dark';
    toggleBtn.setAttribute('aria-pressed', isDark ? 'true' : 'false');
    if (label) {
      label.textContent = isDark ? 'Modo oscuro' : 'Modo claro';
    }
    if (icon) {
      icon.classList.remove('bi-sun-fill', 'bi-moon-stars-fill');
      icon.classList.add(isDark ? 'bi-moon-stars-fill' : 'bi-sun-fill');
    }
  }

  function applyTheme(theme, options) {
    var root = document.documentElement;
    var body = document.body;
    if (!root || !body) return;
    body.classList.add('theme-switching');
    if (theme === 'dark') {
      root.setAttribute('data-theme', 'dark');
    } else {
      root.removeAttribute('data-theme');
    }
    window.setTimeout(function () {
      body.classList.remove('theme-switching');
    }, 120);
    updateToggleLabel(theme);
    if (!options || !options.skipPersist) {
      persistTheme(theme);
    }
  }

  function toggleTheme() {
    var nextTheme = resolveTheme() === 'dark' ? 'light' : 'dark';
    applyTheme(nextTheme);
  }

  function initToggleButton() {
    toggleBtn = document.getElementById('theme-toggle');
    if (!toggleBtn) return;
    toggleBtn.setAttribute('role', 'switch');
    toggleBtn.addEventListener('click', function (ev) {
      ev.preventDefault();
      toggleTheme();
    });
  }

  function handlePrefersChange(event) {
    if (manualPreference) return;
    applyTheme(event.matches ? 'dark' : 'light', { skipPersist: true });
  }

  function init() {
    initToggleButton();
    applyTheme(resolveTheme(), { skipPersist: true });
    if (prefersDark && typeof prefersDark.addEventListener === 'function') {
      prefersDark.addEventListener('change', handlePrefersChange);
    } else if (prefersDark && typeof prefersDark.addListener === 'function') {
      prefersDark.addListener(handlePrefersChange);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
