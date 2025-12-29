(function () {
  'use strict';

  var APP_FRAME_ID = 'app-frame';
  var scrollStoragePrefix = 'parts:scroll:';
  var printerConfigInitialized = false;
  var printerTestInitialized = false;
  var managedStyleHrefs = new Set();
  var loadedPageScripts = new Set();
  var FRAME_STYLE_SELECTOR = 'link[rel~="stylesheet"][href]';
  var PAGE_SCRIPT_SELECTOR = 'script[data-page-script]';
  var documentNonceCache = null;

  function normalizeAssetUrl(url) {
    if (!url) return '';
    try {
      return new URL(url, document.baseURI || window.location.href).href;
    } catch (_err) {
      return url;
    }
  }

  function getDocumentNonce() {
    if (documentNonceCache !== null) {
      return documentNonceCache;
    }
    var meta = document.querySelector('meta[name="csp-nonce"]');
    documentNonceCache = meta ? meta.getAttribute('content') || '' : '';
    return documentNonceCache;
  }

  function applyNonce(node) {
    if (!node) return;
    var nonce = getDocumentNonce();
    if (!nonce) return;
    try {
      node.setAttribute('nonce', nonce);
      node.nonce = nonce;
    } catch (_err) { /* ignore */ }
  }

  function rememberExistingAssets() {
    var headLinks = document.head ? document.head.querySelectorAll(FRAME_STYLE_SELECTOR) : [];
    headLinks.forEach(function (link) {
      var href = link.getAttribute('href');
      if (!href) return;
      managedStyleHrefs.add(normalizeAssetUrl(href));
    });
    var pageScripts = document.querySelectorAll(PAGE_SCRIPT_SELECTOR + '[src]');
    pageScripts.forEach(function (script) {
      var src = script.getAttribute('src');
      if (!src) return;
      loadedPageScripts.add(normalizeAssetUrl(src));
    });
  }

  rememberExistingAssets();

  function copyAttributes(target, source, skipNames) {
    if (!target || !source) return;
    var skip = Array.isArray(skipNames) ? skipNames : [];
    Array.prototype.slice.call(source.attributes).forEach(function (attr) {
      if (skip.indexOf(attr.name) !== -1) {
        return;
      }
      target.setAttribute(attr.name, attr.value);
    });
  }

  function adoptHeadStyles(doc) {
    if (!doc || !doc.head) return;
    var links = doc.head.querySelectorAll(FRAME_STYLE_SELECTOR);
    links.forEach(function (link) {
      var href = link.getAttribute('href');
      if (!href) return;
      var normalized = normalizeAssetUrl(href);
      if (!normalized || managedStyleHrefs.has(normalized)) {
        return;
      }
      var clone = document.createElement('link');
      clone.setAttribute('rel', link.getAttribute('rel') || 'stylesheet');
      clone.setAttribute('href', href);
      copyAttributes(clone, link, ['rel', 'href']);
      applyNonce(clone);
      document.head.appendChild(clone);
      managedStyleHrefs.add(normalized);
      bootLog('stylewatch:adopted', { href: href });
    });
  }

  function adoptPageScripts(doc) {
    if (!doc) return;
    var scripts = doc.querySelectorAll(PAGE_SCRIPT_SELECTOR + '[src]');
    scripts.forEach(function (script) {
      var src = script.getAttribute('src');
      if (!src) return;
      var normalized = normalizeAssetUrl(src);
      if (!normalized || loadedPageScripts.has(normalized)) {
        return;
      }
      var newScript = document.createElement('script');
      copyAttributes(newScript, script, []);
      newScript.removeAttribute('defer');
      newScript.setAttribute('src', src);
      newScript.setAttribute('data-page-script', script.getAttribute('data-page-script') || 'true');
      applyNonce(newScript);
      (document.body || document.documentElement || document.head).appendChild(newScript);
      loadedPageScripts.add(normalized);
      bootLog('pagescript:loaded', { src: src });
    });
  }

  function rewriteStyleNonces(doc) {
    if (!doc) return;
    var nonce = getDocumentNonce();
    if (!nonce) return;
    var styles = doc.querySelectorAll('style');
    styles.forEach(function (styleEl) {
      styleEl.setAttribute('nonce', nonce);
      styleEl.nonce = nonce;
    });
  }

  function getStoredPrinterConfig() {
    var method = 'usb';
    var ip = '';
    try {
      method = localStorage.getItem('printerMethod') || 'usb';
    } catch (_err) { /* ignore */ }
    try {
      ip = localStorage.getItem('printerIP') || '';
    } catch (_err2) { /* ignore */ }
    return { method: method, ip: ip };
  }

  function setElementVisibility(el, show) {
    if (!el) return;
    if (el.classList) {
      el.classList.toggle('d-none', !show);
    } else {
      el.style.display = show ? '' : 'none';
    }
  }

  function getCsrfToken() {
    try {
      var meta = document.querySelector('meta[name="csrf-token"]');
      if (meta && meta.content && meta.content !== 'NOTPROVIDED') {
        return meta.content;
      }
    } catch (_err) { /* ignore */ }
    var name = 'csrftoken';
    if (document.cookie) {
      var cookies = document.cookie.split(';');
      for (var i = 0; i < cookies.length; i += 1) {
        var cookie = cookies[i].trim();
        if (cookie.substring(0, name.length + 1) === (name + '=')) {
          return decodeURIComponent(cookie.substring(name.length + 1));
        }
      }
    }
    return '';
  }

  try {
    if (typeof window !== 'undefined' && !window.getCsrfToken) {
      window.getCsrfToken = getCsrfToken;
    }
  } catch (_err) { /* ignore */ }

  function on(eventName, handler, options) {
    document.addEventListener(eventName, handler, options || false);
  }

  var bootLog = (typeof window !== 'undefined' && window.__logBoot) ? window.__logBoot : function () {};

  function ensureStyleWatchers(root) {
    if (!root || !root.querySelectorAll) {
      return;
    }
    var links = root.querySelectorAll('link[data-style-watch]');
    if (!links.length) {
      return;
    }
    links.forEach(function (link) {
      var href = link.getAttribute('href');
      if (!href) {
        return;
      }
      var selector = 'link[data-style-watch][href="' + href + '"]';
      if (document.head.querySelector(selector)) {
        return;
      }
      var clone = link.cloneNode(true);
      document.head.appendChild(clone);
      bootLog('stylewatch:adopted', { href: href });
    });
  }

  document.addEventListener('turbo:before-render', function (event) {
    if (event && event.detail && event.detail.newBody) {
      var doc = event.detail.newBody.ownerDocument;
      rewriteStyleNonces(doc);
      ensureStyleWatchers(event.detail.newBody);
    }
  });

  document.addEventListener('turbo:before-frame-render', function (event) {
    if (event && event.detail && event.detail.newFrame) {
      rewriteStyleNonces(event.detail.newFrame.ownerDocument);
      ensureStyleWatchers(event.detail.newFrame);
    }
  });

  document.addEventListener('turbo:frame-load', function (event) {
    if (event && event.target) {
      ensureStyleWatchers(event.target);
    }
  }, true);

  function hydrateDocumentAssets(doc) {
    if (!doc) return;
    if (doc.__appAssetsHydrated) return;
    doc.__appAssetsHydrated = true;
    rewriteStyleNonces(doc);
    adoptHeadStyles(doc);
    adoptPageScripts(doc);
  }

  function hydrateFromResponse(fetchResponse) {
    if (!fetchResponse || fetchResponse.__appAssetsHydrated) {
      return;
    }
    fetchResponse.__appAssetsHydrated = true;
    if (!fetchResponse.responseHTML) {
      return;
    }
    fetchResponse.responseHTML.then(function (html) {
      if (!html) return;
      var doc = new DOMParser().parseFromString(html, 'text/html');
      hydrateDocumentAssets(doc);
    }).catch(function (err) {
      bootLog('frame-assets:error', { message: err && err.message ? err.message : String(err) });
    });
  }

  document.addEventListener('turbo:before-fetch-response', function (event) {
    var target = event && event.detail && event.detail.target;
    if (!target || target.id !== APP_FRAME_ID) {
      return;
    }
    hydrateFromResponse(event.detail.fetchResponse);
  }, true);

  document.addEventListener('turbo:before-frame-render', function (event) {
    if (!event || !event.target || event.target.id !== APP_FRAME_ID) {
      return;
    }
    var newFrame = event.detail && event.detail.newFrame;
    if (!newFrame) {
      return;
    }
    hydrateDocumentAssets(newFrame.ownerDocument);
  });

  function dispatchPageReady() {
    try {
      document.dispatchEvent(new Event('page:ready'));
    } catch (_err) {
      /* noop */
    }
  }

  function initPageReadyBridge() {
    document.addEventListener('turbo:load', dispatchPageReady);
    document.addEventListener('turbo:frame-load', dispatchPageReady);
    window.addEventListener('load', dispatchPageReady);
  }

  function initNavbarToggler() {
    document.addEventListener('click', function (ev) {
      var btn = ev.target.closest('.navbar-toggler');
      if (!btn) return;
      var targetSelector = btn.getAttribute('data-bs-target');
      if (!targetSelector || typeof bootstrap === 'undefined' || !bootstrap.Collapse) return;
      var target = document.querySelector(targetSelector);
      if (!target) return;
      var instance = bootstrap.Collapse.getOrCreateInstance(target, { toggle: false });
      instance.toggle();
      var expanded = btn.getAttribute('aria-expanded') === 'true';
      btn.setAttribute('aria-expanded', expanded ? 'false' : 'true');
    });
  }

  function initNavbarAutoCollapse() {
    document.addEventListener('click', function (ev) {
      var link = ev.target.closest('.navbar-nav .nav-link, .navbar-nav .dropdown-item');
      if (!link) return;
      if (link.matches('.dropdown-toggle') || link.dataset.bsToggle === 'dropdown') return;
      var nav = document.getElementById('navbarMain');
      if (!nav || !nav.classList.contains('show') || typeof bootstrap === 'undefined' || !bootstrap.Collapse) return;
      var instance = bootstrap.Collapse.getOrCreateInstance(nav, { toggle: false });
      instance.hide();
      var toggler = document.querySelector('.navbar-toggler');
      if (toggler) toggler.setAttribute('aria-expanded', 'false');
    }, true);
  }

  function initMobileMoreToggle() {
    var trigger = document.getElementById('moreDropdown');
    var panel = document.getElementById('mobile-more-panel');
    var backdrop = document.getElementById('mobile-more-backdrop');
    if (!trigger || !panel || trigger.__mobileMoreInit) return;
    trigger.__mobileMoreInit = true;

    var mq = window.matchMedia ? window.matchMedia('(max-width: 991.98px)') : null;

    function isMobile() {
      return mq ? mq.matches : window.innerWidth < 992;
    }

    function isPanelOpen() {
      return document.body.classList.contains('mobile-more-active');
    }

    function closePanel() {
      document.body.classList.remove('mobile-more-active');
      trigger.setAttribute('aria-expanded', 'false');
      panel.scrollTop = 0;
    }

    function openPanel() {
      document.body.classList.add('mobile-more-active');
      trigger.setAttribute('aria-expanded', 'true');
      panel.scrollTop = 0;
    }

    function togglePanel() {
      if (isPanelOpen()) {
        closePanel();
      } else {
        openPanel();
      }
    }

    // Remover data-bs-toggle para evitar que Bootstrap interfiera en móvil
    function disableBootstrapDropdown() {
      if (isMobile()) {
        trigger.removeAttribute('data-bs-toggle');
      } else {
        trigger.setAttribute('data-bs-toggle', 'dropdown');
      }
    }

    // Ejecutar al inicio
    disableBootstrapDropdown();

    // En móvil, manejar click manualmente
    trigger.addEventListener('click', function (e) {
      if (!isMobile()) return;
      e.preventDefault();
      e.stopPropagation();
      togglePanel();
    });

    // Click fuera cierra el panel
    document.addEventListener('click', function (ev) {
      if (!isPanelOpen()) return;
      if (!isMobile()) return;
      if (trigger.contains(ev.target) || panel.contains(ev.target)) return;
      closePanel();
    });

    // Backdrop cierra el panel
    if (backdrop) {
      backdrop.addEventListener('click', closePanel);
    }

    // Escape cierra el panel
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && isPanelOpen() && isMobile()) {
        closePanel();
      }
    });

    // Resize: cambiar modo y cerrar si es necesario
    window.addEventListener('resize', function () {
      disableBootstrapDropdown();
      if (!isMobile() && isPanelOpen()) {
        closePanel();
      }
    });

    // Al colapsar navbar, cerrar panel
    var navbarMain = document.getElementById('navbarMain');
    if (navbarMain) {
      navbarMain.addEventListener('hidden.bs.collapse', closePanel);
    }

    // Turbo navigation cierra el panel
    document.addEventListener('turbo:before-visit', closePanel);
    document.addEventListener('turbo:load', closePanel);

    // Exponer funciones globalmente para el back button
    window.__closeMobileMorePanel = closePanel;
    window.__isMobileMorePanelOpen = isPanelOpen;
  }

  function persistCollapse(panel, key, mobileDefault) {
    var stored;
    try {
      stored = sessionStorage.getItem(key);
    } catch (_err) {
      stored = null;
    }

    var isMobile = window.matchMedia ? window.matchMedia('(max-width: 991.98px)').matches : false;
    var instance = (typeof bootstrap === 'undefined' || !bootstrap.Collapse)
      ? null
      : bootstrap.Collapse.getOrCreateInstance(panel, { toggle: false });

    function syncButtons(open) {
      var buttons = document.querySelectorAll('[data-bs-target="#' + panel.id + '"]');
      buttons.forEach(function (btn) {
        btn.classList.toggle('collapsed', !open);
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
    }

    function setState(open) {
      if (open) {
        panel.classList.add('show');
        if (instance) instance.show();
        syncButtons(true);
      } else {
        panel.classList.remove('show');
        if (instance) instance.hide();
        syncButtons(false);
      }
    }

    if (stored === null && mobileDefault === 'closed' && isMobile) {
      setState(false);
    } else if (stored === 'open') {
      setState(true);
    } else if (stored === 'closed') {
      setState(false);
    }

    panel.addEventListener('shown.bs.collapse', function () {
      try { sessionStorage.setItem(key, 'open'); } catch (_err) { /* ignore */ }
      syncButtons(true);
    });
    panel.addEventListener('hidden.bs.collapse', function () {
      try { sessionStorage.setItem(key, 'closed'); } catch (_err) { /* ignore */ }
      syncButtons(false);
    });
  }

  function initCollapsePersistence() {
    document.querySelectorAll('.collapse[data-persist-key]').forEach(function (panel) {
      if (panel.__persistInit) return;
      panel.__persistInit = true;
      var key = panel.dataset.persistKey;
      var mobileDefault = panel.dataset.mobileDefault || 'open';
      if (key) {
        persistCollapse(panel, key, mobileDefault);
      }
    });
  }

  function getScrollStorage() {
    try {
      return window.sessionStorage;
    } catch (_err) {
      return null;
    }
  }

  function initScrollPersistence() {
    var storage = getScrollStorage();
    if (!storage) return;
    var timer = null;

    function key() {
      return scrollStoragePrefix + (window.location.pathname + window.location.search);
    }

    function saveScroll() {
      try {
        storage.setItem(key(), String(Math.round(window.scrollY || window.pageYOffset || 0)));
      } catch (_err) { /* ignore */ }
    }

    function throttled() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(saveScroll, 140);
    }

    function restore() {
      var stored = storage.getItem(key());
      if (!stored) return;
      var offset = parseInt(stored, 10);
      if (Number.isNaN(offset)) return;
      var attempts = 0;
      (function attempt() {
        window.scrollTo(0, offset);
        attempts += 1;
        if (attempts < 3) requestAnimationFrame(attempt);
      })();
    }

    window.addEventListener('scroll', throttled, { passive: true });
    window.addEventListener('beforeunload', saveScroll, { capture: true });
    window.addEventListener('pagehide', saveScroll);
    window.addEventListener('pageshow', restore);
    document.addEventListener('turbo:before-visit', saveScroll);
    document.addEventListener('turbo:before-cache', saveScroll);
    document.addEventListener('turbo:load', restore);
    document.addEventListener('turbo:frame-load', function (ev) {
      if (ev.target && ev.target.id === APP_FRAME_ID) {
        restore();
      }
    });
    if (document.readyState !== 'loading') restore();
  }

  function initHubButton() {
    document.querySelectorAll('#printer-open-hub').forEach(function (btn) {
      if (btn.__hubInit) return;
      btn.__hubInit = true;
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        try {
          localStorage.setItem('printerMethod', 'bluetooth');
        } catch (_err) { /* ignore */ }
        initPrinterIndicator('bluetooth');
        var hub = window.open('/parts/impresora/hub/', 'hub_impresora_bt', 'width=480,height=420');
        if (!hub) {
          alert('No se pudo abrir la ventana del hub. Deshabilita bloqueadores de ventanas emergentes.');
        }
      });
    });
  }

  function normalizeAppFramePath(target) {
    if (!target) return null;
    try {
      var urlObj = new URL(target, window.location.origin);
      var path = urlObj.pathname + urlObj.search + urlObj.hash;
      if (path.indexOf('/parts/') !== 0) return null;
      return path;
    } catch (_err) {
      return null;
    }
  }

  function visitAppFrame(targetPath, action) {
    var normalized = normalizeAppFramePath(targetPath);
    if (!normalized) return null;
    var frame = document.getElementById(APP_FRAME_ID);
    if (!frame) return null;
    window.__persistUIMode();
    var turbo = window.Turbo;
    if (turbo && typeof turbo.visit === 'function') {
      try {
        turbo.visit(normalized, { frame: APP_FRAME_ID, action: action || 'advance' });
      } catch (err) {
        console.warn('Turbo.visit falló, usando setAttribute', err);
        frame.setAttribute('src', normalized);
      }
    } else {
      frame.setAttribute('src', normalized);
    }
    return normalized;
  }

  function initTurboRouter() {
    document.addEventListener('click', function (e) {
      var a = e.target.closest && e.target.closest('a[href]');
      if (!a) return;
      var href = a.getAttribute('href');
      if (!href) return;
      if (href.charAt(0) === '#' || a.hasAttribute('download')) return;
      if (a.dataset && (a.dataset.bsToggle || a.dataset.bsDismiss || a.dataset.turbo === 'false')) return;
      if (a.id === 'printer-open-hub') return;
      if (a.target && a.target !== '_self') return;
      var url;
      try {
        url = new URL(href, window.location.href);
      } catch (_err) {
        return;
      }
      if (url.origin !== window.location.origin) return;
      if (a.dataset && a.dataset.turboFrame) return;
      if (url.pathname && url.pathname.indexOf('/parts/') === 0) {
        var visitedPath = visitAppFrame(url.href, 'advance');
        if (visitedPath) {
          e.preventDefault();
          try {
            history.pushState({ turboFrame: APP_FRAME_ID }, '', visitedPath);
          } catch (_err2) { /* ignore */ }
        }
      }
      window.__persistUIMode();
    }, true);

    document.addEventListener('turbo:frame-load', function (ev) {
      var frame = ev.target;
      if (!frame || frame.id !== APP_FRAME_ID) return;
      var detailUrl = ev.detail && ev.detail.url;
      var currentPath = normalizeAppFramePath(detailUrl || frame.getAttribute('src') || frame.src);
      if (!currentPath) return;
      var currentLocation = window.location.pathname + window.location.search + window.location.hash;
      if (currentLocation !== currentPath) {
        try {
          history.replaceState({ turboFrame: APP_FRAME_ID }, '', currentPath);
        } catch (_err) { /* ignore */ }
      }
    });

    window.addEventListener('popstate', function () {
      var path = window.location.pathname + window.location.search + window.location.hash;
      if (path.indexOf('/parts/') === 0) {
        visitAppFrame(path, 'replace');
      }
    });

    document.addEventListener('submit', function (e) {
      var form = e.target.closest && e.target.closest('form');
      if (!form) return;
      if (form.dataset && form.dataset.turbo === 'false') return;
      var action = form.getAttribute('action') || window.location.href;
      var url = new URL(action, window.location.href);
      if (url.origin !== window.location.origin || url.pathname.indexOf('/parts/') !== 0) return;
      if (!form.dataset || !form.dataset.turboFrame) {
        form.setAttribute('data-turbo-frame', APP_FRAME_ID);
      }
    }, true);
  }

  function initResponsiveResync() {
    function pingResize() {
      try { window.dispatchEvent(new Event('resize')); } catch (_err) { /* ignore */ }
    }
    function setResponsiveMode() {
      var isMobile = window.matchMedia
        ? window.matchMedia('(max-width: 991.98px)').matches
        : (Math.max(document.documentElement.clientWidth || 0, window.innerWidth || 0) < 992);
      var root = document.documentElement;
      if (!root) return;
      root.classList.toggle('force-mobile', isMobile);
      root.classList.toggle('force-desktop', !isMobile);
    }
    function forceRecalc() {
      setResponsiveMode();
      pingResize();
      setTimeout(pingResize, 25);
      setTimeout(pingResize, 100);
    }
    document.addEventListener('page:ready', forceRecalc);
    window.addEventListener('load', forceRecalc);
    window.addEventListener('pageshow', forceRecalc);
    window.addEventListener('orientationchange', forceRecalc);
    var timeout;
    window.addEventListener('resize', function () {
      clearTimeout(timeout);
      timeout = setTimeout(setResponsiveMode, 60);
    });
  }

  function initToastHelper() {
    window.showToast = function showToast(opts) {
      var options = Object.assign({
        title: 'Aviso',
        body: '',
        variant: 'primary',
        delay: 3000
      }, opts || {});
      var container = document.getElementById('toast-container');
      if (!container || typeof bootstrap === 'undefined' || !bootstrap.Toast) return;
      var toastEl = document.createElement('div');
      toastEl.className = 'toast align-items-center border-0 shadow';
      toastEl.setAttribute('role', 'alert');
      toastEl.setAttribute('aria-live', 'assertive');
      toastEl.setAttribute('aria-atomic', 'true');
      var headerClass = options.variant === 'danger' ? 'bg-danger text-white' :
        options.variant === 'success' ? 'bg-success text-white' :
          options.variant === 'warning' ? 'bg-warning' : 'bg-primary text-white';
      toastEl.innerHTML = '<div class="toast-header ' + headerClass + '">' +
        '<strong class="me-auto">' + options.title + '</strong>' +
        '<button type="button" class="btn-close btn-close-white" data-bs-dismiss="toast" aria-label="Close"></button>' +
        '</div>' +
        '<div class="toast-body">' + options.body + '</div>';
      container.appendChild(toastEl);
      var toast = new bootstrap.Toast(toastEl, { delay: options.delay });
      toast.show();
      toastEl.addEventListener('hidden.bs.toast', function () {
        toastEl.remove();
      });
    };
  }

  function initNavbarPreferences() {
    var aiTile = document.getElementById('ai-model-toggle');
    var beepTile = document.getElementById('beep-toggle');

    if (aiTile && !aiTile.__init) {
      aiTile.__init = true;
      var useCloud = (localStorage.getItem('useCloud') || 'false') === 'true';
      var applyState = function () {
        aiTile.classList.toggle('active', useCloud);
        aiTile.setAttribute('aria-pressed', useCloud ? 'true' : 'false');
        var inline = document.getElementById('ai-model-toggle-inline');
        if (inline) {
          inline.classList.toggle('active', useCloud);
          inline.setAttribute('aria-pressed', useCloud ? 'true' : 'false');
          inline.textContent = useCloud ? 'Nube' : 'Local';
        }
      };
      applyState();
      aiTile.addEventListener('click', function () {
        useCloud = !useCloud;
        localStorage.setItem('useCloud', useCloud ? 'true' : 'false');
        applyState();
        if (window.showToast) {
          window.showToast({
            title: 'Preferencia IA',
            body: useCloud ? 'Usando Nube (OpenAI)' : 'Usando Local (Ollama)',
            variant: 'success',
            delay: 2000
          });
        }
      });
      var inlineToggle = document.getElementById('ai-model-toggle-inline');
      if (inlineToggle && !inlineToggle.__init) {
        inlineToggle.__init = true;
        inlineToggle.addEventListener('click', function (e) {
          e.preventDefault();
          aiTile.click();
        });
      }
    }

    if (beepTile && !beepTile.__init) {
      beepTile.__init = true;
      var soundsOn = (localStorage.getItem('beepDisabled') || 'true') !== 'true';
      var applyBeepState = function () {
        beepTile.classList.toggle('active', soundsOn);
        beepTile.setAttribute('aria-pressed', soundsOn ? 'true' : 'false');
        var inline = document.getElementById('beep-toggle-inline');
        if (inline) {
          inline.classList.toggle('active', soundsOn);
          inline.setAttribute('aria-pressed', soundsOn ? 'true' : 'false');
          inline.textContent = soundsOn ? 'ON' : 'OFF';
        }
      };
      applyBeepState();
      var toggleBeep = function () {
        soundsOn = !soundsOn;
        localStorage.setItem('beepDisabled', soundsOn ? 'false' : 'true');
        applyBeepState();
        if (window.showToast) {
          window.showToast({
            title: 'Sonidos',
            body: soundsOn ? 'Sonidos activados' : 'Sonidos desactivados',
            variant: 'primary',
            delay: 1500
          });
        }
      };
      beepTile.addEventListener('click', toggleBeep);
      if (beepTile.addEventListener) {
        beepTile.addEventListener('keydown', function (ev) {
          if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            toggleBeep();
          }
        });
      }
      var inlineBtn = document.getElementById('beep-toggle-inline');
      if (inlineBtn && !inlineBtn.__init) {
        inlineBtn.__init = true;
        inlineBtn.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          toggleBeep();
        });
      }
    }
  }

  function printerMethodLabel(method) {
    switch (method) {
      case 'bluetooth':
        return 'Bluetooth';
      case 'hub':
        return 'Hub';
      case 'network':
        return 'Red';
      case 'usb':
        return 'USB';
      default:
        return method ? method.toUpperCase() : '--';
    }
  }

  function initPrinterIndicator(method) {
    var indicator = document.getElementById('bluetooth-status-container');
    if (indicator) {
      indicator.dataset.method = method || 'bluetooth';
    }
    var connectBtn = document.getElementById('printer-connect-btn');
    if (connectBtn) {
      var tooltip = method === 'network'
        ? 'Imprimir vía red/CUPS'
        : method === 'usb'
          ? 'Impresión a través del servidor'
          : 'Conectar directo por Bluetooth';
      connectBtn.dataset.preferredMethod = method || 'bluetooth';
      connectBtn.title = tooltip;
    }
  }

  function initPrinterConfigModal() {
    if (printerConfigInitialized) return;
    var modal = document.getElementById('printerConfigModal');
    if (!modal) return;
    printerConfigInitialized = true;

    function toggleOptions(method) {
      ['usb', 'bluetooth', 'network'].forEach(function (value) {
        setElementVisibility(document.getElementById(value + 'Options'), method === value);
      });
      var statusText = document.getElementById('printerStatusText');
      if (statusText) {
        statusText.textContent = method === 'bluetooth'
          ? 'Método actual: Bluetooth Directo'
          : method === 'network'
            ? 'Método actual: Red (CUPS/TCP)'
            : 'Método actual: USB (Servidor)';
      }
    }

    function loadConfig() {
      var config = getStoredPrinterConfig();
      var method = config.method;
      var ip = config.ip;
      var radio = document.querySelector('input[name="printerMethod"][value="' + method + '"]');
      if (radio) radio.checked = true;
      var ipInput = document.getElementById('printerIP');
      if (ipInput) ipInput.value = ip;
      initPrinterIndicator(method);
      toggleOptions(method);
    }

    document.querySelectorAll('input[name="printerMethod"]').forEach(function (radio) {
      radio.addEventListener('change', function () {
        toggleOptions(this.value);
      });
    });

    var saveBtn = document.getElementById('savePrinterConfig');
    if (saveBtn) {
      saveBtn.addEventListener('click', function () {
        var selected = document.querySelector('input[name="printerMethod"]:checked');
        var ipInput = document.getElementById('printerIP');
        var ipValue = ipInput ? ipInput.value : '';
        if (selected) {
          localStorage.setItem('printerMethod', selected.value);
          localStorage.setItem('printerIP', ipValue || '');
          initPrinterIndicator(selected.value);
          if (window.showToast) {
            window.showToast({ title: 'Impresora', body: 'Configuración guardada', variant: 'success', delay: 2000 });
          }
          if (typeof bootstrap !== 'undefined') {
            var modalInstance = bootstrap.Modal.getInstance(modal);
            if (modalInstance) modalInstance.hide();
          }
        }
      });
    }

    if (typeof bootstrap !== 'undefined' && modal.addEventListener) {
      modal.addEventListener('show.bs.modal', loadConfig);
    }
    loadConfig();
  }

  function initPrinterTestModal() {
    if (printerTestInitialized) return;
    var modalEl = document.getElementById('printerTestModal');
    var runBtn = document.getElementById('runPrinterTest');
    if (!modalEl || !runBtn) return;
    printerTestInitialized = true;
    var modal = (typeof bootstrap !== 'undefined' && bootstrap.Modal)
      ? bootstrap.Modal.getOrCreateInstance(modalEl)
      : null;
    var openBtn = document.getElementById('printer-test-btn');
    var resultBox = document.getElementById('testResult');
    var logBox = document.getElementById('testLog');
    var logContent = document.getElementById('testLogContent');
    var commandsBox = document.getElementById('testCommands');
    var commandsContent = document.getElementById('testCommandsContent');
    var testBtnLabel = document.getElementById('testBtnText');
    var testUrl = modalEl.dataset.testUrl || '/parts/impresora/test/';

    function resetModal() {
      setElementVisibility(resultBox, false);
      setElementVisibility(logBox, false);
      setElementVisibility(commandsBox, false);
      if (logContent) logContent.textContent = '';
      if (commandsContent) commandsContent.innerHTML = '';
      runBtn.disabled = false;
      if (testBtnLabel) testBtnLabel.textContent = 'Ejecutar Test';
    }

    function showResult(variant, html) {
      if (!resultBox) return;
      resultBox.className = 'alert alert-' + variant;
      resultBox.innerHTML = html;
      setElementVisibility(resultBox, true);
    }

    function showLog(text) {
      if (!logBox || !logContent) return;
      logContent.textContent = text;
      setElementVisibility(logBox, true);
    }

    function showCommands(lines) {
      if (!commandsBox || !commandsContent) return;
      if (!lines || !lines.length) {
        setElementVisibility(commandsBox, false);
        commandsContent.innerHTML = '';
        return;
      }
      commandsContent.innerHTML = lines.map(function (line) {
        return '<div class=\"mb-2\">' + line + '</div>';
      }).join('');
      setElementVisibility(commandsBox, true);
    }

    function setRunningState(isRunning) {
      runBtn.disabled = isRunning;
      if (testBtnLabel) {
        testBtnLabel.innerHTML = isRunning
          ? '<span class=\"spinner-border spinner-border-sm me-2\"></span>Probando...'
          : 'Ejecutar Test';
      }
    }

    function runServerTest(config) {
      showResult('info', '<i class=\"fas fa-server\"></i> Enviando prueba al servidor...');
      return fetch(testUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRFToken': getCsrfToken(),
          'X-Requested-With': 'XMLHttpRequest'
        },
        body: JSON.stringify({
          connection_type: config.method,
          ip_address: config.ip
        })
      })
        .then(function (resp) { return resp.json(); })
        .then(function (data) {
          if (data.success) {
            showResult('success', '<i class=\"fas fa-check-circle\"></i> ' + (data.message || 'Impresora conectada correctamente'));
          } else {
            showResult('danger', '<i class=\"fas fa-exclamation-circle\"></i> ' + (data.message || 'No se pudo ejecutar el test'));
          }
          if (data.details && data.details.diagnostico && data.details.diagnostico.length) {
            showLog(data.details.diagnostico.join('\\n'));
          } else {
            setElementVisibility(logBox, false);
          }
          if (data.details && data.details.comandos_sugeridos && data.details.comandos_sugeridos.length) {
            showCommands(data.details.comandos_sugeridos.map(function (cmd) {
              return '<code class=\"text-warning\">$</code> ' + cmd;
            }));
          } else {
            setElementVisibility(commandsBox, false);
          }
        })
        .catch(function (err) {
          showResult('danger', '<i class=\"fas fa-times-circle\"></i> Error de comunicación<br><small>' + err.message + '</small>');
          showCommands([
            'Verifica que el servicio de impresión esté en ejecución.',
            'Confirma la IP configurada en el modal de impresora.',
            'Intenta nuevamente en unos segundos.'
          ]);
        });
    }

    function runBluetoothTest() {
      return new Promise(function (resolve, reject) {
        if (!window.BluetoothPrinterClient || !navigator.bluetooth) {
          reject(new Error('Web Bluetooth no está disponible. Usa Chrome o Edge.'));
          return;
        }
        var printer = new BluetoothPrinterClient();
        showResult('info', '<i class=\"fas fa-bluetooth\"></i> Abriendo diálogo de Bluetooth...');
        printer.connect()
          .then(function () {
            showResult('warning', '<i class=\"fas fa-print\"></i> Conectado. Enviando etiqueta de prueba...');
            return printer.testPrint();
          })
          .then(function () {
            showResult('success', '<i class=\"fas fa-check-circle\"></i> ¡Prueba exitosa por Bluetooth! Revisa la impresora.');
            showLog('Conexión Bluetooth directa establecida\\nDispositivo: ' + (printer.device ? printer.device.name : 'GOOJPRT PT210') + '\\nTransporte: Web Bluetooth API');
            printer.disconnect();
            setElementVisibility(commandsBox, false);
            resolve();
          })
          .catch(function (err) {
            printer.disconnect();
            reject(err);
          });
      }).catch(function (err) {
        showResult('danger', '<i class=\"fas fa-exclamation-circle\"></i> Error de Bluetooth<br><small>' + err.message + '</small>');
        showCommands([
          'Asegúrate de usar Chrome o Edge (Android/Windows/macOS).',
          'Enciende la impresora GOOJPRT PT210 y activa el modo de emparejamiento.',
          'Mantente cerca de la impresora e intenta de nuevo.'
        ]);
        throw err;
      });
    }

    if (openBtn && modal) {
      openBtn.addEventListener('click', function (e) {
        e.preventDefault();
        resetModal();
        modal.show();
      });
    }

    if (modalEl.addEventListener) {
      modalEl.addEventListener('hidden.bs.modal', resetModal);
    }

    runBtn.addEventListener('click', function () {
      resetModal();
      setRunningState(true);
      var config = getStoredPrinterConfig();
      var runner = config.method === 'bluetooth'
        ? runBluetoothTest()
        : runServerTest(config);
      var finalize = function () { setRunningState(false); };
      if (runner && typeof runner.finally === 'function') {
        runner.finally(finalize);
      } else if (runner && typeof runner.then === 'function') {
        runner.then(finalize).catch(finalize);
      } else {
        finalize();
      }
    });
  }

  function initPrinterConnectButton() {
    var btn = document.getElementById('printer-connect-btn');
    if (!btn || btn.__init) return;
    btn.__init = true;
    var statusLabel = document.getElementById('printer-status-label');
    var methodLabel = document.getElementById('printer-active-method');
    var disconnectBtn = document.getElementById('printer-disconnect-btn');
    var hubBtn = document.getElementById('printer-open-hub');
    var isConnecting = false;

    function resolveConnectedMethod() {
      if (window.printerManager && window.printerManager._modo_host) {
        return 'hub';
      }
      return 'bluetooth';
    }

    function updateStatusUI(state) {
      var connected = state && state.connected;
      var method = state && state.method ? state.method : getStoredPrinterConfig().method || 'bluetooth';
      if (statusLabel) {
        statusLabel.textContent = connected ? 'Impresora conectada por:' : 'Conectar impresora por:';
      }
      if (methodLabel) {
        if (connected) {
          methodLabel.textContent = printerMethodLabel(method);
          methodLabel.classList.remove('d-none');
        } else {
          methodLabel.textContent = '';
          methodLabel.classList.add('d-none');
        }
      }
      if (disconnectBtn) {
        disconnectBtn.classList.toggle('d-none', !connected);
        disconnectBtn.disabled = !connected;
      }
      btn.classList.toggle('printer-connect-chip--active', !!connected && method === 'bluetooth');
      btn.dataset.connected = connected ? 'true' : 'false';
      if (hubBtn) {
        hubBtn.classList.toggle('printer-connect-chip--active', !!connected && method === 'hub');
      }
    }

    function handleStatusEvent(status) {
      if (!status) return;
      if (status.type === 'connected') {
        updateStatusUI({ connected: true, method: resolveConnectedMethod() });
      } else if (status.type === 'disconnected') {
        updateStatusUI({ connected: false });
      } else if (status.type === 'connecting' && statusLabel) {
        statusLabel.textContent = 'Conectando impresora...';
      }
    }

    updateStatusUI({ connected: window.printerManager && window.printerManager.isConnected && window.printerManager.isConnected() });

    btn.addEventListener('click', function (e) {
      e.preventDefault();
      if (isConnecting) return;
      localStorage.setItem('printerMethod', 'bluetooth');
      initPrinterIndicator('bluetooth');
      if (!window.printerManager || typeof window.printerManager.connect !== 'function') {
        if (window.showToast) {
          window.showToast({
            title: 'Impresora',
            body: 'Configura el método de impresión desde un navegador compatible.',
            variant: 'warning',
            delay: 3500
          });
        } else {
          alert('Configura el método de impresión desde un navegador compatible.');
        }
        return;
      }
      isConnecting = true;
      btn.classList.add('is-busy');
      if (statusLabel) statusLabel.textContent = 'Conectando impresora...';
      window.printerManager.connect().then(function () {
        updateStatusUI({ connected: true, method: 'bluetooth' });
        if (window.showToast) {
          window.showToast({
            title: 'Impresora',
            body: 'Conectada correctamente',
            variant: 'success',
            delay: 2500
          });
        }
      }).catch(function (err) {
        console.error('Error al conectar impresora:', err);
        updateStatusUI({ connected: false });
        if (window.showToast) {
          window.showToast({
            title: 'Error de conexión',
            body: err && err.message ? err.message : 'No se pudo conectar a la impresora',
            variant: 'danger',
            delay: 4000
          });
        }
      }).finally(function () {
        isConnecting = false;
        btn.classList.remove('is-busy');
      });
    });

    if (disconnectBtn && !disconnectBtn.__init) {
      disconnectBtn.__init = true;
      disconnectBtn.addEventListener('click', function (e) {
        e.preventDefault();
        if (!window.printerManager || typeof window.printerManager.disconnect !== 'function') {
          updateStatusUI({ connected: false });
          return;
        }
        Promise.resolve(window.printerManager.disconnect()).then(function () {
          if (window.showToast) {
            window.showToast({
              title: 'Impresora',
              body: 'Sesión Bluetooth finalizada',
              variant: 'info',
              delay: 2200
            });
          }
        }).catch(function (err) {
          console.error('Error al desconectar impresora:', err);
        }).finally(function () {
          updateStatusUI({ connected: false });
        });
      });
    }

    if (window.printerManager && typeof window.printerManager.onStatusChange === 'function') {
      window.printerManager.onStatusChange(handleStatusEvent);
      if (window.printerManager.isConnected && window.printerManager.isConnected()) {
        updateStatusUI({ connected: true, method: resolveConnectedMethod() });
      }
    }
  }

  function initPrinterMethodChips() {
    var chips = document.querySelectorAll('[data-printer-method-chip]');
    if (!chips.length) return;
    var applyState = function (method) {
      chips.forEach(function (chip) {
        var active = chip.dataset.printerMethodChip === method;
        chip.classList.toggle('active', active);
        chip.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
    };
    var current = getStoredPrinterConfig().method;
    applyState(current);
    chips.forEach(function (chip) {
      if (chip.__init) return;
      chip.__init = true;
      chip.addEventListener('click', function (e) {
        e.preventDefault();
        var method = chip.dataset.printerMethodChip;
        localStorage.setItem('printerMethod', method);
        applyState(method);
        initPrinterIndicator(method);
        if (window.showToast) {
          var variant = method === 'bluetooth' ? 'success' : method === 'network' ? 'info' : 'secondary';
          var body = method === 'bluetooth'
            ? 'Bluetooth directo seleccionado'
            : method === 'network'
              ? 'Impresión vía red activada'
              : 'Modo USB/Servidor listo';
          window.showToast({ title: 'Impresión', body: body, variant: variant, delay: 1800 });
        }
      });
    });
  }

  function initTranscriptionModeToggle() {
    var toggleBtn = document.getElementById('transcription-mode-toggle');
    var modeText = document.getElementById('transcription-mode-text');
    var modeIcon = document.getElementById('transcription-mode-icon') || document.getElementById('transcription-icon');

    var MODES = {
      local: {
        id: 'local',
        name: 'Local',
        description: 'Vosk completo (offline, rápido)',
        icon: 'fas fa-microchip',
        badgeClass: 'bg-info',
        tooltip: 'Modo Local: Todo procesado con Vosk (offline)'
      },
      hybrid: {
        id: 'hybrid',
        name: 'Nube',
        description: 'Vosk + OpenAI (comandos + transcripción precisa)',
        icon: 'fas fa-cloud',
        badgeClass: 'bg-success',
        tooltip: 'Modo Nube: Vosk para comandos, OpenAI para transcripciones'
      }
    };

    function getCurrentMode() {
      try {
        var stored = localStorage.getItem('transcriptionMode');
        return stored === 'hybrid' ? MODES.hybrid : MODES.local;
      } catch (_err) {
        return MODES.local;
      }
    }

    window.getTranscriptionMode = function () { return getCurrentMode().id; };
    window.isHybridMode = function () { return getCurrentMode().id === 'hybrid'; };

    if (!toggleBtn || !modeText || !modeIcon) {
      return;
    }

    function saveMode(mode) {
      try {
        localStorage.setItem('transcriptionMode', mode.id);
      } catch (_err) { /* ignore */ }
    }

    function updateUI(mode) {
      modeText.textContent = mode.name;
      modeIcon.className = mode.icon + ' nav-pref-pill-icon';
      toggleBtn.setAttribute('aria-pressed', mode.id === 'hybrid' ? 'true' : 'false');
      toggleBtn.classList.toggle('is-cloud', mode.id === 'hybrid');
      toggleBtn.classList.toggle('is-local', mode.id === 'local');
      toggleBtn.title = mode.tooltip;
      window.dispatchEvent(new CustomEvent('transcriptionModeChanged', { detail: { mode: mode.id } }));
    }

    function toggleMode() {
      var newMode = getCurrentMode().id === 'local' ? MODES.hybrid : MODES.local;
      saveMode(newMode);
      updateUI(newMode);
      if (window.showToast) {
        window.showToast({
          title: 'Modo: ' + newMode.name,
          body: newMode.description,
          variant: newMode.id === 'hybrid' ? 'success' : 'info',
          delay: 3000
        });
      }
    }

    toggleBtn.addEventListener('click', function (e) {
      e.preventDefault();
      toggleMode();
    });

    updateUI(getCurrentMode());
  }

  function initPageBehaviors() {
    initPrinterIndicator(getStoredPrinterConfig().method);
    initNavbarToggler();
    initNavbarAutoCollapse();
    initMobileMoreToggle();
    initCollapsePersistence();
    initScrollPersistence();
    initHubButton();
    initTurboRouter();
    initResponsiveResync();
    initToastHelper();
    initNavbarPreferences();
    initPrinterConfigModal();
    initPrinterTestModal();
    initPrinterMethodChips();
    initPrinterConnectButton();
    initTranscriptionModeToggle();
  }

  initPageReadyBridge();
  on('page:ready', initPageBehaviors);
  if (document.readyState !== 'loading') {
    dispatchPageReady();
  }
})();
