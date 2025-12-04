/**
 * Funciones de ayuda para publicar piezas sin scripts inline.
 */
(function () {
  'use strict';

  function onReady(cb) {
    const invoke = () => cb();
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', invoke, { once: true });
    } else {
      invoke();
    }
    document.addEventListener('page:ready', invoke);
    document.addEventListener('turbo:load', invoke);
    document.addEventListener('turbo:render', invoke);
    document.addEventListener('turbo:frame-load', invoke);
  }

  function persistFilterPanel() {
    if (typeof window.persistCollapsePanel === 'function') {
      window.persistCollapsePanel('publish-filter-panel', 'publishFiltersPanel', { mobileDefault: 'closed' });
    }
  }

  function fallbackCopy(text) {
    return new Promise((resolve) => {
      const tmp = document.createElement('textarea');
      tmp.value = text;
      tmp.style.position = 'fixed';
      tmp.style.opacity = '0';
      tmp.style.top = '-1000px';
      document.body.appendChild(tmp);
      tmp.focus();
      tmp.select();
      try {
        document.execCommand('copy');
      } catch (error) {
        console.error('copy:fallback', error);
      }
      document.body.removeChild(tmp);
      resolve();
    });
  }

  function copyText(text) {
    if (!text) {
      return Promise.resolve();
    }
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      return navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    }
    return fallbackCopy(text);
  }

  function markCopied(button) {
    if (!button) return;
    button.classList.add('copied');
    const original = button.dataset.originalText || button.innerHTML;
    button.dataset.originalText = original;
    button.innerHTML = '<i class="bi bi-check-lg"></i> Copiado';
    window.setTimeout(() => {
      button.classList.remove('copied');
      button.innerHTML = button.dataset.originalText;
    }, 2000);
  }

  function getCookie(name) {
    const value = '; ' + document.cookie;
    const parts = value.split('; ' + name + '=');
    if (parts.length === 2) return parts.pop().split(';').shift();
    return '';
  }

  function initCopyButtons() {
    document.querySelectorAll('.copy-btn').forEach((button) => {
      if (!button || button.dataset.copyBound === 'true') {
        return;
      }
      button.dataset.copyBound = 'true';
      button.addEventListener('click', (event) => {
        event.preventDefault();
        const target = document.getElementById(button.dataset.copyTarget);
        if (!target) return;
        const text = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA'
          ? target.value
          : target.textContent;
        copyText((text || '').trim()).then(() => markCopied(button));
      });
    });
  }

  function initCopyEverything() {
    const copyAll = document.getElementById('copy-everything');
    if (!copyAll || copyAll.dataset.copyBound === 'true') return;
    copyAll.dataset.copyBound = 'true';
    copyAll.addEventListener('click', (event) => {
      event.preventDefault();
      const title = document.getElementById('publish-title')?.textContent || '';
      const desc = document.getElementById('publish-description')?.value || '';
      const price = document.getElementById('publish-price')?.textContent || '';
      const tags = document.getElementById('publish-tags')?.textContent || '';
      const payload = [title, desc, price, tags].map((value) => value.trim()).filter(Boolean).join('\n\n');
      if (!payload) return;
      copyText(payload).then(() => markCopied(copyAll));
    });
  }

  function initAiDescription() {
    const aiButton = document.getElementById('ai-description-btn');
    const descriptionField = document.getElementById('publish-description');
    if (!aiButton || !descriptionField || aiButton.dataset.aiBound === 'true') {
      return;
    }
    aiButton.dataset.aiBound = 'true';
    aiButton.addEventListener('click', (event) => {
      event.preventDefault();
      const partId = aiButton.dataset.partId;
      if (!partId) return;
      const original = aiButton.innerHTML;
      aiButton.disabled = true;
      aiButton.innerHTML = `
        <span class="spinner-border spinner-border-sm me-1" role="status" aria-hidden="true"></span>
        Generando...
      `;
      fetch(`/parts/publicar/${partId}/ai-description/`, {
        method: 'POST',
        headers: {
          'X-Requested-With': 'XMLHttpRequest',
          'X-CSRFToken': getCookie('csrftoken')
        }
      })
        .then((resp) => resp.json())
        .then((data) => {
          if (!data?.success || !data.text) {
            throw new Error(data?.error || 'No se pudo generar la descripción');
          }
          descriptionField.value = data.text.trim();
          descriptionField.focus();
          const length = descriptionField.value.length;
          descriptionField.setSelectionRange(length, length);
          window.showToast?.({
            title: 'IA',
            body: 'Descripción sugerida lista para copiar.',
            variant: 'success'
          });
        })
        .catch((error) => {
          console.error('ai-description', error);
          window.showToast?.({
            title: 'IA',
            body: error?.message || 'No se pudo generar la descripción',
            variant: 'danger'
          });
        })
        .finally(() => {
          aiButton.disabled = false;
          aiButton.innerHTML = original;
        });
    });
  }

  function initPublishHelper() {
    persistFilterPanel();
    initCopyButtons();
    initCopyEverything();
    initAiDescription();
  }

  onReady(initPublishHelper);
})();
