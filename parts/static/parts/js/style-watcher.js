/**
 * style-watcher.js
 * 
 * Observa la carga de stylesheets y oculta el overlay de loading
 * cuando todos los estilos críticos están listos.
 * 
 * IMPORTANTE: Este archivo reemplaza un script inline para
 * compatibilidad con CSP + Turbo SPA navigation.
 * 
 * @see Calidad/PRACTICAS_DESARROLLO.txt - Sección CSP + Turbo
 */
(function() {
  'use strict';
  
  const overlay = document.getElementById('app-loading-overlay');
  if (!overlay) return;
  
  const statusText = document.getElementById('app-loading-message');
  const logBoot = window.__logBoot || function() {};
  const pending = new Set();
  let hideTimeout = null;
  let hasHidden = false;
  const FALLBACK_NOTICE_MS = 5000;
  const FAILSAFE_NOTICE_MS = 15000;

  // Mostrar mensaje de espera si tarda mucho
  setTimeout(() => {
    if (!hasHidden && pending.size) {
      overlay.classList.add('app-loading-overlay--waiting');
      if (statusText) {
        statusText.textContent = 'Sincronizando estilos locales…';
      }
      logBoot('stylewatch:waiting-for-assets', { pending: pending.size });
    }
  }, FALLBACK_NOTICE_MS);

  // Failsafe si tarda demasiado
  setTimeout(() => {
    if (!hasHidden && pending.size) {
      logBoot('stylewatch:failsafe-hold', { pending: pending.size });
      if (statusText) {
        statusText.textContent = 'Validando archivos…';
      }
    }
  }, FAILSAFE_NOTICE_MS);
  
  // Observar cada stylesheet con data-style-watch
  document.querySelectorAll('link[data-style-watch]').forEach((link) => {
    if (link.sheet && link.sheet.cssRules && link.sheet.cssRules.length) {
      logBoot('stylewatch:preloaded', { href: link.href });
      return;
    }
    pending.add(link);
    logBoot('stylewatch:pending', { href: link.href });
    const mark = () => {
      pending.delete(link);
      logBoot('stylewatch:loaded', { href: link.href, remaining: pending.size });
      if (!pending.size) {
        hide();
      }
    };
    link.addEventListener('load', mark, { once: true });
    link.addEventListener('error', mark, { once: true });
  });

  function stylesApplied() {
    try {
      return Array.from(document.styleSheets || []).some((sheet) => {
        try {
          return (sheet.cssRules && sheet.cssRules.length > 0);
        } catch (err) {
          return false;
        }
      });
    } catch (_err) {
      return false;
    }
  }

  function hide() {
    if (!overlay || hasHidden) return;
    if (pending.size && !stylesApplied()) {
      logBoot('stylewatch:defer-hide', { pending: pending.size });
      return;
    }
    hasHidden = true;
    logBoot('overlay:hide', { remaining: pending.size });
    overlay.classList.add('is-hidden');
    if (hideTimeout) clearTimeout(hideTimeout);
    hideTimeout = setTimeout(() => {
      overlay.remove();
      logBoot('overlay:removed', { ts: Date.now() });
      document.dispatchEvent(new CustomEvent('page:ready', {
        detail: { timestamp: Date.now(), reason: 'styles-loaded' }
      }));
      document.documentElement.classList.remove('app-loading');
      if (window.__setAppLoadingProgress) {
        window.__setAppLoadingProgress(100);
      }
    }, 600);
  }

  if (!pending.size) {
    logBoot('stylewatch:ready', { pending: 0 });
    hide();
  } else {
    logBoot('stylewatch:awaiting', { pending: pending.size });
    
    window.addEventListener('load', () => {
      if (window.__setAppLoadingProgress) {
        window.__setAppLoadingProgress(60);
      }
      logBoot('window:load-fired', { pending: pending.size });
      hide();
    }, { once: true });
  }
})();
