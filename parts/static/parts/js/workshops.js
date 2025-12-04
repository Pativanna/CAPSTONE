/**
 * Edición inline para talleres, compatible con Turbo + CSP estricto.
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
    document.addEventListener('turbo:frame-load', run);
  }

  function getCsrfToken() {
    if (typeof window !== 'undefined' && typeof window.getCsrfToken === 'function') {
      const token = window.getCsrfToken();
      if (token) return token;
    }
    const match = document.cookie.match(/csrftoken=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : '';
  }

  function syncDisplay(workshopId, field, value) {
    const selector = [
      '.workshop-row[data-workshop-id="' + workshopId + '"] [data-field="' + field + '"]',
      '.workshop-row-mobile[data-workshop-id="' + workshopId + '"] [data-field="' + field + '"]'
    ].join(', ');
    document.querySelectorAll(selector).forEach((node) => {
      const label = (node.dataset.emptyLabel || '').trim();
      const text = (value || '').trim();
      node.textContent = text || label || '—';
      node.classList.toggle('text-muted', !text);
    });
  }

  function updateField(workshopId, field, value) {
    return fetch('/parts/workshops/' + workshopId + '/update-field/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'X-CSRFToken': getCsrfToken()
      },
      body: JSON.stringify({ field: field, value: value })
    }).then((resp) => resp.json());
  }

  function bindEditable(cell) {
    if (cell.__workshopInlineBound) return;
    cell.__workshopInlineBound = true;
    cell.setAttribute('tabindex', '0');
    cell.setAttribute('role', 'button');
    cell.setAttribute('aria-label', 'Editar ' + (cell.dataset.field || 'campo'));

    const triggerEdit = () => {
      const host = cell.closest('[data-workshop-id]');
      const workshopId = host && host.dataset ? host.dataset.workshopId : null;
      if (!workshopId) return;
      if (cell.classList.contains('editing')) return;
      const field = cell.dataset.field;
      const current = (cell.textContent || '').trim();
      const input = document.createElement('input');
      input.type = field === 'direction' ? 'text' : 'text';
      input.className = 'form-control form-control-sm';
      input.value = current;
      const original = current;
      cell.classList.add('editing');
      cell.dataset.previousValue = original;
      cell.innerHTML = '';
      cell.appendChild(input);
      input.focus();
      input.select();

      const finish = (nextValue, persist) => {
        cell.classList.remove('editing');
        cell.innerHTML = '';
        if (persist) {
          syncDisplay(workshopId, field, nextValue);
        } else {
          cell.textContent = original || cell.dataset.emptyLabel || '—';
        }
      };

      const save = () => {
        const newValue = input.value.trim();
        updateField(workshopId, field, newValue).then((data) => {
          if (data.success) {
            syncDisplay(workshopId, field, newValue);
            window.showToast && window.showToast({ title: 'Actualizado', body: 'Cambios guardados', variant: 'success' });
          } else {
            window.showToast && window.showToast({ title: 'Error', body: data.error || 'No se pudo guardar', variant: 'danger' });
            syncDisplay(workshopId, field, original);
          }
          finish(newValue, true);
        }).catch(() => {
          window.showToast && window.showToast({ title: 'Error', body: 'Conexión fallida', variant: 'danger' });
          finish(original, false);
        });
      };

      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          save();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          finish(original, false);
        }
      });

      input.addEventListener('blur', () => {
        if (cell.classList.contains('editing')) {
          save();
        }
      }, { once: true });
    };

    cell.addEventListener('dblclick', triggerEdit);
    cell.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        triggerEdit();
      }
    });
  }

  function bootstrapEditors() {
    const cells = document.querySelectorAll('.workshop-row [data-field], .workshop-row-mobile [data-field]');
    if (!cells.length) return;
    cells.forEach(bindEditable);
  }

  onReady(bootstrapEditors);
})();
