/**
 * Funciones auxiliares para `part_form_clean` sin scripts inline.
 */
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
  }

  function initClearFields() {
    const clearBtn = document.getElementById('clear-fields');
    const form = document.getElementById('part-form');
    if (!clearBtn || !form || clearBtn.dataset.clearBound === 'true') return;
    clearBtn.dataset.clearBound = 'true';
    const fieldsToReset = ['name', 'details', 'max_value', 'min_value'];
    clearBtn.addEventListener('click', () => {
      fieldsToReset.forEach((name) => {
        const field = form.querySelector(`[name="${name}"]`);
        if (field) field.value = '';
      });
    });
  }

  function initAutoModeFallback() {
    const trigger = document.getElementById('mode-select-auto');
    const targetBox = document.getElementById('select-auto-box');
    const singleBox = document.getElementById('single-entry-box');
    if (!trigger || !targetBox || trigger.dataset.autoBound === 'true') return;
    trigger.dataset.autoBound = 'true';
    trigger.addEventListener('click', () => {
      targetBox.style.display = 'block';
      if (singleBox) singleBox.style.display = 'none';
    });
  }

  onReady(() => {
    initClearFields();
    initAutoModeFallback();
  });
})();
