// table-functions-vanilla.js - Funcionalidades de la tabla sin jQuery

function inicializarTablaFunciones(){
  function qs(sel, ctx=document){ return ctx.querySelector(sel); }
  function qsa(sel, ctx=document){ return Array.from(ctx.querySelectorAll(sel)); }
  function getCookie(name){
    const value = `; ${document.cookie}`;
    const parts = value.split(`; ${name}=`);
    if (parts.length === 2) return parts.pop().split(';').shift();
    return null;
  }
  function formatCurrencyCL(value){
    const n = parseInt(value, 10);
    if (!n) return '-';
    return '$' + n.toLocaleString('es-CL');
  }
  const FILTERS_KEY = 'columnFilters';
  function escapeHtml(str){
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function renderEditableCell(cell, displayValue){
    const hasValue = displayValue !== undefined && displayValue !== null && displayValue !== '';
    const valueStr = hasValue ? String(displayValue) : '-';
    const classList = cell.classList;
    const isDesktopName = cell.dataset.field === 'name' && ((classList && classList.contains('part-name-cell')) || cell.dataset.autoModel);
    if (isDesktopName){
      const autoModel = cell.dataset.autoModel || '';
      const autoYear = cell.dataset.autoYear || '';
      const metaHtml = (autoModel || autoYear)
        ? `<div class="part-name-meta text-muted"><i class="fas fa-car-side me-1 text-primary"></i><span class="part-name-meta-model">${escapeHtml(autoModel)}</span>${autoYear ? `<span class="text-body-secondary ms-1">${escapeHtml(autoYear)}</span>` : ''}</div>`
        : '';
      cell.innerHTML = `<div class="part-name-text fw-semibold">${escapeHtml(valueStr)}</div>${metaHtml}`;
    } else {
      cell.textContent = valueStr;
    }
  }

  function loadColumnFilters(){
    try {
      return JSON.parse(localStorage.getItem(FILTERS_KEY) || '{}') || {};
    } catch (_){
      return {};
    }
  }

  function saveColumnFilters(filters){
    localStorage.setItem(FILTERS_KEY, JSON.stringify(filters || {}));
  }

  function syncFilterInputs(filters){
    const state = filters || {};
    qsa('.column-filter').forEach(el => {
      const column = el.dataset.column;
      if (!column) return;
      const nextVal = state[column] || '';
      if (el.value !== nextVal){
        el.value = nextVal;
      }
    });
  }

  function updateFilterChips(filters){
    const state = filters || {};
    qsa('[data-filter-chip]').forEach(chip => {
      const column = chip.dataset.column;
      if (!column) return;
      const chipValue = (chip.dataset.value || '').toLowerCase();
      const currentValue = ((state[column] || '') + '').toLowerCase();
      const isDefault = chipValue.length === 0;
      const isActive = isDefault ? !currentValue : currentValue === chipValue && chipValue.length > 0;
      chip.classList.toggle('active', isActive);
    });
  }

  function updateFilterCounters(filters){
    const state = filters || {};
    const count = Object.keys(state).filter(key => (state[key] || '').toString().trim().length > 0).length;
    qsa('[data-filter-count]').forEach(el => {
      const label = el.dataset.filterLabel || 'Filtros rápidos';
      if (count > 0){
        const plural = count === 1 ? 'filtro activo' : 'filtros activos';
        el.textContent = `${count} ${plural}`;
      } else {
        el.textContent = `${label}: 0`;
      }
    });
  }

  function persistAndApply(column, value){
    if (!column) return;
    const filters = loadColumnFilters();
    const rawValue = (value || '').toString();
    const trimmed = rawValue.trim();
    if (trimmed){
      filters[column] = rawValue;
    } else {
      delete filters[column];
    }
    saveColumnFilters(filters);
    syncFilterInputs(filters);
    updateFilterChips(filters);
    updateFilterCounters(filters);
    applyFilters(filters);
  }

  // ====== LIMPIAR FILTROS ======
  const clearBtn = qs('#clear-filters-btn');
  if (clearBtn){
    clearBtn.addEventListener('click', function(){
      saveColumnFilters({});
      syncFilterInputs({});
      updateFilterChips({});
      updateFilterCounters({});
      const globalSearchEl = qs('#global-part-search');
      if (globalSearchEl) globalSearchEl.value = '';
      applyFilters({});
      try {
        document.dispatchEvent(new CustomEvent('parts:filters-cleared'));
      } catch(_) {
        document.dispatchEvent(new Event('parts:filters-cleared'));
      }
    });
  }

  // ====== ORDENAMIENTO POR COLUMNAS (SOLO ICONO) ======
  const sortDirection = {}; // {column: 'asc'|'desc'}
  qsa('.sortable i.fa-sort, .sortable i.fa-sort-up, .sortable i.fa-sort-down').forEach(icon => {
    icon.addEventListener('click', function(e){
      e.stopPropagation();
      const th = icon.closest('th');
      const column = th?.dataset.column;
      const tbody = qs('#parts-table tbody');
      const rows = qsa('tr.part-row', tbody);
      if (!column || !tbody) return;

      // Toggle direction (empieza desc)
      sortDirection[column] = sortDirection[column] === 'desc' ? 'asc' : 'desc';
      const direction = sortDirection[column];

      // Update icons
      qsa('.sortable i').forEach(i => { i.classList.remove('fa-sort-up','fa-sort-down'); i.classList.add('fa-sort'); });
      icon.classList.remove('fa-sort');
      icon.classList.add(direction === 'asc' ? 'fa-sort-up' : 'fa-sort-down');

      const parseVal = (row) => {
        if (column === 'sold'){
          const btn = qs('.toggle-sold-btn', row);
          const sold = String(btn?.dataset.sold) === 'true';
          return sold ? 1 : 0;
        }
        if (column === 'max_value' || column === 'min_value'){
          const cell = qs(`[data-field="${column}"]`, row);
          const txt = (cell?.textContent || '').trim();
          return txt === '-' ? 0 : parseInt(txt.replace(/[$,.]/g, '')) || 0;
        }
        if (column === 'date_added'){
          const td = row.querySelector('[data-col="date"]');
          const t = (td?.textContent || '').trim();
          if (!t) return new Date(0).getTime();
          const [d,m,y] = t.split('/');
          return new Date(`${y}-${m}-${d}`).getTime();
        }
        if (column === 'name'){
          const cell = qs(`[data-field="${column}"]`, row);
          return (cell?.textContent || '').toLowerCase().trim();
        }
        const cell = qs(`[data-field="${column}"]`, row) || row;
        return (cell?.textContent || '').toLowerCase().trim();
      };

      rows.sort((a,b) => {
        const av = parseVal(a);
        const bv = parseVal(b);
        if (direction === 'asc') return av > bv ? 1 : av < bv ? -1 : 0;
        return av < bv ? 1 : av > bv ? -1 : 0;
      });

      rows.forEach(r => tbody.appendChild(r));
    });
  });

  // ====== FILTROS POR COLUMNA ======
  const savedFilters = loadColumnFilters();
  if ('min_value' in savedFilters || 'max_value' in savedFilters){
    delete savedFilters.min_value; delete savedFilters.max_value;
    saveColumnFilters(savedFilters);
  }
  syncFilterInputs(savedFilters);
  updateFilterChips(savedFilters);
  updateFilterCounters(savedFilters);

  qsa('.column-filter').forEach(input => {
    input.addEventListener('input', onFilterChange);
    input.addEventListener('change', onFilterChange);
  });

  function onFilterChange(e){
    const el = e.target;
    if (!el) return;
    const column = el.dataset.column;
    const value = el.value || '';
    persistAndApply(column, value);
  }

  qsa('[data-filter-chip]').forEach(chip => {
    chip.addEventListener('click', function(){
      const column = chip.dataset.column;
      if (!column) return;
      const value = chip.dataset.value || '';
      const filters = loadColumnFilters();
      const currentValue = ((filters[column] || '') + '').toLowerCase();
      const targetValue = value.toLowerCase();
      if (value && currentValue === targetValue){
        persistAndApply(column, '');
      } else {
        persistAndApply(column, value);
      }
    });
  });

  function applyFilters(activeFilters){
    const filters = activeFilters || loadColumnFilters();
    const globalSearchEl = qs('#global-part-search');
    const globalTerm = globalSearchEl ? globalSearchEl.value.toLowerCase().trim() : '';
    const searchTerms = globalTerm ? globalTerm.split(/\s+/).filter(Boolean) : [];
    const hasGlobalSearch = searchTerms.length > 0;
    
    qsa('#parts-table tbody tr.part-row').forEach(row => {
      let show = true;
      const rowText = (row.textContent || '').toLowerCase();
      const autoMeta = (row.dataset.autoSearch || '').toLowerCase();
      
      if (hasGlobalSearch) {
        const matchesSearch = searchTerms.every(term => rowText.includes(term) || autoMeta.includes(term));
        if (!matchesSearch) {
          show = false;
        }
      }
      
      if (show) {
        Object.keys(filters).forEach(column => {
          const fv = (filters[column] || '').toLowerCase().trim();
          if (!fv) return;
          let cv = '';
          if (column === 'sold'){
            const btn = qs('.toggle-sold-btn', row);
            const sold = String(btn?.dataset.sold) === 'true';
            cv = sold ? 'vendido' : 'disponible';
            show = show && cv.includes(fv);
          } else if (column === 'workshop'){
            const td = row.querySelector('[data-col="workshop"]');
            cv = (td?.textContent || '').toLowerCase().trim();
            show = show && (cv === fv);
          } else if (column === 'date_added'){
            const td = row.querySelector('[data-col="date"]');
            cv = (td?.textContent || '').toLowerCase().trim();
            show = show && cv.includes(fv);
          } else if (column === 'name' || column === 'min_value' || column === 'max_value' || column === 'details'){
            const cell = qs(`[data-field="${column}"]`, row);
            const rawText = column === 'name'
              ? (cell?.querySelector('.part-name-text')?.textContent || cell?.textContent || '')
              : (cell?.textContent || '');
            cv = rawText.toLowerCase().trim();
            show = show && cv.includes(fv);
          }
        });
      }
      
      if (show && row._isFiltering){
        row.classList.remove('is-filtering');
        row._isFiltering = false;
        row.style.display = '';
      } else if (!show && !row._isFiltering){
        row._isFiltering = true;
        row.classList.add('is-filtering');
        setTimeout(() => {
          row.style.display = 'none';
        }, 220);
      }
    });

    // También aplicar filtros a las cards móviles
    const filtersCopy = Object.assign({}, filters);
    const hasAnyFilter = Object.keys(filtersCopy).some(k => (filtersCopy[k] || '').toString().trim().length > 0);
    qsa('.part-row-mobile').forEach(card => {
      let show = true;
      const text = (card.textContent || '').toLowerCase();
      const autoMeta = (card.dataset.autoSearch || '').toLowerCase();
      
      if (hasGlobalSearch) {
        const matchesSearch = searchTerms.every(term => text.includes(term) || autoMeta.includes(term));
        if (!matchesSearch) {
          show = false;
        }
      }
      
      // Es para aplicar filtros de columnas
      if (show && hasAnyFilter) {
        Object.keys(filtersCopy).forEach(column => {
          const fv = (filtersCopy[column] || '').toLowerCase().trim();
          if (!fv) return;
          if (!text.includes(fv)) {
            show = false;
          }
        });
      }
      
      if (show && card._isFiltering){
        card.classList.remove('is-filtering');
        card._isFiltering = false;
        card.style.display = '';
      } else if (!show && !card._isFiltering){
        card._isFiltering = true;
        card.classList.add('is-filtering');
        setTimeout(() => {
          card.style.display = 'none';
        }, 220);
      }
    });
  }

  applyFilters(savedFilters);

  // ====== TOGGLE VENDIDO/DISPONIBLE ======
  qsa('.toggle-sold-btn').forEach(btn => {
    btn.addEventListener('click', function(){
      const partId = btn.dataset.partId;
      fetch(`/parts/${partId}/toggle-sold/`, {
        method: 'POST',
        headers: { 'X-Requested-With': 'XMLHttpRequest', 'X-CSRFToken': getCookie('csrftoken') }
      }).then(r => r.json()).then(data => {
        if (data.success){
          btn.dataset.sold = String(data.sold);
          const row = btn.closest('tr') || btn.closest('.part-row-mobile');
          if (data.sold){
            btn.classList.remove('btn-outline-success');
            btn.classList.add('btn-success');
            btn.innerHTML = '<i class="fas fa-check-circle"></i>' + (row?.classList.contains('part-row-mobile') ? '' : ' Vendido');
            row?.classList.add('sold-row');
          } else {
            btn.classList.remove('btn-success');
            btn.classList.add('btn-outline-success');
            btn.innerHTML = '<i class="far fa-circle"></i>' + (row?.classList.contains('part-row-mobile') ? '' : ' Disponible');
            row?.classList.remove('sold-row');
          }
        } else {
          window.showToast?.({ title: 'Error', body: 'No se pudo actualizar el estado', variant: 'danger' });
        }
      }).catch(() => {
        window.showToast?.({ title: 'Error', body: 'Conexión fallida', variant: 'danger' });
      });
    });
  });

  // ====== EDICIÓN INLINE ====== (se rompe facil)
  let editingCell = null;
  qsa('.editable, .editable-mobile').forEach(cell => {
    // Evitar múltiples listeners
    if (cell._editListenerAttached) return;
    cell._editListenerAttached = true;
    
    cell.addEventListener('dblclick', function(){
      if (editingCell) return;
      editingCell = cell;
      const field = cell.dataset.field;
      let currentValue;
      if (field === 'name'){
        const nameSpan = cell.querySelector('.part-name-text');
        currentValue = (nameSpan?.textContent || '').trim();
      } else {
        currentValue = (cell.textContent || '').trim();
      }
      if (field.includes('value')) currentValue = currentValue.replace('$','').replace(/[.,]/g,'');
      if (currentValue === '-') currentValue = '';
      const partId = (cell.closest('tr') || cell.closest('.part-row-mobile'))?.dataset.partId;
      if (!partId) return;

      const input = document.createElement('input');
      input.type = field.includes('value') ? 'number' : 'text';
      input.className = 'form-control form-control-sm';
      input.value = currentValue;
      cell.classList.add('editing');
      cell.innerHTML = '';
      cell.appendChild(input);
      input.focus();

      function cleanup(val){
        if (field.includes('value') && val){
          return formatCurrencyCL(val);
        }
        return val || '-';
      }

      function save(){
        if (!editingCell) return;
        const newValue = input.value;
        fetch(`/parts/${partId}/update-field/`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'X-CSRFToken': getCookie('csrftoken') },
          body: JSON.stringify({ field, value: newValue })
        }).then(r => r.json()).then(data => {
          if (data.success){
            cell.classList.remove('editing');
            renderEditableCell(cell, cleanup(newValue));
            editingCell = null;
          } else {
            window.showToast?.({ title: 'Error', body: 'No se pudo guardar', variant: 'danger' });
            cell.classList.remove('editing');
            renderEditableCell(cell, cleanup(currentValue));
            editingCell = null;
          }
        }).catch(() => {
          window.showToast?.({ title: 'Error', body: 'Conexión fallida', variant: 'danger' });
          cell.classList.remove('editing');
          renderEditableCell(cell, cleanup(currentValue));
          editingCell = null;
        });
      }

      input.addEventListener('keypress', e => { if (e.key === 'Enter'){ e.preventDefault(); save(); } });
      input.addEventListener('keydown', e => {
        if (e.key === 'Escape'){
          cell.classList.remove('editing');
          renderEditableCell(cell, cleanup(currentValue));
          editingCell = null;
        }
      });
      input.addEventListener('blur', () => { if (editingCell) save(); });
    });
  });

  // ====== ELIMINAR PIEZA (con modal Bootstrap) ======
  const deleteCtx = { id: null, row: null };
  const deleteModalEl = qs('#deletePartModal');
  // Inicializar modal Bootstrap de forma LAZY para evitar ReferenceError si bootstrap aún no cargó
  let deleteModal = null;
  if (deleteModalEl){
    if (window.bootstrap && window.bootstrap.Modal){
      deleteModal = new window.bootstrap.Modal(deleteModalEl);
    } else {
      // Esperar hasta que la librería Bootstrap esté disponible (script bundle cargado al final del body)
      window.addEventListener('load', () => {
        if (window.bootstrap && window.bootstrap.Modal){
          deleteModal = new window.bootstrap.Modal(deleteModalEl);
        }
      });
    }
  }
  const confirmDeleteBtn = qs('#confirmDeleteBtn');

  if (confirmDeleteBtn){
    confirmDeleteBtn.addEventListener('click', function(){
      if (!deleteCtx.id || !deleteCtx.row) return;
      fetch(`/parts/delete/${deleteCtx.id}/`, { method: 'POST', headers: { 'X-Requested-With': 'XMLHttpRequest', 'X-CSRFToken': getCookie('csrftoken') } })
        .then(r => { if (!r.ok) throw new Error('fail'); return r.text(); })
        .then(() => {
          if (deleteModal) deleteModal.hide();
          const row = deleteCtx.row;
          row.style.transition = 'opacity .3s ease';
          row.style.opacity = '0';
          setTimeout(() => {
            row.remove();
            const tbody = qs('#parts-table tbody');
            if (tbody && !qsa('tr.part-row', tbody).length){
              const tr = document.createElement('tr');
              tr.innerHTML = '<td colspan="8" class="text-center text-muted"><i class="fas fa-inbox"></i> No hay piezas registradas</td>';
              tbody.appendChild(tr);
            }
            // Check mobile cards
            const mobileContainer = qs('.d-lg-none');
            if (mobileContainer && !qsa('.part-row-mobile', mobileContainer).length){
              mobileContainer.innerHTML = '<div class="card"><div class="card-body text-center text-muted py-5"><i class="fas fa-inbox fa-3x mb-3 d-block"></i><p class="mb-0">No hay piezas registradas</p></div></div>';
            }
          }, 300);
          deleteCtx.id = null; deleteCtx.row = null;
        })
        .catch(() => window.showToast?.({ title: 'Error', body: 'No se pudo eliminar', variant: 'danger' }));
    });
  }

  qsa('.delete-part-btn').forEach(btn => {
    btn.addEventListener('click', function(){
      const partId = btn.dataset.partId;
      const row = btn.closest('tr') || btn.closest('.part-row-mobile');
      if (deleteModal){
        deleteCtx.id = partId; deleteCtx.row = row;
        const nameCell = qs('[data-field="name"]', row) || qs('.editable-mobile[data-field="name"]', row);
        const name = (nameCell?.textContent || '').trim();
        const nameEl = qs('#deletePartName');
        if (nameEl) nameEl.textContent = name || `ID ${partId}`;
        deleteModal.show();
      } else {
        if (!confirm('¿Está seguro de eliminar esta pieza?')) return;
        fetch(`/parts/delete/${partId}/`, { method: 'POST', headers: { 'X-Requested-With': 'XMLHttpRequest', 'X-CSRFToken': getCookie('csrftoken') } })
          .then(r => { if (!r.ok) throw new Error('fail'); return r.text(); })
          .then(() => {
            row.style.transition = 'opacity .3s ease';
            row.style.opacity = '0';
            setTimeout(() => {
              row.remove();
              const tbody = qs('#parts-table tbody');
              if (tbody && !qsa('tr.part-row', tbody).length){
                const tr = document.createElement('tr');
                tr.innerHTML = '<td colspan="8" class="text-center text-muted"><i class="fas fa-inbox"></i> No hay piezas registradas</td>';
                tbody.appendChild(tr);
              }
              // Check mobile cards
              const mobileContainer = qs('.d-lg-none');
              if (mobileContainer && !qsa('.part-row-mobile', mobileContainer).length){
                mobileContainer.innerHTML = '<div class="card"><div class="card-body text-center text-muted py-5"><i class="fas fa-inbox fa-3x mb-3 d-block"></i><p class="mb-0">No hay piezas registradas</p></div></div>';
              }
            }, 300);
          })
          .catch(() => window.showToast?.({ title: 'Error', body: 'No se pudo eliminar', variant: 'danger' }));
      }
    });
  });

  // ====== BUSCADOR GLOBAL (tipo autorey) ======
  const globalSearch = qs('#global-part-search');
  if (globalSearch){
    const oldHandler = globalSearch._searchHandler;
    if (oldHandler) globalSearch.removeEventListener('input', oldHandler);
    const searchHandler = function(){
      applyFilters();
    };
    globalSearch._searchHandler = searchHandler;
    globalSearch.addEventListener('input', searchHandler);
  }
}

// Inicializar en page:ready y ejecución inmediata si documento ya listo
document.addEventListener('page:ready', inicializarTablaFunciones);
if (document.readyState !== 'loading') {
    inicializarTablaFunciones();
}
