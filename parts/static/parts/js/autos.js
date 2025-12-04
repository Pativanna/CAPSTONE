/**
 * Edición inline para autos con historial undo/redo.
 */
(function () {
  'use strict';

  function qs(sel, ctx) {
    return (ctx || document).querySelector(sel);
  }

  function qsa(sel, ctx) {
    return Array.from((ctx || document).querySelectorAll(sel));
  }

  function getCsrfToken() {
    if (typeof window !== 'undefined' && typeof window.getCsrfToken === 'function') {
      var token = window.getCsrfToken();
      if (token) return token;
    }
    var match = document.cookie.match(/csrftoken=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : '';
  }

  function initAutoEdicion() {
    var state = window.__autoHistoryState || { undo: [], redo: [], initialized: false, hotkeys: false };
    window.__autoHistoryState = state;
    if (!state.initialized) {
      state.undo.length = 0;
      state.redo.length = 0;
      state.initialized = true;
    }
    var undoStack = state.undo;
    var redoStack = state.redo;
    var MAX_HISTORY = 50;

    function syncAutoFieldDisplay(autoId, field, value) {
      var selectors = [
        '.auto-row[data-auto-id="' + autoId + '"] [data-field="' + field + '"]',
        '.auto-row-mobile[data-auto-id="' + autoId + '"] [data-field="' + field + '"]'
      ];
      var nodes = qsa(selectors.join(','));
      var raw = value != null ? value : '';
      var stringValue = typeof raw === 'number' ? String(raw) : (raw || '');
      nodes.forEach(function (node) {
        if (!node) return;
        var emptyLabel = node.dataset.emptyLabel || (field === 'notes' ? 'Sin notas registradas' : '-');
        var hasValue = Boolean(stringValue.trim());
        var displayValue = hasValue ? stringValue : emptyLabel;
        node.textContent = displayValue;
        if (field === 'notes') {
          node.dataset.hasValue = String(hasValue);
          node.classList.toggle('text-muted', !hasValue);
        } else if (field === 'license_plate') {
          node.classList.toggle('text-muted', !hasValue);
        }
      });
    }

    function updateField(autoId, field, value) {
      return fetch('/parts/autos/' + autoId + '/update-field/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
          'X-CSRFToken': getCsrfToken()
        },
        body: JSON.stringify({ field: field, value: value })
      }).then(function (resp) { return resp.json(); });
    }

    function pushHistory(entry) {
      if (!entry || entry.previousValue === entry.newValue) return;
      undoStack.push(entry);
      if (undoStack.length > MAX_HISTORY) undoStack.shift();
      redoStack.length = 0;
    }

    function performUndo() {
      if (!undoStack.length) return;
      var entry = undoStack.pop();
      updateField(entry.autoId, entry.field, entry.previousValue).then(function (data) {
        if (data.success) {
          syncAutoFieldDisplay(entry.autoId, entry.field, entry.previousValue);
          redoStack.push(entry);
          window.showToast && window.showToast({ title: 'Deshacer', body: 'Cambio revertido', variant: 'info' });
        } else {
          undoStack.push(entry);
          window.showToast && window.showToast({ title: 'Error', body: 'No se pudo deshacer', variant: 'danger' });
        }
      }).catch(function () {
        undoStack.push(entry);
        window.showToast && window.showToast({ title: 'Error', body: 'No se pudo deshacer', variant: 'danger' });
      });
    }

    function performRedo() {
      if (!redoStack.length) return;
      var entry = redoStack.pop();
      updateField(entry.autoId, entry.field, entry.newValue).then(function (data) {
        if (data.success) {
          syncAutoFieldDisplay(entry.autoId, entry.field, entry.newValue);
          undoStack.push(entry);
          window.showToast && window.showToast({ title: 'Rehacer', body: 'Cambio reaplicado', variant: 'info' });
        } else {
          redoStack.push(entry);
          window.showToast && window.showToast({ title: 'Error', body: 'No se pudo rehacer', variant: 'danger' });
        }
      }).catch(function () {
        redoStack.push(entry);
        window.showToast && window.showToast({ title: 'Error', body: 'No se pudo rehacer', variant: 'danger' });
      });
    }

    if (!state.hotkeys) {
      state.hotkeys = true;
      document.addEventListener('keydown', function (event) {
        var key = event.key ? event.key.toLowerCase() : '';
        var tag = (event.target && event.target.tagName ? event.target.tagName : '').toLowerCase();
        if (['input', 'textarea'].includes(tag)) return;
        var hasCtrl = event.ctrlKey || event.metaKey;
        if (!hasCtrl || event.altKey) return;
        if (key === 'z' && !event.shiftKey) {
          if (!undoStack.length) return;
          event.preventDefault();
          performUndo();
        } else if ((key === 'z' && event.shiftKey) || key === 'y') {
          if (!redoStack.length) return;
          event.preventDefault();
          performRedo();
        }
      });
    }

    var editingCell = null;
    qsa('.editable, .editable-mobile').forEach(function (cell) {
      if (cell.__autoInlineBound) return;
      cell.__autoInlineBound = true;
      cell.addEventListener('dblclick', function () {
        if (editingCell) return;
        editingCell = cell;
        var field = cell.dataset.field;
        var isNotes = field === 'notes';
        var hadValue = cell.dataset.hasValue === 'true';
        var rawText = (cell.textContent || '').replace(/\r\n/g, '\n');
        var candidateValue = isNotes ? rawText : rawText.trim();
        var trimmedCandidate = candidateValue.trim();
        var currentValue = '';
        if (trimmedCandidate && (hadValue || trimmedCandidate !== (cell.dataset.emptyLabel || '-'))) {
          currentValue = isNotes ? candidateValue : trimmedCandidate;
        }
        var autoId = (cell.closest('tr') || cell.closest('.auto-row-mobile'))?.dataset.autoId;
        if (!autoId) return;

        var input = document.createElement(isNotes ? 'textarea' : 'input');
        if (!isNotes) {
          input.type = field === 'year' ? 'number' : 'text';
        } else {
          input.rows = Math.min(6, Math.max(3, (currentValue.match(/\n/g) || []).length + 1));
          input.maxLength = 400;
          input.classList.add('auto-notes-editor');
        }
        input.classList.add('form-control', 'form-control-sm');
        input.value = currentValue;
        cell.classList.add('editing');
        cell.innerHTML = '';
        cell.appendChild(input);
        input.focus();

        function finishEditing(value) {
          cell.classList.remove('editing');
          syncAutoFieldDisplay(autoId, field, value);
          editingCell = null;
        }

        function save() {
          if (!editingCell) return;
          var newValue = input.value;
          updateField(autoId, field, newValue).then(function (data) {
            if (data.success) {
              pushHistory({ autoId: autoId, field: field, previousValue: currentValue, newValue: newValue });
              finishEditing(newValue);
            } else {
              window.showToast && window.showToast({ title: 'Error', body: 'No se pudo guardar', variant: 'danger' });
              finishEditing(currentValue);
            }
          }).catch(function () {
            window.showToast && window.showToast({ title: 'Error', body: 'Conexión fallida', variant: 'danger' });
            finishEditing(currentValue);
          });
        }

        if (!isNotes) {
          input.addEventListener('keypress', function (event) {
            if (event.key === 'Enter') {
              event.preventDefault();
              save();
            }
          });
        } else {
          input.addEventListener('keydown', function (event) {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault();
              save();
            }
          });
        }
        input.addEventListener('keydown', function (event) {
          if (event.key === 'Escape') {
            finishEditing(currentValue);
          }
        });
        input.addEventListener('blur', function () {
          if (editingCell) save();
        });
      });
    });
  }

  function onReady(cb) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', cb, { once: true });
    } else {
      cb();
    }
    document.addEventListener('page:ready', cb);
    document.addEventListener('turbo:load', cb);
    document.addEventListener('turbo:render', cb);
    document.addEventListener('turbo:frame-load', cb);
  }

  onReady(initAutoEdicion);
})();
