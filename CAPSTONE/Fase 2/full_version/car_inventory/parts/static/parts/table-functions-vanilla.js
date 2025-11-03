// table-functions-vanilla.js - Funcionalidades de la tabla sin jQuery

(function(){
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

  // ====== LIMPIAR FILTROS ======
  const clearBtn = qs('#clear-filters-btn');
  if (clearBtn){
    clearBtn.addEventListener('click', function(){
      localStorage.removeItem('columnFilters');
      qsa('.column-filter').forEach(el => el.value = '');
      applyFilters();
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
          const td = row.querySelectorAll('td')[6];
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
  const savedFilters = JSON.parse(localStorage.getItem('columnFilters') || '{}');
  if ('min_value' in savedFilters || 'max_value' in savedFilters){
    delete savedFilters.min_value; delete savedFilters.max_value;
    localStorage.setItem('columnFilters', JSON.stringify(savedFilters));
  }
  Object.keys(savedFilters).forEach(c => {
    const el = qs(`.column-filter[data-column="${c}"]`);
    if (el) el.value = savedFilters[c];
  });

  qsa('.column-filter').forEach(input => {
    input.addEventListener('input', onFilterChange);
    input.addEventListener('change', onFilterChange);
  });

  function onFilterChange(e){
    const el = e.target;
    const column = el.dataset.column;
    const value = el.value || '';
    const filters = JSON.parse(localStorage.getItem('columnFilters') || '{}');
    if (value) filters[column] = value; else delete filters[column];
    localStorage.setItem('columnFilters', JSON.stringify(filters));
    applyFilters();
  }

  function applyFilters(){
    const filters = JSON.parse(localStorage.getItem('columnFilters') || '{}');
    qsa('#parts-table tbody tr.part-row').forEach(row => {
      let show = true;
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
          const td = row.querySelectorAll('td')[5];
          cv = (td?.textContent || '').toLowerCase().trim();
          show = show && (cv === fv);
        } else if (column === 'date_added'){
          const td = row.querySelectorAll('td')[6];
          cv = (td?.textContent || '').toLowerCase().trim();
          show = show && cv.includes(fv);
        } else if (column === 'name' || column === 'min_value' || column === 'max_value' || column === 'details'){
          const cell = qs(`[data-field="${column}"]`, row);
          cv = (cell?.textContent || '').toLowerCase().trim();
          show = show && cv.includes(fv);
        }
      });
      row.style.display = show ? '' : 'none';
    });
  }

  applyFilters();

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
          const row = btn.closest('tr');
          if (data.sold){
            btn.classList.remove('btn-outline-success');
            btn.classList.add('btn-success');
            btn.innerHTML = '<i class="fas fa-check-circle"></i> Vendido';
            row.classList.add('sold-row');
          } else {
            btn.classList.remove('btn-success');
            btn.classList.add('btn-outline-success');
            btn.innerHTML = '<i class="far fa-circle"></i> Disponible';
            row.classList.remove('sold-row');
          }
        } else {
          window.showToast?.({ title: 'Error', body: 'No se pudo actualizar el estado', variant: 'danger' });
        }
      }).catch(() => {
        window.showToast?.({ title: 'Error', body: 'Conexión fallida', variant: 'danger' });
      });
    });
  });

  // ====== EDICIÓN INLINE ======
  let editingCell = null;
  qsa('.editable').forEach(cell => {
    cell.addEventListener('dblclick', function(){
      if (editingCell) return;
      editingCell = cell;
      const field = cell.dataset.field;
      let currentValue = (cell.textContent || '').trim();
      if (field.includes('value')) currentValue = currentValue.replace('$','').replace(/[.,]/g,'');
      if (currentValue === '-') currentValue = '';
      const partId = cell.closest('tr').dataset.partId;

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
            cell.textContent = cleanup(newValue);
            editingCell = null;
          } else {
            window.showToast?.({ title: 'Error', body: 'No se pudo guardar', variant: 'danger' });
            cell.classList.remove('editing');
            cell.textContent = cleanup(currentValue);
            editingCell = null;
          }
        }).catch(() => {
          window.showToast?.({ title: 'Error', body: 'Conexión fallida', variant: 'danger' });
          cell.classList.remove('editing');
          cell.textContent = cleanup(currentValue);
          editingCell = null;
        });
      }

      input.addEventListener('keypress', e => { if (e.key === 'Enter'){ e.preventDefault(); save(); } });
      input.addEventListener('keydown', e => { if (e.key === 'Escape'){ cell.classList.remove('editing'); cell.textContent = cleanup(currentValue); editingCell = null; } });
      input.addEventListener('blur', () => { if (editingCell) save(); });
    });
  });

  // ====== ELIMINAR PIEZA (con modal Bootstrap si está disponible) ======
  const deleteCtx = { id: null, row: null };
  const deleteModalEl = qs('#deletePartModal');
  const deleteModal = deleteModalEl ? new bootstrap.Modal(deleteModalEl) : null;
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
            if (!qsa('tr.part-row', tbody).length){
              const tr = document.createElement('tr');
              tr.innerHTML = '<td colspan="8" class="text-center text-muted"><i class="fas fa-inbox"></i> No hay piezas registradas</td>';
              tbody.appendChild(tr);
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
      const row = btn.closest('tr');
      if (deleteModal){
        deleteCtx.id = partId; deleteCtx.row = row;
        const nameCell = qs('[data-field="name"]', row);
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
              if (!qsa('tr.part-row', tbody).length){
                const tr = document.createElement('tr');
                tr.innerHTML = '<td colspan="8" class="text-center text-muted"><i class="fas fa-inbox"></i> No hay piezas registradas</td>';
                tbody.appendChild(tr);
              }
            }, 300);
          })
          .catch(() => window.showToast?.({ title: 'Error', body: 'No se pudo eliminar', variant: 'danger' }));
      }
    });
  });
})();
