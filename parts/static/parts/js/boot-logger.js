(function () {
  'use strict';

  var BOOTLOG_KEY = 'bootlog:verbose';
  var logBuffer = [];
  var maxEntries = 400;
  var verbose = true;

  try {
    verbose = (localStorage.getItem(BOOTLOG_KEY) || '1') === '1';
  } catch (_err) {
    verbose = true;
  }

  function emit(entry) {
    logBuffer.push(entry);
    if (logBuffer.length > maxEntries) {
      logBuffer.shift();
    }
    if (verbose && typeof console !== 'undefined' && console.debug) {
      console.debug('[BootLog]', entry.event, entry.detail || '', '⏱', new Date(entry.ts).toISOString());
    }
  }

  function logBoot(event, detail) {
    var entry = {
      ts: Date.now(),
      event: event,
      detail: detail || null,
    };
    emit(entry);
    return entry;
  }

  function handleGlobalError(ev) {
    logBoot('window:error', {
      message: ev && ev.message,
      filename: ev && ev.filename,
      lineno: ev && ev.lineno,
      colno: ev && ev.colno,
      stack: ev && ev.error && ev.error.stack ? String(ev.error.stack).slice(0, 400) : undefined,
    });
  }

  function handleRejection(ev) {
    var reason = ev && ev.reason;
    logBoot('window:unhandledrejection', {
      message: reason && reason.message ? reason.message : String(reason),
      stack: reason && reason.stack ? String(reason.stack).slice(0, 400) : undefined,
    });
  }

  window.__logBoot = logBoot;
  window.__getBootLog = function () {
    return logBuffer.slice();
  };
  window.__setBootLogVerbose = function (flag) {
    verbose = !!flag;
    try {
      localStorage.setItem(BOOTLOG_KEY, verbose ? '1' : '0');
    } catch (_err) {
      /* ignore persistence errors */
    }
    logBoot('bootlog:verbosity', { verbose: verbose });
  };

  logBoot('bootlog:init', {
    href: window.location.href,
    userAgent: navigator.userAgent,
  });

  document.addEventListener('DOMContentLoaded', function () {
    logBoot('event:domcontentloaded', { readyState: document.readyState });
  }, { once: true });

  window.addEventListener('load', function () {
    logBoot('event:windowload', { readyState: document.readyState });
  }, { once: true });

  document.addEventListener('page:ready', function (ev) {
    logBoot('event:page-ready', {
      reason: ev && ev.detail && ev.detail.reason,
      timestamp: ev && ev.detail && ev.detail.timestamp,
    });
  });

  document.addEventListener('turbo:visit', function (ev) {
    logBoot('turbo:visit', {
      url: ev && ev.detail && ev.detail.url,
      action: ev && ev.detail && ev.detail.action,
    });
  });

  document.addEventListener('turbo:load', function () {
    logBoot('turbo:load', { frame: 'root' });
  });

  document.addEventListener('turbo:frame-load', function (ev) {
    var frameId = ev && ev.target && ev.target.id;
    logBoot('turbo:frame-load', { frameId: frameId });
  });

  window.addEventListener('error', handleGlobalError);
  window.addEventListener('unhandledrejection', handleRejection);
})();
