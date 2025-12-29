/**
 * Verificador de Código de Barras
 * 
 * Integra con el plugin nativo MLKitScanner para escanear códigos
 * y verificar piezas del inventario.
 * 
 * Sigue patrón de carga compatible con Turbo (ISO 25010 - Mantenibilidad)
 */
(function() {
  'use strict';

  // Evitar múltiples inicializaciones
  let initialized = false;
  
  // Estado del verificador
  const state = {
    selectedPart: null,
    isScanning: false,
    lastScannedCode: null,
    searchDebounceTimer: null,
    barcodeListener: null,
    results: [],
    sort: { column: 'name', direction: 'asc' },
    filters: {
      name: '',
      barcode: '',
      sold: '',
    },
    expanded: new Set(),
  };
  
  // Elementos del DOM
  let elements = {};

  /**
   * Patrón onReady compatible con Turbo
   * Escucha múltiples eventos para asegurar inicialización correcta
   */
  function onReady(callback) {
    const fire = () => {
      // Solo inicializar si estamos en la página del verificador
      if (!document.getElementById('verificadorContainer')) {
        return;
      }
      callback();
    };
    
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fire, { once: true });
    } else {
      fire();
    }
    document.addEventListener('page:ready', fire);
    document.addEventListener('turbo:load', fire);
    document.addEventListener('turbo:render', fire);
    document.addEventListener('turbo:frame-load', fire);
  }
  
  // Inicializar cuando el DOM esté listo
  function init() {
    // Evitar doble inicialización
    if (initialized && elements.container) {
      console.log('[Verificador] Ya inicializado, omitiendo');
      return;
    }
    
    console.log('[Verificador] Inicializando...');
    
    // Cachear elementos
    elements = {
      container: document.getElementById('verificadorContainer'),
      btnOpenScanner: document.getElementById('btnOpenScanner'),
      btnCloseScanner: document.getElementById('btnCloseScanner'),
      btnClearSelection: document.getElementById('btnClearSelection'),
      searchInput: document.getElementById('searchInput'),
      clearSearchBtn: document.getElementById('clearSearchBtn'),
      tableBody: document.getElementById('verificadorTableBody'),
      mobileList: document.getElementById('verificadorMobileList'),
      noResults: document.getElementById('verificadorNoResults'),
      selectedPartCard: document.getElementById('selectedPartCard'),
      selectedPartInfo: document.getElementById('selectedPartInfo'),
      webOnlyMessage: document.getElementById('webOnlyMessage'),
      sortHeaders: Array.from(document.querySelectorAll('#verificador-table [data-sort]')),
      scannerPanel: document.getElementById('scannerPanel'),
      scannerFlash: document.getElementById('scannerFlash'),
      scannerLastRead: document.getElementById('scannerLastRead'),
      scannerTargetName: document.getElementById('scannerTargetName'),
      scannerTargetCode: document.getElementById('scannerTargetCode'),
    };
    
    if (!elements.container) {
      console.log('[Verificador] Container no encontrado, no es página del verificador');
      return;
    }
    
    initialized = true;
    
    // Verificar si estamos en contexto nativo
    checkNativeContext();
    
    // Event listeners
    setupEventListeners();
    updateSortIndicators();
    
    // Cargar resultados iniciales
    searchParts('');
    
    console.log('[Verificador] Inicializado correctamente');
  }
  
  /**
   * Verifica si estamos en la app nativa o en web
   */
  function checkNativeContext() {
    const isNative = window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform();
    
    console.log('[Verificador] Contexto nativo:', isNative);
    
    if (!isNative) {
      // Mostrar mensaje de que solo funciona en app
      if (elements.webOnlyMessage) {
        elements.webOnlyMessage.classList.remove('d-none');
      }
      if (elements.btnOpenScanner) {
        elements.btnOpenScanner.disabled = true;
        elements.btnOpenScanner.innerHTML = '<i class="bi bi-phone"></i> Solo en app móvil';
      }
    }
  }
  
  /**
   * Configura los event listeners
   */
  function setupEventListeners() {
    // Botón abrir escáner
    if (elements.btnOpenScanner) {
      elements.btnOpenScanner.addEventListener('click', openScanner);
    }

    if (elements.btnCloseScanner) {
      elements.btnCloseScanner.addEventListener('click', closeScanner);
    }
    
    // Botón quitar selección
    if (elements.btnClearSelection) {
      elements.btnClearSelection.addEventListener('click', clearSelection);
    }
    
    // Input de búsqueda
    if (elements.searchInput) {
      elements.searchInput.addEventListener('input', function(e) {
        clearTimeout(state.searchDebounceTimer);
        state.searchDebounceTimer = setTimeout(() => {
          searchParts(e.target.value);
        }, 300);
      });
    }

    if (elements.clearSearchBtn) {
      elements.clearSearchBtn.addEventListener('click', function() {
        if (elements.searchInput) {
          elements.searchInput.value = '';
        }
        searchParts('');
      });
    }

    // Ordenamiento de columnas
    elements.sortHeaders.forEach(header => {
      header.addEventListener('click', () => {
        const column = header.dataset.sort;
        if (!column) return;
        if (state.sort.column === column) {
          state.sort.direction = state.sort.direction === 'asc' ? 'desc' : 'asc';
        } else {
          state.sort = { column, direction: 'asc' };
        }
        updateSortIndicators();
        renderSearchResults();
      });
    });

    const handleRowToggle = (row) => {
      const partId = row?.dataset?.partId;
      if (!partId) return;
      if (state.expanded.has(partId)) {
        state.expanded.delete(partId);
      } else {
        state.expanded.add(partId);
      }
      renderSearchResults();
    };

    const handleScanButton = (btn) => {
      const raw = btn.dataset.part;
      if (!raw) return;
      const partData = JSON.parse(raw || '{}');
      startScanForPart(partData);
    };

    const handleSelectButton = (btn) => {
      const raw = btn.dataset.part;
      if (!raw) return;
      const partData = JSON.parse(raw || '{}');
      selectPart(partData);
    };

    const handleApplySearchButton = (btn) => {
      let term = btn.dataset.searchTerm || '';
      term = term.trim();
      if (!term) return;
      if (elements.searchInput) {
        elements.searchInput.value = term;
        elements.searchInput.focus();
      }
      searchParts(term);
    };

    // Delegación de clicks en filas (desktop)
    if (elements.tableBody) {
      elements.tableBody.addEventListener('click', function(e) {
        const scanBtn = e.target.closest('[data-action="scan-part"]');
        if (scanBtn) {
          handleScanButton(scanBtn);
          e.stopPropagation();
          return;
        }
        const applySearchBtn = e.target.closest('[data-action="apply-search"]');
        if (applySearchBtn) {
          handleApplySearchButton(applySearchBtn);
          e.stopPropagation();
          return;
        }
        const selectBtn = e.target.closest('[data-action="select-part"]');
        if (selectBtn) {
          handleSelectButton(selectBtn);
          return;
        }
        const row = e.target.closest('tr[data-row-kind="main"]');
        if (row) {
          handleRowToggle(row);
        }
      });
    }

    // Delegación en filas móviles
    if (elements.mobileList) {
      elements.mobileList.addEventListener('click', function(e) {
        const scanBtn = e.target.closest('[data-action="scan-part"]');
        if (scanBtn) {
          handleScanButton(scanBtn);
          e.stopPropagation();
          return;
        }
        const applySearchBtn = e.target.closest('[data-action="apply-search"]');
        if (applySearchBtn) {
          handleApplySearchButton(applySearchBtn);
          e.stopPropagation();
          return;
        }
        const selectBtn = e.target.closest('[data-action="select-part"]');
        if (selectBtn) {
          handleSelectButton(selectBtn);
          return;
        }
        const row = e.target.closest('tr[data-row-kind="main"]');
        if (row) {
          handleRowToggle(row);
        }
      });
    }
  }

  /**
   * Controla el HUD inmersivo y el blur del shell
   */
  function setScannerOverlay(active) {
    const isActive = Boolean(active);
    if (elements.container) {
      elements.container.classList.toggle('scanner-active', isActive);
    }
    if (document.body) {
      document.body.classList.toggle('scanner-mode', isActive);
    }
    if (elements.scannerPanel) {
      elements.scannerPanel.classList.toggle('is-visible', isActive);
      elements.scannerPanel.setAttribute('aria-hidden', isActive ? 'false' : 'true');
    }
    if (!isActive && elements.scannerFlash) {
      elements.scannerFlash.classList.remove('active');
    }
    if (isActive && elements.scannerLastRead) {
      elements.scannerLastRead.textContent = 'Calibrando cámara...';
    }
    if (!isActive && elements.scannerLastRead) {
      elements.scannerLastRead.textContent = 'Apunta a un código de barras...';
    }
    if (isActive && state.selectedPart && elements.scannerTargetName && elements.scannerTargetCode) {
      elements.scannerTargetName.textContent = state.selectedPart.name || 'Objetivo';
      elements.scannerTargetCode.textContent = state.selectedPart.barcode || '-';
    } else {
      if (elements.scannerTargetName) elements.scannerTargetName.textContent = 'Cualquier código';
      if (elements.scannerTargetCode) elements.scannerTargetCode.textContent = '-';
    }
  }

  /**
   * Busca piezas en el backend
   */
  async function searchParts(query) {
    try {
      const url = new URL('/verificador/search/', window.location.origin);
      url.searchParams.set('q', query);
      url.searchParams.set('limit', '50');
      
      const response = await fetch(url, {
        credentials: 'same-origin',
        headers: {
          'X-Requested-With': 'XMLHttpRequest',
        },
      });
      
      if (!response.ok) throw new Error('Error en búsqueda');
      
      const data = await response.json();
      renderSearchResults(data.results || []);
      
    } catch (error) {
      console.error('[Verificador] Error buscando piezas:', error);
      state.results = [];
      renderSearchResults([]);
      if (elements.noResults) {
        elements.noResults.classList.remove('d-none');
        elements.noResults.classList.remove('alert-info');
        elements.noResults.classList.add('alert-danger');
        elements.noResults.innerHTML = '<i class="bi bi-exclamation-triangle"></i> Error al buscar piezas';
      }
    }
  }
  
  /**
   * Renderiza los resultados de búsqueda
   */
  function renderSearchResults(results) {
    if (Array.isArray(results)) {
      state.results = results.map((part, index) => ({
        ...part,
        added_index: index,
      }));
    }
    const ordered = getSortedResults();
    renderDesktopRows(ordered);
    renderMobileCards(ordered);
    updateEmptyStates(ordered);
  }

  function getSortedResults() {
    const list = (state.results || []).slice();
    const { column, direction } = state.sort;
    const dir = direction === 'desc' ? -1 : 1;

    if (column === 'name') {
      return list.sort((a, b) => {
        const va = typeof a.added_index === 'number' ? a.added_index : Number.MAX_SAFE_INTEGER;
        const vb = typeof b.added_index === 'number' ? b.added_index : Number.MAX_SAFE_INTEGER;
        if (va < vb) return -1 * dir;
        if (va > vb) return 1 * dir;
        return 0;
      });
    }

    return list;
  }

  function renderDesktopRows(list) {
    if (!elements.tableBody) return;
    if (!list.length) {
      elements.tableBody.innerHTML = '';
      return;
    }
    const rows = list.flatMap(part => {
      const isSelected = state.selectedPart && state.selectedPart.id === part.id;
      const isExpanded = state.expanded.has(String(part.id));
      const rowClasses = ['verificador-main-row'];
      if (isSelected) rowClasses.push('table-primary');
      if (isExpanded) rowClasses.push('is-expanded');
      const photoUrl = part.foto_url || '/static/parts/img/no-photo.svg';
      const partData = JSON.stringify(part).replace(/'/g, '&#39;');
      const year = part.year || part.anio || '';
      const barcodeLabel = part.barcode ? escapeHtml(part.barcode) : 'Sin código';
      const barcodeBadge = part.barcode
        ? `<span class="badge bg-primary-subtle text-primary">${barcodeLabel}</span>`
        : '<span class="badge bg-secondary">Sin código</span>';
      const statusBadge = part.sold
        ? '<span class="badge bg-secondary">Vendida</span>'
        : '<span class="badge bg-success-subtle text-success">Disponible</span>';
      const searchTerm = escapeHtml(part.barcode || part.codigo || part.name || '');
      const searchLabel = part.barcode ? barcodeLabel : escapeHtml(part.name || 'pieza');
      const mainRow = `
        <tr class="${rowClasses.join(' ')}" data-row-kind="main" data-part='${partData}' data-part-id="${part.id}" data-has-barcode="${!!part.barcode}" aria-expanded="${isExpanded ? 'true' : 'false'}">
          <td class="text-center align-middle verificador-photo-cell">
            <img src="${photoUrl}" alt="${escapeHtml(part.name)}" class="verificador-table-thumb" onerror="this.src='/static/parts/img/no-photo.svg'">
          </td>
          <td class="align-middle verificador-piece-cell">
            <div class="verificador-main-cell">
              <div class="verificador-piece-text">
                <div class="fw-semibold mb-0">${escapeHtml(part.name || 'Sin nombre')}</div>
                <div class="text-muted small text-truncate">${escapeHtml(part.auto || '-')}${year ? ` • ${escapeHtml(year)}` : ''}</div>
              </div>
              <span class="verificador-toggle-icon" aria-hidden="true">
                <i class="bi bi-chevron-down"></i>
              </span>
            </div>
          </td>
        </tr>`;
      const detailRow = `
        <tr class="verificador-detail-row ${isExpanded ? 'show' : ''}" data-row-kind="detail" data-detail-for="${part.id}">
          <td colspan="2">
            <div class="verificador-detail-card">
              <div class="detail-meta">
                <div><span class="label">Auto</span><strong>${escapeHtml(part.auto || '-')}</strong></div>
                <div><span class="label">Año</span><strong>${escapeHtml(year || '—')}</strong></div>
                <div><span class="label">Código</span>${barcodeBadge}</div>
                <div><span class="label">Estado</span>${statusBadge}</div>
              </div>
              <div class="detail-actions mt-2">
                <button type="button"
                        class="btn btn-outline-primary btn-sm"
                        data-action="apply-search"
                        data-search-term="${searchTerm}"
                        ${searchTerm ? '' : 'disabled'}>
                  <i class="bi bi-search"></i> Buscar ${searchLabel}
                </button>
                <button type="button" class="btn btn-primary btn-sm" data-action="scan-part" data-part='${partData}' ${part.barcode ? '' : 'disabled'}>
                  <i class="bi bi-camera-video"></i> Escanear código
                </button>
                <button type="button" class="btn btn-outline-secondary btn-sm" data-action="select-part" data-part='${partData}'>
                  <i class="bi bi-pin-angle"></i> Fijar objetivo
                </button>
              </div>
            </div>
          </td>
        </tr>`;
      return [mainRow, detailRow];
    }).join('');
    elements.tableBody.innerHTML = rows;
  }

  function renderMobileCards(list) {
    if (!elements.mobileList) return;
    if (!list.length) {
      elements.mobileList.innerHTML = '';
      return;
    }
    const cards = list.flatMap(part => {
      const isExpanded = state.expanded.has(String(part.id));
      const isSelected = state.selectedPart && state.selectedPart.id === part.id;
      const rowClasses = ['verificador-main-row'];
      if (isSelected) rowClasses.push('table-primary');
      if (isExpanded) rowClasses.push('is-expanded');
      const photoUrl = part.foto_url || '/static/parts/img/no-photo.svg';
      const partData = JSON.stringify(part).replace(/'/g, '&#39;');
      const year = part.year || part.anio || '';
      const barcodeLabel = part.barcode ? escapeHtml(part.barcode) : 'Sin código';
      const barcodeBadge = part.barcode
        ? `<span class="badge bg-primary-subtle text-primary">${barcodeLabel}</span>`
        : '<span class="badge bg-secondary">Sin código</span>';
      const statusBadge = part.sold
        ? '<span class="badge bg-secondary">Vendida</span>'
        : '<span class="badge bg-success-subtle text-success">Disponible</span>';
      const searchTerm = escapeHtml(part.barcode || part.codigo || part.name || '');
      const searchLabel = part.barcode ? barcodeLabel : escapeHtml(part.name || 'pieza');
      const mainRow = `
        <tr class="${rowClasses.join(' ')}"
            data-row-kind="main"
            data-part='${partData}'
            data-part-id="${part.id}"
            data-has-barcode="${!!part.barcode}"
            aria-expanded="${isExpanded ? 'true' : 'false'}">
          <td class="text-center align-middle" style="width:48px;">
            <img src="${photoUrl}" alt="${escapeHtml(part.name)}" class="verificador-table-thumb" onerror="this.src='/static/parts/img/no-photo.svg'">
          </td>
          <td class="align-middle">
            <div class="verificador-main-cell">
              <div class="verificador-piece-text">
                <div class="fw-semibold">${escapeHtml(part.name || 'Sin nombre')}</div>
                <div class="text-muted small">${escapeHtml(part.auto || '-')}${year ? ` • ${escapeHtml(year)}` : ''}</div>
              </div>
              <span class="verificador-toggle-icon" aria-hidden="true">
                <i class="bi bi-chevron-down"></i>
              </span>
            </div>
          </td>
        </tr>`;
      const detailRow = `
        <tr class="verificador-detail-row ${isExpanded ? 'show' : ''}" data-row-kind="detail" data-detail-for="${part.id}">
          <td colspan="2">
            <div class="verificador-detail-card">
              <div class="detail-meta">
                <div><span class="label">Auto</span><strong>${escapeHtml(part.auto || '-')}</strong></div>
                <div><span class="label">Año</span><strong>${escapeHtml(year || '—')}</strong></div>
                <div><span class="label">Código</span>${barcodeBadge}</div>
                <div><span class="label">Estado</span>${statusBadge}</div>
              </div>
              <div class="detail-actions mt-2">
                <button type="button"
                        class="btn btn-outline-primary btn-sm"
                        data-action="apply-search"
                        data-search-term="${searchTerm}"
                        ${searchTerm ? '' : 'disabled'}>
                  <i class="bi bi-search"></i> Buscar ${searchLabel}
                </button>
                <button type="button" class="btn btn-primary btn-sm" data-action="scan-part" data-part='${partData}' ${part.barcode ? '' : 'disabled'}>
                  <i class="bi bi-camera-video"></i> Escanear
                </button>
                <button type="button" class="btn btn-outline-secondary btn-sm" data-action="select-part" data-part='${partData}'>
                  <i class="bi bi-pin-angle"></i> Fijar
                </button>
              </div>
            </div>
          </td>
        </tr>`;
      return [mainRow, detailRow];
    }).join('');
    elements.mobileList.innerHTML = cards;
  }

  function updateEmptyStates(list) {
    if (elements.noResults) {
      elements.noResults.classList.toggle('d-none', list.length > 0);
    }
    if (elements.tableBody) {
      elements.tableBody.closest('.table-responsive')?.classList.toggle('d-none', !list.length && window.innerWidth >= 992);
    }
  }

  function updateSortIndicators() {
    elements.sortHeaders.forEach(header => {
      const col = header.dataset.sort;
      const isActive = col === state.sort.column;
      header.classList.toggle('active', isActive);
      const icon = header.querySelector('.sort-indicator');
      if (icon) {
        icon.classList.remove('fa-sort', 'fa-sort-up', 'fa-sort-down');
        if (isActive) {
          icon.classList.add(state.sort.direction === 'asc' ? 'fa-sort-up' : 'fa-sort-down');
        } else {
          icon.classList.add('fa-sort');
        }
      }
    });
  }
  
  /**
   * Selecciona una pieza para buscar
   */
  function selectPart(part) {
    state.selectedPart = part;
    updateSelectedPartCard();
    renderSearchResults();
  }

  function updateSelectedPartCard() {
    if (state.selectedPart) {
      if (elements.selectedPartCard) {
        elements.selectedPartCard.classList.remove('d-none');
      }
      if (elements.selectedPartInfo) {
        const p = state.selectedPart;
        const year = p.year || p.anio || '';
        elements.selectedPartInfo.innerHTML = `
          <div class="d-flex align-items-center justify-content-between flex-wrap">
            <div>
              <strong>${escapeHtml(p.name)}</strong>
              <div class="small text-muted">${escapeHtml(p.auto || '-')}${year ? ` • ${escapeHtml(year)}` : ''}</div>
            </div>
            <div class="mt-1 text-end">
              <span class="badge bg-primary">
                <i class="bi bi-upc"></i> ${escapeHtml(p.barcode || '—')}
              </span>
            </div>
          </div>
        `;
      }
    } else {
      if (elements.selectedPartCard) elements.selectedPartCard.classList.add('d-none');
      if (elements.selectedPartInfo) elements.selectedPartInfo.innerHTML = '';
    }
  }

  function startScanForPart(part) {
    selectPart(part);
    openScanner();
  }
  
  /**
   * Quita la selección actual
   */
  function clearSelection() {
    state.selectedPart = null;
    
    if (elements.selectedPartCard) {
      elements.selectedPartCard.classList.add('d-none');
    }
    
    // Re-renderizar resultados
    renderSearchResults();
  }
  
  /**
   * Abre el escáner nativo
   */
  async function openScanner() {
    console.log('[Verificador] Abriendo escáner...');
    
    // Verificar que tenemos Capacitor
    if (!window.Capacitor || !window.Capacitor.isNativePlatform || !window.Capacitor.isNativePlatform()) {
      alert('El escáner solo está disponible en la app móvil.');
      return;
    }
    
    // Registrar el plugin si no existe
    if (!window.Capacitor.Plugins.MLKitScanner) {
      if (window.Capacitor.registerPlugin) {
        window.Capacitor.registerPlugin('MLKitScanner');
      }
    }
    
    const MLKitScanner = window.Capacitor.Plugins.MLKitScanner;
    
    if (!MLKitScanner) {
      alert('El plugin de escáner no está disponible.');
      return;
    }
    
    // Preparar parámetros
    const options = {
      continuous: true // Modo continuo para escanear múltiples códigos
    };
    
    if (state.selectedPart) {
      options.targetBarcode = state.selectedPart.barcode;
      options.targetName = state.selectedPart.name;
    }
    
    console.log('[Verificador] Opciones de escaneo:', options);
    
    let result = null;
    
    try {
      setScannerOverlay(true);
      // Listener para códigos escaneados (modo continuo)
      state.barcodeListener = await MLKitScanner.addListener(
        'barcodeScanned',
        handleBarcodeScanned
      );
      
      // Iniciar escaneo (lanza Activity nativa)
      state.isScanning = true;
      result = await MLKitScanner.startScan(options);
      
      console.log('[Verificador] Resultado del escáner:', result);
      
    } catch (error) {
      console.error('[Verificador] Error abriendo escáner:', error);
      alert('Error al abrir el escáner: ' + (error.message || error));
    } finally {
      state.isScanning = false;
      if (state.barcodeListener) {
        state.barcodeListener.remove();
        state.barcodeListener = null;
      }
      setScannerOverlay(false);
    }
    
    // Si no fue cancelado, procesar el resultado final
    if (result && !result.cancelled && result.barcode) {
      await processScannedBarcode(result.barcode, result.format, result.isMatch);
    }
  }
  
  /**
   * Cierra el escáner (ya no necesitamos esto porque la Activity se cierra sola)
   */
  async function closeScanner() {
    console.log('[Verificador] Cerrando escáner...');
    
    state.isScanning = false;
    setScannerOverlay(false);
    
    // Remover listener
    if (state.barcodeListener) {
      state.barcodeListener.remove();
      state.barcodeListener = null;
    }
    
    // Llamar stopScan por si acaso
    try {
      if (window.Capacitor?.Plugins?.MLKitScanner) {
        await window.Capacitor.Plugins.MLKitScanner.stopScan();
      }
    } catch (error) {
      console.warn('[Verificador] Error deteniendo escáner:', error);
    }
  }
  
  /**
   * Actualiza la info mostrada en el escáner (ya no se usa con Activity separada)
   */
  function updateScannerInfo() {
    // Ya no necesario - la Activity maneja su propia UI
  }
  
  /**
   * Maneja un código escaneado (evento desde broadcast en modo continuo)
   */
  async function handleBarcodeScanned(event) {
    const { barcode, format, isMatch } = event;
    console.log('[Verificador] Código escaneado (broadcast):', barcode, format, isMatch);
    
    await processScannedBarcode(barcode, format, isMatch);
  }
  
  /**
   * Procesa un código de barras escaneado
   */
  async function processScannedBarcode(barcode, format, matchFromNative) {
    // Evitar procesar el mismo código repetidamente
    if (barcode === state.lastScannedCode) return;
    state.lastScannedCode = barcode;
    
    // Limpiar después de un tiempo para permitir re-escaneo
    setTimeout(() => {
      if (state.lastScannedCode === barcode) {
        state.lastScannedCode = null;
      }
    }, 2000);
    
    // Verificar si hay match (usar resultado nativo o calcular)
    const isMatch = matchFromNative || (state.selectedPart && state.selectedPart.barcode === barcode);
    
    console.log('[Verificador] Procesando código:', barcode, 'Match:', isMatch);
    
    // Registrar en el backend
    try {
      await logVerification(barcode, format, isMatch);
    } catch (error) {
      console.error('[Verificador] Error registrando verificación:', error);
    }
  }
  
  /**
   * Registra la verificación en el backend
   */
  async function logVerification(barcode, format, isMatch) {
    try {
      const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content 
                     || document.querySelector('[name=csrfmiddlewaretoken]')?.value;
      
      const response = await fetch('/verificador/log/', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRFToken': csrfToken,
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({
          codigo_escaneado: barcode,
          formato_codigo: format,
          pieza_buscada_id: state.selectedPart?.id || null,
          codigo_esperado: state.selectedPart?.barcode || '',
        }),
      });
      
      if (!response.ok) {
        throw new Error('Error registrando verificación');
      }
      
      const data = await response.json();
      console.log('[Verificador] Verificación registrada:', data);
      
      return data;
      
    } catch (error) {
      console.error('[Verificador] Error en logVerification:', error);
      throw error;
    }
  }
  
  /**
   * Escapa HTML para prevenir XSS
   */
  function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
  
  /**
   * Cleanup al salir de la página
   */
  function cleanup() {
    if (state.isScanning) {
      closeScanner();
    }
    setScannerOverlay(false);
    state.expanded.clear();
    initialized = false;
    elements = {};
  }

  // Usar patrón onReady compatible con Turbo
  onReady(init);
  
  // Limpiar al salir de la página
  document.addEventListener('turbo:before-render', cleanup);
  document.addEventListener('turbo:before-cache', cleanup);
  
})();
