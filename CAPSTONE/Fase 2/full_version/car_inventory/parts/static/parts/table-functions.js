// table-functions.js - Funcionalidades de la tabla de piezas

$(document).ready(function() {
  // ====== INICIALIZAR SELECT2 ======
  // Verificar que jQuery y Select2 estén cargados
  if (typeof $.fn.select2 !== 'undefined') {
    $('#auto-select').select2({
      placeholder: "Buscar modelo...",
      allowClear: true,
      language: {
        noResults: function() {
          return "No se encontraron resultados";
        }
      }
    });
  }
  
  // ====== CAMBIAR FILTRO DE MODELO/AÑO ======
  $('#auto-select').on('change', function() {
    const value = $(this).val();
    if (value) {
      const [brand_model, year] = value.split('|');
      window.location.href = `?brand_model=${encodeURIComponent(brand_model)}&year=${encodeURIComponent(year)}`;
    } else {
      window.location.href = window.location.pathname;
    }
  });
  
  // ====== LIMPIAR FILTROS ======
  $('#clear-filters-btn').on('click', function() {
    localStorage.removeItem('columnFilters');
    $('.column-filter').val('');
    applyFilters();
  });
  
  // ====== ORDENAMIENTO POR COLUMNAS (SOLO AL HACER CLICK EN EL ICONO) ======
  let sortDirection = {};
  
  // Click en el icono de ordenamiento
  $('.sortable i.fa-sort, .sortable i.fa-sort-up, .sortable i.fa-sort-down').on('click', function(e) {
    e.stopPropagation();
    
    const $th = $(this).closest('th');
    const column = $th.data('column');
    const $tbody = $('#parts-table tbody');
    const rows = $tbody.find('tr.part-row').toArray();
    
    // Toggle direction (empezar con desc para mostrar mayor a menor)
    sortDirection[column] = sortDirection[column] === 'desc' ? 'asc' : 'desc';
    const direction = sortDirection[column];
    
    // Update icons
    $('.sortable i').removeClass('fa-sort-up fa-sort-down').addClass('fa-sort');
    $(this).removeClass('fa-sort').addClass(direction === 'asc' ? 'fa-sort-up' : 'fa-sort-down');
    
    // Sort rows
    rows.sort((a, b) => {
      let aVal, bVal;
      
      if (column === 'sold') {
        const aSold = String($(a).find('.toggle-sold-btn').data('sold')) === 'true';
        const bSold = String($(b).find('.toggle-sold-btn').data('sold')) === 'true';
        aVal = aSold ? 1 : 0;
        bVal = bSold ? 1 : 0;
      } else if (column === 'max_value' || column === 'min_value') {
        const aText = $(a).find(`[data-field="${column}"]`).text().trim();
        const bText = $(b).find(`[data-field="${column}"]`).text().trim();
        aVal = aText === '-' ? 0 : parseInt(aText.replace(/[$,.]/g, '')) || 0;
        bVal = bText === '-' ? 0 : parseInt(bText.replace(/[$,.]/g, '')) || 0;
      } else if (column === 'date_added') {
        const aDate = $(a).find(`td:eq(6)`).text().trim();
        const bDate = $(b).find(`td:eq(6)`).text().trim();
        aVal = aDate ? new Date(aDate.split('/').reverse().join('-')) : new Date(0);
        bVal = bDate ? new Date(bDate.split('/').reverse().join('-')) : new Date(0);
      } else if (column === 'name') {
        aVal = $(a).find(`[data-field="${column}"]`).text().toLowerCase().trim();
        bVal = $(b).find(`[data-field="${column}"]`).text().toLowerCase().trim();
      } else {
        aVal = $(a).find(`[data-field="${column}"]`).text().toLowerCase().trim();
        bVal = $(b).find(`[data-field="${column}"]`).text().toLowerCase().trim();
      }
      
      if (direction === 'asc') {
        return aVal > bVal ? 1 : aVal < bVal ? -1 : 0;
      } else {
        return aVal < bVal ? 1 : aVal > bVal ? -1 : 0;
      }
    });
    
    // Reordenar filas
    $.each(rows, function(index, row) {
      $tbody.append(row);
    });
  });
  
  // ====== FILTROS POR COLUMNA ======
  // Cargar filtros guardados
  const savedFilters = JSON.parse(localStorage.getItem('columnFilters') || '{}');
  // Limpiar filtros de columnas removidas
  if ('min_value' in savedFilters || 'max_value' in savedFilters) {
    delete savedFilters.min_value;
    delete savedFilters.max_value;
    localStorage.setItem('columnFilters', JSON.stringify(savedFilters));
  }
  Object.keys(savedFilters).forEach(column => {
    $(`.column-filter[data-column="${column}"]`).val(savedFilters[column]);
  });
  
  // Aplicar filtros guardados al cargar
  applyFilters();
  
  // Escuchar cambios en filtros
  $('.column-filter').on('input change', function(e) {
    e.stopPropagation(); // Evitar que se propague al th
    const column = $(this).data('column');
    const value = $(this).val();
    
    // Guardar en localStorage
    const filters = JSON.parse(localStorage.getItem('columnFilters') || '{}');
    if (value) {
      filters[column] = value;
    } else {
      delete filters[column];
    }
    localStorage.setItem('columnFilters', JSON.stringify(filters));
    
    applyFilters();
  });
  
  function applyFilters() {
    const filters = JSON.parse(localStorage.getItem('columnFilters') || '{}');
    
    $('#parts-table tbody tr.part-row').each(function() {
      const $row = $(this);
      let show = true;
      
      Object.keys(filters).forEach(column => {
        const filterValue = filters[column].toLowerCase().trim();
        if (!filterValue) return;
        
        let cellValue = '';
        
        if (column === 'sold') {
          const isSold = String($row.find('.toggle-sold-btn').data('sold')) === 'true';
          cellValue = isSold ? 'vendido' : 'disponible';
          show = show && cellValue.includes(filterValue);
        } else if (column === 'workshop') {
          // Columna 5: Ubicación (texto exacto del nombre)
          cellValue = $row.find('td').eq(5).text().toLowerCase().trim();
          // Para dropdown usamos coincidencia exacta
          show = show && (cellValue === filterValue);
        } else if (column === 'date_added') {
          // Columna 6: Fecha Ingreso
          cellValue = $row.find('td').eq(6).text().toLowerCase().trim();
          show = show && cellValue.includes(filterValue);
        } else if (column === 'name' || column === 'min_value' || column === 'max_value') {
          // Usar data-field para estas columnas
          const cellText = $row.find(`[data-field="${column}"]`).text().trim();
          cellValue = cellText.toLowerCase();
          show = show && cellValue.includes(filterValue);
        }
      });
      
      $row.toggle(show);
    });
  }
  
  // ====== TOGGLE VENDIDO/DISPONIBLE ======
  $('.toggle-sold-btn').on('click', function() {
    const partId = $(this).data('part-id');
    const $btn = $(this);
    const $row = $btn.closest('tr');
    
    $.ajax({
      url: `/parts/${partId}/toggle-sold/`,
      method: 'POST',
      success: function(response) {
        if (response.success) {
          $btn.data('sold', response.sold);
          
          if (response.sold) {
            $btn.removeClass('btn-outline-success').addClass('btn-success');
            $btn.html('<i class="fas fa-check-circle"></i> Vendido');
            $row.addClass('sold-row');
          } else {
            $btn.removeClass('btn-success').addClass('btn-outline-success');
            $btn.html('<i class="far fa-circle"></i> Disponible');
            $row.removeClass('sold-row');
          }
        }
      },
      error: function(xhr) {
        console.error('Error:', xhr);
        alert('Error al actualizar el estado');
      }
    });
  });
  
  // ====== EDICIÓN INLINE ======
  let editingCell = null;
  
  $('.editable').on('dblclick', function() {
    if (editingCell) return;
    
    editingCell = $(this);
    const field = editingCell.data('field');
    let currentValue = editingCell.text().trim();
    
    // Limpiar formato de moneda si es un campo de valor
    if (field.includes('value')) {
      currentValue = currentValue.replace('$', '').replace(/,/g, '').replace(/\./g, '');
    }
    
    if (currentValue === '-') currentValue = '';
    
    const partId = editingCell.closest('tr').data('part-id');
    
    // Crear input
    const $input = $('<input>', {
      type: field.includes('value') ? 'number' : 'text',
      class: 'edit-input',
      value: currentValue
    });
    
    editingCell.addClass('editing').html($input);
    $input.focus().select();
    
    // Guardar al presionar Enter o perder foco
    function saveEdit() {
      if (!editingCell) return;
      
      const newValue = $input.val();
      
      $.ajax({
        url: `/parts/${partId}/update-field/`,
        method: 'POST',
        contentType: 'application/json',
        data: JSON.stringify({
          field: field,
          value: newValue
        }),
        success: function(response) {
          if (response.success) {
            let displayValue = newValue;
            if (field.includes('value') && newValue) {
              displayValue = '$' + parseInt(newValue).toLocaleString('es-CL');
            }
            editingCell.removeClass('editing').text(displayValue || '-');
          }
        },
        error: function(xhr) {
          console.error('Error:', xhr);
          alert('Error al guardar');
          let restoreValue = currentValue;
          if (field.includes('value') && currentValue) {
            restoreValue = '$' + parseInt(currentValue).toLocaleString('es-CL');
          }
          editingCell.removeClass('editing').text(restoreValue || '-');
        },
        complete: function() {
          editingCell = null;
        }
      });
    }
    
    $input.on('keypress', function(e) {
      if (e.which === 13) {
        e.preventDefault();
        saveEdit();
      }
    });
    
    $input.on('keydown', function(e) {
      if (e.which === 27) { // ESC key
        editingCell.removeClass('editing').text(currentValue || '-');
        editingCell = null;
      }
    });
    
    $input.on('blur', function() {
      if (editingCell) {
        saveEdit();
      }
    });
  });
  
  // ====== ELIMINAR PIEZA ======
  $('.delete-part-btn').on('click', function() {
    if (!confirm('¿Está seguro de eliminar esta pieza?')) return;
    
    const partId = $(this).data('part-id');
    const $row = $(this).closest('tr');
    
    $.ajax({
      url: `/parts/delete/${partId}/`,
      method: 'POST',
      success: function() {
        $row.fadeOut(300, function() {
          $(this).remove();
          
          // Mostrar mensaje si no quedan filas
          if ($('#parts-table tbody tr.part-row').length === 0) {
            $('#parts-table tbody').html(
              '<tr><td colspan="8" class="text-center text-muted">' +
              '<i class="fas fa-inbox"></i> No hay piezas registradas' +
              '</td></tr>'
            );
          }
        });
      },
      error: function(xhr) {
        console.error('Error:', xhr);
        alert('Error al eliminar la pieza');
      }
    });
  });
});
