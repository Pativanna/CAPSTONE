(() => {
  const currentScript = document.currentScript;
  const dataset = currentScript ? currentScript.dataset : {};
  const localBootstrapCss = dataset.bootstrapCss;
  const localBootstrapJs = dataset.bootstrapJs;
  const localTurbo = dataset.turboLocal;
  const scriptNonce = currentScript ? currentScript.nonce || '' : '';

  function injectStylesheet(href, id) {
    if (!href) {
      return null;
    }
    if (id) {
      const existing = document.getElementById(id);
      if (existing) {
        return existing;
      }
    }
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    if (id) {
      link.id = id;
    }
    document.head.appendChild(link);
    return link;
  }

  function injectScript(id, src, opts = {}) {
    if (!src) {
      return null;
    }
    const existing = document.getElementById(id);
    if (existing) {
      return existing;
    }
    const script = document.createElement('script');
    script.id = id;
    script.src = src;
    script.crossOrigin = 'anonymous';
    if (scriptNonce) {
      script.nonce = scriptNonce;
    }
    if (opts.defer) {
      script.defer = true;
    }
    document.head.appendChild(script);
    return script;
  }

  function ensureBootstrapCss() {
    const cdnLink = document.getElementById('bootstrap-cdn');
    const fallback = () => injectStylesheet(localBootstrapCss, 'bootstrap-local');
    if (!cdnLink) {
      fallback();
      return;
    }
    cdnLink.addEventListener('error', fallback, { once: true });
    window.setTimeout(() => {
      try {
        const sheet = cdnLink.sheet;
        if (!sheet || !sheet.cssRules || !sheet.cssRules.length) {
          fallback();
        }
      } catch (err) {
        fallback();
      }
    }, 900);
  }

  function ensureBootstrapJs() {
    if (window.bootstrap && window.bootstrap.Alert) {
      return;
    }
    injectScript('bootstrap-local-js', localBootstrapJs, { defer: true });
  }

  function ensureTurbo() {
    if (window.Turbo) {
      return;
    }
    injectScript('turbo-local', localTurbo);
  }

  const cdnTurboScript = document.getElementById('turbo-cdn');
  if (cdnTurboScript) {
    cdnTurboScript.addEventListener('error', () => ensureTurbo(), { once: true });
  }

  window.addEventListener('load', () => {
    ensureBootstrapCss();
    window.setTimeout(() => {
      ensureBootstrapJs();
      ensureTurbo();
    }, 700);
  });
})();
