(function(){
  'use strict';
  const ENDPOINT = '/parts/activity/log/';
  const MAX_LABEL = 120;
  const queue = [];
  let flushing = false;
  const IS_AUTHENTICATED = document.body && document.body.dataset && document.body.dataset.userAuthenticated === 'true';

  function getCsrfToken(){
    const name = 'csrftoken';
    if (document.cookie){
      const cookies = document.cookie.split(';');
      for (let i = 0; i < cookies.length; i += 1){
        const cookie = cookies[i].trim();
        if (cookie.substring(0, name.length + 1) === `${name}=`){
          const val = decodeURIComponent(cookie.substring(name.length + 1));
          if (val && val.length > 20) return val;
        }
      }
    }
    const meta = document.querySelector('meta[name=\"csrf-token\"]');
    if (meta && meta.content && meta.content.length > 20) return meta.content;
    return '';
  }

  function safeLabel(text){
    if (!text) return '';
    return text.replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL);
  }

  function enqueue(payload){
    queue.push(payload);
    flushQueue();
  }

  function flushQueue(){
    if (flushing || !queue.length) return;
    if (navigator && navigator.onLine === false) return;
    flushing = true;
    const next = queue.shift();
    send(next).finally(() => {
      flushing = false;
      if (queue.length){
        setTimeout(flushQueue, 200);
      }
    });
  }

  function send(payload){
    if (!IS_AUTHENTICATED) return Promise.resolve();
    try {
      payload = Object.assign({ path: window.location.pathname + window.location.search, ts: Date.now() }, payload || {});
      const body = JSON.stringify(payload);
      const headers = {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest'
      };
      const csrf = getCsrfToken();
      if (!csrf) return Promise.resolve();
      headers['X-CSRFToken'] = csrf;
      return fetch(ENDPOINT, {
        method: 'POST',
        headers,
        body,
        keepalive: true,
        credentials: 'same-origin'
      }).catch(() => {
        enqueue(payload);
      });
    } catch(_err) {
      enqueue(payload);
      return Promise.resolve();
    }
  }

  function extractMeta(target){
    if (!target || !target.dataset) return {};
    const meta = {};
    Object.keys(target.dataset).forEach(key => {
      if (key === 'logLabel' || key === 'logEvent') return;
      meta[key] = target.dataset[key];
    });
    return meta;
  }

  document.addEventListener('click', function(ev){
    const target = ev.target.closest('a, button, [data-log-event], input[type="submit"], .btn');
    if (!target) return;
    const tag = target.tagName || 'UNKNOWN';
    const label = target.dataset.logLabel || target.getAttribute('aria-label') || safeLabel(target.textContent) || target.id || target.name || tag;
    const href = target.href ? (function(){ try { return new URL(target.href, window.location.origin).pathname; } catch(_e){ return target.getAttribute('href'); } })() : null;
    enqueue({
      event: 'click',
      label,
      tag,
      href,
      meta: extractMeta(target)
    });
  }, true);

  document.addEventListener('submit', function(ev){
    const form = ev.target.closest('form');
    if (!form) return;
    const label = form.dataset.logLabel || form.id || form.getAttribute('name') || 'form';
    enqueue({
      event: 'submit',
      label,
      tag: 'FORM',
      meta: extractMeta(form)
    });
  }, true);

  function logPageView(){
    enqueue({ event: 'page_view', label: document.title });
  }

  function logError(event){
    if (!event) return;
    enqueue({
      event: 'js_error',
      label: safeLabel(event.message || 'error'),
      meta: {
        source: event.filename || '',
        line: event.lineno || '',
        column: event.colno || '',
        stack: event.error && event.error.stack ? event.error.stack.slice(0, 500) : ''
      }
    });
  }

  function logRejection(event){
    if (!event || !event.reason) return;
    const reason = event.reason;
    let message = '';
    let stack = '';
    if (typeof reason === 'string'){
      message = reason;
    } else if (reason && typeof reason === 'object'){
      message = reason.message || String(reason);
      stack = reason.stack || '';
    }
    enqueue({
      event: 'promise_rejection',
      label: safeLabel(message),
      meta: { stack: stack ? stack.slice(0, 500) : '' }
    });
  }

  window.addEventListener('error', logError);
  window.addEventListener('unhandledrejection', logRejection);
  window.addEventListener('online', flushQueue);

  document.addEventListener('turbo:load', logPageView);
  if (document.readyState === 'complete' || document.readyState === 'interactive'){
    setTimeout(logPageView, 0);
  } else {
    window.addEventListener('DOMContentLoaded', logPageView, { once: true });
  }

  flushQueue();
})();
