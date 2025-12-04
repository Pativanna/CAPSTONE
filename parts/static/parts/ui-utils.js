(function () {
  const THEME_KEY = 'ui_theme_preference';
  const prefersDark = () => window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;

  let themeTransitionTimer = null;

  function freezeThemeTransitions(){
    document.documentElement.classList.add('theme-switching');
    if (themeTransitionTimer){
      clearTimeout(themeTransitionTimer);
    }
    themeTransitionTimer = window.setTimeout(() => {
      document.documentElement.classList.remove('theme-switching');
    }, 250);
  }

  function applyTheme(theme, persist = true) {
    const normalized = theme === 'dark' ? 'dark' : 'light';
    freezeThemeTransitions();
    document.documentElement.setAttribute('data-theme', normalized);
    if (persist) {
      try {
        localStorage.setItem(THEME_KEY, normalized);
      } catch (_) {
        // ignore storage failures (e.g., private mode)
      }
    }
    document.dispatchEvent(new CustomEvent('theme:changed', { detail: { theme: normalized } }));
    updateThemeSwitch(normalized);
  }

  function updateThemeSwitch(theme) {
    const toggle = document.getElementById('theme-toggle');
    if (!toggle) return;
    const icon = toggle.querySelector('.tile-icon i');
    const label = toggle.querySelector('.label');
    if (theme === 'dark') {
      toggle.classList.add('active');
      if (icon) icon.className = 'bi bi-moon-stars-fill';
      if (label) label.textContent = 'Modo oscuro';
      toggle.setAttribute('aria-pressed', 'true');
    } else {
      toggle.classList.remove('active');
      if (icon) icon.className = 'bi bi-sun-fill';
      if (label) label.textContent = 'Modo claro';
      toggle.setAttribute('aria-pressed', 'false');
    }
  }

  document.addEventListener('click', function (ev) {
    const toggle = ev.target.closest('#theme-toggle');
    if (!toggle) return;
    ev.preventDefault();
    const currentAttr = document.documentElement.getAttribute('data-theme');
    const current = currentAttr === 'dark' ? 'dark' : 'light';
    const next = current === 'dark' ? 'light' : 'dark';
    applyTheme(next);
  });

  window.addEventListener('storage', function (ev) {
    if (ev.key !== THEME_KEY || !ev.newValue) return;
    applyTheme(ev.newValue);
    updateThemeSwitch(ev.newValue);
  });

  function resolveInitialTheme() {
    let stored = null;
    try {
      stored = localStorage.getItem(THEME_KEY);
    } catch (_) {
      stored = null;
    }
    return stored || (prefersDark() ? 'dark' : 'light');
  }

  const initialTheme = document.documentElement.getAttribute('data-theme') || resolveInitialTheme();
  applyTheme(initialTheme, false);

  function syncSwitch() {
    const theme = document.documentElement.getAttribute('data-theme') || resolveInitialTheme();
    updateThemeSwitch(theme);
  }

  document.addEventListener('page:ready', syncSwitch);
  document.addEventListener('DOMContentLoaded', syncSwitch);

  const currencyFormatter = new Intl.NumberFormat('es-CL', {
    style: 'currency',
    currency: 'CLP',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0
  });

  window.normalizeCLPNumber = function (value) {
    if (value === null || value === undefined || value === '') return null;
    const numeric = Number(String(value).replace(/[^0-9-]/g, ''));
    return Number.isFinite(numeric) ? numeric : null;
  };

  window.formatCLP = function (value) {
    const normalized = window.normalizeCLPNumber(value);
    if (normalized === null) return '';
    return currencyFormatter.format(normalized);
  };

  /**
   * --- MANEJO DE SESIÓN EXPIRADA ---
   * Cuando los fetch/solicitudes AJAX reciben 401/403 o son redirigidos al login,
   * redirigimos inmediatamente para evitar que la app quede en un estado inconsistente.
   */
  const LOGIN_PATH = '/login/';
  const computeNext = () => encodeURIComponent(window.location.pathname + window.location.search + window.location.hash);
  const redirectToLogin = () => {
    const next = computeNext();
    window.location.href = `${LOGIN_PATH}?next=${next}`;
  };

  async function responseIndicaSesionExpirada(response) {
    if (!response) return false;
    if (response.status === 401) return true;
    if (response.redirected && response.url && response.url.includes(LOGIN_PATH)) return true;
    if (response.status === 403) {
      try {
        const contentType = response.headers.get('Content-Type') || '';
        if (contentType.includes('application/json')) {
          const data = await response.clone().json();
          const texto = ((data && (data.error || data.detail || data.message)) || '').toString().toLowerCase();
          if (texto.includes('permiso') || texto.includes('autentic')) {
            return true;
          }
        }
      } catch (_) {
        return false;
      }
    }
    return false;
  }

  if (!window.__fetchSessionGuard) {
    window.__fetchSessionGuard = true;
    const originalFetch = window.fetch;
    window.fetch = async function wrappedFetch(...args) {
      const resp = await originalFetch.apply(this, args);
      if (await responseIndicaSesionExpirada(resp)) {
        redirectToLogin();
        throw new Error('Sesión expirada, redirigiendo a login.');
      }
      return resp;
    };

    document.addEventListener('turbo:before-fetch-response', async (event) => {
      const resp = event.detail?.fetchResponse?.response;
      if (await responseIndicaSesionExpirada(resp)) {
        event.preventDefault();
        redirectToLogin();
      }
    }, { capture: true });
  }
})();
