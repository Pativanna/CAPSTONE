(function () {
  'use strict';

  function onReady(cb) {
    const run = () => cb();
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', run, { once: true });
    } else {
      run();
    }
    document.addEventListener('page:ready', run);
    document.addEventListener('turbo:load', run);
    document.addEventListener('turbo:frame-load', run);
  }

  function getForm(shell) {
    if (!shell) return null;
    const selector = shell.dataset.filterForm;
    if (selector) {
      return document.querySelector(selector);
    }
    return shell.querySelector('form');
  }

  function submitForm(form) {
    if (!form) return;
    if (typeof form.requestSubmit === 'function') {
      form.requestSubmit();
    } else {
      form.submit();
    }
  }

  function collectFields(form) {
    if (!form) return [];
    return Array.from(form.elements).filter((el) => {
      if (!el.name || el.name === 'csrfmiddlewaretoken') return false;
      if (el.dataset && el.dataset.countable === 'false') return false;
      if (el.type === 'submit' || el.type === 'button' || el.type === 'file') return false;
      return true;
    });
  }

  function countActiveFields(form) {
    const fields = collectFields(form);
    let active = 0;
    fields.forEach((field) => {
      if ((field.type === 'checkbox' || field.type === 'radio')) {
        if (field.checked && field.value) {
          active += 1;
        }
        return;
      }
      const value = (field.value || '').toString().trim();
      if (value.length) {
        active += 1;
      }
    });
    return active;
  }

  function updateCounter(shell) {
    const counter = shell.querySelector('[data-filter-count]');
    if (!counter) {
      return;
    }
    const form = getForm(shell);
    const active = form ? countActiveFields(form) : 0;
    const label = counter.dataset.filterLabel || 'Filtros';
    if (active > 0) {
      const plural = active === 1 ? 'filtro activo' : 'filtros activos';
      counter.textContent = `${active} ${plural}`;
    } else {
      counter.textContent = `${label}: 0`;
    }
  }

  function resetFilters(shell, trigger) {
    const form = getForm(shell);
    const resetUrl = (trigger && trigger.dataset && trigger.dataset.resetUrl) || shell.dataset.resetUrl;
    if (resetUrl) {
      window.location.href = resetUrl;
      return;
    }
    if (!form) return;
    form.reset();
    // Limpiar manualmente inputs tipo search (reset no siempre vacía en algunos navegadores con autocompletar)
    form.querySelectorAll('input[type="search"]').forEach((input) => {
      input.value = '';
    });
    updateCounter(shell);
    submitForm(form);
  }

  function bindFilterShell(shell) {
    if (shell.__filterPanelBound) return;
    shell.__filterPanelBound = true;

    const form = getForm(shell);
    if (!form) return;

    const scheduleCounterUpdate = () => {
      window.requestAnimationFrame(() => updateCounter(shell));
    };

    form.addEventListener('input', (event) => {
      if (event.target && event.target.dataset && event.target.dataset.countable === 'false') {
        return;
      }
      scheduleCounterUpdate();
    });
    form.addEventListener('change', (event) => {
      if (event.target && event.target.dataset && event.target.dataset.countable === 'false') {
        return;
      }
      scheduleCounterUpdate();
    });

    form.querySelectorAll('[data-auto-submit="true"]').forEach((field) => {
      field.addEventListener('change', () => submitForm(form));
    });

    const resetTrigger = shell.querySelector('[data-filter-reset]');
    if (resetTrigger) {
      resetTrigger.addEventListener('click', (event) => {
        event.preventDefault();
        resetFilters(shell, resetTrigger);
      });
    }

    updateCounter(shell);
  }

  onReady(() => {
    document.querySelectorAll('[data-filter-shell]').forEach(bindFilterShell);
  });
})();
