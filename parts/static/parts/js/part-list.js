/**
 * Funciones específicas para la vista de inventario de piezas.
 * Separa la lógica inline para cumplir CSP estricto y facilitar mantenimiento.
 * 
 * Optimizaciones v2.0 (2025-12-30):
 * - Web Worker para búsqueda sin bloquear UI
 * - IndexedDB para almacenamiento asíncrono
 * - Debounce de 150ms en búsqueda
 * - Índice invertido O(1) en lugar de O(n)
 * 
 * Cumple con:
 * - ISO/IEC 25010: Eficiencia de desempeño
 * - ISO/IEC 27001: Seguridad (datos locales)
 * - ISO 9241-171: Usabilidad (respuesta <100ms)
 * 
 * @author Sistema Automatizado
 * @version 2.0.0
 */
(function () {
  'use strict';

  // ============================================================================
  // CONSTANTES DE CONFIGURACIÓN
  // ============================================================================
  const LOAD_MORE_MAX_FILTER_PAGES = 5;
  const LOAD_MORE_DEFAULT_BATCH = 20;
  const LIVE_SYNC_INTERVAL = 60000;
  const LIVE_SYNC_IDLE_INTERVAL = 90000;
  
  // Configuración de búsqueda optimizada
  const SEARCH_DEBOUNCE_MS = 150;
  const SEARCH_MAX_RESULTS = 20;
  const CACHE_STALE_MS = 10 * 60 * 1000; // 10 minutos

  // ============================================================================
  // UTILIDADES BASE
  // ============================================================================
  
  /**
   * Ejecuta callback cuando el DOM está listo, compatible con Turbo.
   * @param {Function} callback - Función a ejecutar
   */
  function onReady(callback) {
    const fire = () => callback();
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

  /**
   * Normaliza texto para búsqueda (elimina acentos, minúsculas).
   * @param {string} value - Texto a normalizar
   * @returns {string} Texto normalizado
   */
  function normalizeForSearch(value) {
    if (!value) return '';
    return String(value)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
  }

  /**
   * Escapa HTML para prevenir XSS.
   * @param {*} value - Valor a escapar
   * @returns {string} HTML seguro
   */
  function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/[&<>"']/g, (ch) => {
      switch (ch) {
        case '&': return '&amp;';
        case '<': return '&lt;';
        case '>': return '&gt;';
        case '"': return '&quot;';
        case "'": return '&#39;';
        default: return ch;
      }
    });
  }

  /**
   * Crea función con debounce para evitar llamadas excesivas.
   * @param {Function} func - Función a debouncer
   * @param {number} wait - Milisegundos de espera
   * @returns {Function} Función con debounce
   */
  function debounce(func, wait) {
    let timeoutId = null;
    return function(...args) {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => func.apply(this, args), wait);
    };
  }

  // ============================================================================
  // CATALOG CACHE - MÓDULO OPTIMIZADO CON WEB WORKER E INDEXEDDB
  // ============================================================================
  
  const CatalogCache = (() => {
    const STORAGE_KEY = 'parts:catalog-cache:v2';
    const LEGACY_STORAGE_KEY = 'parts:catalog-cache:v1';
    
    // Estado interno
    let cache = null;
    let fetchPromise = null;
    let catalogUrl = null;
    let expectedVersion = null;
    let worker = null;
    let workerReady = false;
    let pendingSearches = new Map();
    let requestIdCounter = 0;
    let useWorker = true;
    let loadPromise = null;

    // -------------------------------------------------------------------------
    // INICIALIZACIÓN DEL WEB WORKER
    // -------------------------------------------------------------------------
    
    /**
     * Inicializa el Web Worker para búsqueda asíncrona.
     */
    const initWorker = () => {
      if (worker) return;
      
      try {
        // Intentar crear worker con la ruta del archivo
        const workerUrl = '/static/parts/js/search-worker.js';
        worker = new Worker(workerUrl);
        
        worker.onmessage = handleWorkerMessage;
        worker.onerror = (error) => {
          console.warn('[CatalogCache] Worker error, usando fallback:', error.message);
          useWorker = false;
          worker = null;
        };
        
        console.log('[CatalogCache] Worker inicializado');
      } catch (error) {
        console.warn('[CatalogCache] No se pudo crear Worker:', error.message);
        useWorker = false;
      }
    };

    /**
     * Maneja mensajes del Worker.
     */
    const handleWorkerMessage = (event) => {
      const { type, requestId, payload } = event.data;
      
      switch (type) {
        case 'WORKER_READY':
          workerReady = true;
          console.log('[CatalogCache] Worker listo');
          break;
          
        case 'LOAD_COMPLETE':
          console.log(`[CatalogCache] Índice construido: ${payload.count} piezas, ${payload.indexSize} términos`);
          if (pendingSearches.has(requestId)) {
            const { resolve } = pendingSearches.get(requestId);
            pendingSearches.delete(requestId);
            resolve(payload);
          }
          break;
          
        case 'SEARCH_RESULTS':
          if (pendingSearches.has(requestId)) {
            const { resolve } = pendingSearches.get(requestId);
            pendingSearches.delete(requestId);
            console.log(`[CatalogCache] Búsqueda "${payload.term}": ${payload.count} resultados en ${payload.duration}ms`);
            resolve(payload.results);
          }
          break;
          
        case 'ERROR':
          console.error('[CatalogCache] Worker error:', payload);
          if (pendingSearches.has(requestId)) {
            const { reject } = pendingSearches.get(requestId);
            pendingSearches.delete(requestId);
            reject(new Error(payload.message));
          }
          break;
      }
    };

    /**
     * Envía comando al Worker con Promise.
     */
    const sendToWorker = (type, payload) => {
      return new Promise((resolve, reject) => {
        if (!worker || !workerReady) {
          reject(new Error('Worker no disponible'));
          return;
        }
        
        const requestId = ++requestIdCounter;
        pendingSearches.set(requestId, { resolve, reject });
        
        worker.postMessage({ type, payload, requestId });
        
        // Timeout de 5 segundos
        setTimeout(() => {
          if (pendingSearches.has(requestId)) {
            pendingSearches.delete(requestId);
            reject(new Error('Timeout del Worker'));
          }
        }, 5000);
      });
    };

    // -------------------------------------------------------------------------
    // ALMACENAMIENTO CON INDEXEDDB
    // -------------------------------------------------------------------------
    
    /**
     * Carga datos desde IndexedDB o localStorage (fallback).
     */
    const loadFromStorage = async () => {
      if (cache) return cache;
      
      // Intentar IndexedDB primero
      if (window.CatalogDB && await window.CatalogDB.isAvailable()) {
        try {
          const data = await window.CatalogDB.load();
          if (data) {
            cache = data;
            return cache;
          }
        } catch (error) {
          console.warn('[CatalogCache] IndexedDB load failed:', error);
        }
      }
      
      // Fallback a localStorage
      try {
        let raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) {
          // Intentar versión legacy
          raw = localStorage.getItem(LEGACY_STORAGE_KEY);
        }
        cache = raw ? JSON.parse(raw) : null;
      } catch (_err) {
        cache = null;
      }
      
      return cache;
    };

    /**
     * Guarda datos en IndexedDB y localStorage (backup).
     */
    const saveToStorage = async (data) => {
      cache = data;
      
      // Guardar en IndexedDB (asíncrono, no bloqueante)
      if (window.CatalogDB) {
        window.CatalogDB.save(data).catch(err => {
          console.warn('[CatalogCache] IndexedDB save failed:', err);
        });
      }
      
      // Backup en localStorage (síncrono pero necesario para compatibilidad)
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      } catch (_err) {
        /* ignore quota */
      }
    };

    /**
     * Preprocesa entradas para búsqueda rápida (fallback sin Worker).
     */
    const enhanceEntries = (data) => {
      if (!data || !Array.isArray(data.parts)) return data;
      
      data.parts.forEach((part) => {
        const combined = `${part.name || ''} ${part.auto || ''} ${part.barcode || ''}`;
        part._normalized = normalizeForSearch(combined);
        part._barcode = (part.barcode || '').toLowerCase();
      });
      
      return data;
    };

    /**
     * Verifica si el cache está obsoleto.
     */
    const isStale = (data) => {
      if (!data || !data.fetched_at) return true;
      return (Date.now() - data.fetched_at) > CACHE_STALE_MS;
    };

    /**
     * Obtiene cache actual (carga lazy si es necesario).
     */
    const getCache = () => cache;

    // -------------------------------------------------------------------------
    // API PÚBLICA
    // -------------------------------------------------------------------------
    
    /**
     * Actualiza una entrada en el cache.
     */
    const updateEntry = (partId, updates) => {
      const data = getCache();
      if (!data?.parts?.length) return;
      
      const entry = data.parts.find((item) => String(item.id) === String(partId));
      if (!entry) return;
      
      if (typeof updates === 'function') {
        updates(entry);
      } else if (updates && typeof updates === 'object') {
        Object.assign(entry, updates);
      }
      
      // Re-procesar normalización
      const combined = `${entry.name || ''} ${entry.auto || ''} ${entry.barcode || ''}`;
      entry._normalized = normalizeForSearch(combined);
      entry._barcode = (entry.barcode || '').toLowerCase();
      
      saveToStorage(data);
      
      // Actualizar Worker si está disponible
      if (worker && workerReady) {
        sendToWorker('UPDATE_ENTRY', { partId, updates: entry }).catch(() => {});
      }
    };

    /**
     * Descarga catálogo del servidor.
     */
    const fetchLatest = async () => {
      if (!catalogUrl) return null;
      if (fetchPromise) return fetchPromise;
      
      console.time('[CatalogCache] fetchLatest');
      
      fetchPromise = fetch(catalogUrl, {
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
        credentials: 'same-origin'
      })
        .then((resp) => resp.json())
        .then(async (payload) => {
          if (!payload?.success) throw new Error('Respuesta inválida');
          
          payload.fetched_at = Date.now();
          const enhanced = enhanceEntries(payload);
          
          // Guardar en almacenamiento
          await saveToStorage(enhanced);
          
          // Cargar en Worker para búsqueda indexada
          if (worker && workerReady && enhanced.parts) {
            try {
              await sendToWorker('LOAD', {
                parts: enhanced.parts,
                version: enhanced.version
              });
            } catch (error) {
              console.warn('[CatalogCache] Worker load failed:', error);
            }
          }
          
          console.timeEnd('[CatalogCache] fetchLatest');
          return cache;
        })
        .catch((err) => {
          console.warn('[CatalogCache] fetch error:', err);
          console.timeEnd('[CatalogCache] fetchLatest');
          return getCache();
        })
        .finally(() => {
          fetchPromise = null;
        });
      
      return fetchPromise;
    };

    /**
     * Asegura que el cache esté fresco, descargando si es necesario.
     */
    const ensureFresh = async () => {
      // Inicializar Worker si no está
      initWorker();
      
      // Cargar desde almacenamiento si no hay cache en memoria
      if (!cache) {
        await loadFromStorage();
      }
      
      const data = getCache();
      
      // Verificar si necesitamos actualizar
      if (!data || isStale(data) || (expectedVersion && data.version && data.version !== expectedVersion)) {
        return fetchLatest();
      }
      
      // Cargar datos en Worker si hay cache pero Worker no tiene datos
      if (data?.parts && worker && workerReady) {
        sendToWorker('LOAD', {
          parts: data.parts,
          version: data.version
        }).catch(() => {});
      }
      
      return Promise.resolve(data);
    };

    /**
     * Búsqueda de piezas - usa Worker si disponible, sino fallback local.
     */
    const search = async (term, limit = SEARCH_MAX_RESULTS) => {
      // Intentar búsqueda con Worker (O(1) con índice invertido)
      if (useWorker && worker && workerReady) {
        try {
          const results = await sendToWorker('SEARCH', { term, limit });
          return results;
        } catch (error) {
          console.warn('[CatalogCache] Worker search failed, usando fallback:', error);
        }
      }
      
      // Fallback: búsqueda local O(n)
      return searchLocal(term, limit);
    };

    /**
     * Búsqueda local (fallback sin Worker).
     */
    const searchLocal = (term, limit = SEARCH_MAX_RESULTS) => {
      const data = getCache();
      if (!data?.parts?.length) return [];
      
      const normalized = normalizeForSearch(term).trim();
      if (!normalized) {
        return data.parts.slice(0, limit);
      }
      
      const stripped = normalized.replace(/\s+/g, '');
      const tokens = normalized.split(/\s+/).filter(Boolean);
      const results = [];
      
      for (let i = 0; i < data.parts.length; i++) {
        const part = data.parts[i];
        let score = 0;
        
        // Coincidencia por código de barras
        if (part._barcode && stripped && part._barcode.startsWith(stripped)) {
          score += 10;
        }
        
        // Coincidencia completa
        if (part._normalized && part._normalized.includes(normalized)) {
          score += 6;
        } else if (tokens.length > 0) {
          // Coincidencia por tokens
          let hits = 0;
          for (const tok of tokens) {
            if (part._normalized && part._normalized.includes(tok)) {
              hits++;
            }
          }
          score += hits;
        }
        
        if (score > 0) {
          results.push({ part, score });
        }
      }
      
      results.sort((a, b) => (b.score - a.score) || (a.part.id - b.part.id));
      return results.slice(0, limit).map((entry) => entry.part);
    };

    /**
     * Limpia todo el cache.
     */
    const clear = async () => {
      cache = null;
      fetchPromise = null;
      
      // Limpiar Worker
      if (worker) {
        sendToWorker('CLEAR', {}).catch(() => {});
      }
      
      // Limpiar IndexedDB
      if (window.CatalogDB) {
        await window.CatalogDB.clear().catch(() => {});
      }
      
      // Limpiar localStorage
      try {
        localStorage.removeItem(STORAGE_KEY);
        localStorage.removeItem(LEGACY_STORAGE_KEY);
      } catch (_err) {
        /* ignore */
      }
    };

    return {
      setUrl(url) {
        catalogUrl = url;
      },
      setExpectedVersion(version) {
        expectedVersion = version || null;
      },
      ensureFresh,
      search,
      searchLocal,
      clear,
      isReady() {
        return Boolean(getCache()?.parts?.length);
      },
      getCount() {
        return getCache()?.parts?.length || 0;
      },
      updateEntry,
      getEntry(partId) {
        const data = getCache();
        if (!data?.parts) return null;
        return data.parts.find((item) => String(item.id) === String(partId)) || null;
      },
      // Métodos adicionales para debugging
      getWorkerStatus() {
        return { 
          available: useWorker && Boolean(worker), 
          ready: workerReady 
        };
      }
    };
  })();

  function initPersistScroll() {
    if (window.__partsScrollInit) return;
    window.__partsScrollInit = true;
    const SCROLL_KEY = 'parts:view:scroll';
    const ROW_KEY = 'parts:view:row';

    function saveState(rowId) {
      try {
        sessionStorage.setItem(SCROLL_KEY, String(window.scrollY || 0));
        if (rowId) {
          sessionStorage.setItem(ROW_KEY, rowId);
        }
      } catch (_) {
        /* ignore quota errors */
      }
    }

    function restoreState() {
      let rowId = null;
      let scrollY = null;
      try {
        rowId = sessionStorage.getItem(ROW_KEY);
        scrollY = sessionStorage.getItem(SCROLL_KEY);
      } catch (_) {
        /* ignore */
      }

      if (rowId) {
        const row = document.querySelector('[data-part-id="' + rowId + '"]');
        if (row) {
          row.scrollIntoView({ behavior: 'auto', block: 'center' });
          row.classList.add('recent-focus');
          setTimeout(() => row.classList.remove('recent-focus'), 1500);
          sessionStorage.removeItem(ROW_KEY);
          sessionStorage.removeItem(SCROLL_KEY);
          return;
        }
      }

      if (scrollY) {
        window.scrollTo({ top: parseInt(scrollY, 10) || 0, behavior: 'auto' });
        sessionStorage.removeItem(SCROLL_KEY);
      }
    }

    window.addEventListener('beforeunload', () => saveState());
    document.addEventListener('turbo:before-visit', () => saveState());
    document.addEventListener('click', (event) => {
      const link = event.target.closest('a[data-turbo-frame], a[href], button[data-turbo-frame]');
      if (!link) return;
      const row = event.target.closest('[data-part-id]');
      const rowId = row ? row.dataset.partId : null;
      saveState(rowId);
    });

    document.addEventListener('DOMContentLoaded', restoreState, { once: true });
    document.addEventListener('turbo:load', restoreState, { once: true });
  }

  function initPartListFilters() {
    const filterForm = document.getElementById('parts-filter-form');
    if (!filterForm) return;

    // Hidden inputs que guardan los valores seleccionados
    const modelHidden = document.getElementById('filter-model');
    const yearHidden = document.getElementById('filter-year');
    
    // Inputs visibles para búsqueda
    const modelInput = document.getElementById('filter-model-input');
    const yearInput = document.getElementById('filter-year-input');
    
    // Containers de resultados
    const modelResults = document.getElementById('filter-model-results');
    const yearResults = document.getElementById('filter-year-results');

    const FILTER_SUGGEST_URL = '/parts/api/filter/suggest/';
    const DEBOUNCE_MS = 150;
    
    let modelAbortController = null;
    let yearAbortController = null;
    let activeIndex = -1;

    const submitFilters = (reason) => {
      // Capturar valores AHORA antes de que Turbo pueda reemplazar el DOM
      const modeloVal = modelHidden ? modelHidden.value : '';
      const anioVal = yearHidden ? yearHidden.value : '';
      
      // Obtener otros campos del form
      const formData = new FormData(filterForm);
      const params = new URLSearchParams();
      
      // Agregar campos del form excepto modelo y anio (los ponemos explícitamente)
      for (const [key, value] of formData.entries()) {
        if (key !== 'modelo' && key !== 'anio') {
          params.set(key, value);
        }
      }
      
      // Agregar modelo y año con los valores capturados
      params.set('modelo', modeloVal);
      params.set('anio', anioVal);
      
      // Construir URL completa
      const baseUrl = filterForm.action || '/parts/';
      const fullUrl = `${baseUrl}?${params.toString()}`;
      
      console.log('[FilterSubmit] Razón:', reason, {
        modelo: modeloVal,
        anio: anioVal,
        fullUrl: fullUrl
      });
      
      // Usar Turbo.visit con frame específico para evitar race conditions
      if (window.Turbo && typeof window.Turbo.visit === 'function') {
        window.Turbo.visit(fullUrl, { frame: 'app-frame' });
      } else {
        // Fallback: navegar directamente
        window.location.href = fullUrl;
      }
    };

    // Función para escapar HTML
    const escapeHtml = (text) => {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    };

    // Resaltar coincidencia en el texto
    const highlightMatch = (text, query) => {
      if (!query) return escapeHtml(text);
      const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`(${escapedQuery})`, 'gi');
      return escapeHtml(text).replace(regex, '<mark>$1</mark>');
    };

    // Crear un autocompletado genérico
    const setupAutocomplete = (input, hidden, resultsContainer, filterType) => {
      if (!input || !hidden || !resultsContainer) return;
      if (input.dataset.autocompleteInit) return;
      input.dataset.autocompleteInit = 'true';

      let abortController = null;
      let debounceTimer = null;
      let currentIndex = -1;

      const showResults = () => resultsContainer.classList.remove('d-none');
      const hideResults = () => {
        resultsContainer.classList.add('d-none');
        currentIndex = -1;
      };

      const fetchSuggestions = async (query) => {
        // Cancelar búsqueda anterior
        if (abortController) abortController.abort();
        abortController = new AbortController();

        // Construir URL con parámetros
        const params = new URLSearchParams({ type: filterType, q: query });
        
        // Si es búsqueda de años y hay modelo seleccionado, incluirlo
        if (filterType === 'year' && modelHidden && modelHidden.value) {
          params.append('model', modelHidden.value);
        }

        try {
          resultsContainer.innerHTML = `
            <div class="filter-autocomplete-loading">
              <i class="fas fa-spinner"></i> Buscando...
            </div>`;
          showResults();

          const response = await fetch(`${FILTER_SUGGEST_URL}?${params}`, {
            signal: abortController.signal,
            headers: { 'Accept': 'application/json' }
          });

          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          
          const data = await response.json();
          renderSuggestions(data.suggestions || [], query);
          
        } catch (error) {
          if (error.name === 'AbortError') return;
          console.warn('[FilterAutocomplete] Error:', error);
          resultsContainer.innerHTML = `
            <div class="filter-autocomplete-empty">
              <i class="fas fa-exclamation-triangle text-warning"></i> Error de conexión
            </div>`;
        }
      };

      const renderSuggestions = (suggestions, query) => {
        if (!suggestions.length) {
          resultsContainer.innerHTML = `
            <div class="filter-autocomplete-empty">
              No se encontraron resultados para "${escapeHtml(query)}"
            </div>`;
          showResults();
          return;
        }

        resultsContainer.innerHTML = suggestions.map((item, idx) => `
          <div class="filter-autocomplete-item${idx === 0 ? ' active' : ''}" 
               data-value="${escapeHtml(item)}" 
               data-index="${idx}"
               tabindex="-1">
            ${highlightMatch(item, query)}
          </div>
        `).join('');
        
        currentIndex = 0;
        showResults();

        // Event listeners para los items
        resultsContainer.querySelectorAll('.filter-autocomplete-item').forEach((item) => {
          item.addEventListener('click', () => selectItem(item.dataset.value));
          item.addEventListener('mouseenter', () => {
            setActiveItem(parseInt(item.dataset.index, 10));
          });
        });
      };

      const selectItem = (value) => {
        input.value = value;
        hidden.value = value;
        hideResults();
        
        // Si es modelo, limpiar año ya que cambiaron los disponibles
        if (filterType === 'model' && yearInput && yearHidden) {
          yearInput.value = '';
          yearHidden.value = '';
        }
        
        // Submit automático al seleccionar
        submitFilters('autocomplete-select-' + filterType);
      };

      const setActiveItem = (index) => {
        const items = resultsContainer.querySelectorAll('.filter-autocomplete-item');
        items.forEach((item, idx) => {
          item.classList.toggle('active', idx === index);
        });
        currentIndex = index;
      };

      // Debounced search
      const debouncedSearch = (query) => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          if (query.length >= 1) {
            fetchSuggestions(query);
          } else {
            // Si está vacío, mostrar todos (sin filtro de query)
            fetchSuggestions('');
          }
        }, DEBOUNCE_MS);
      };

      // Input events
      input.addEventListener('input', () => {
        debouncedSearch(input.value.trim());
      });

      input.addEventListener('focus', () => {
        // Mostrar sugerencias al enfocar (incluso vacío = todos)
        fetchSuggestions(input.value.trim());
      });

      input.addEventListener('blur', () => {
        // Delay para permitir click en resultados
        setTimeout(() => {
          hideResults();
          // Si el input no coincide con el hidden, revertir
          if (input.value !== hidden.value) {
            input.value = hidden.value;
          }
        }, 200);
      });

      // Keyboard navigation
      input.addEventListener('keydown', (event) => {
        const items = resultsContainer.querySelectorAll('.filter-autocomplete-item');
        const isVisible = !resultsContainer.classList.contains('d-none');

        if (!isVisible || !items.length) {
          if (event.key === 'Enter') {
            event.preventDefault();
            submitFilters('enter-key-no-results');
          }
          return;
        }

        switch (event.key) {
          case 'ArrowDown':
            event.preventDefault();
            setActiveItem(Math.min(currentIndex + 1, items.length - 1));
            items[currentIndex]?.scrollIntoView({ block: 'nearest' });
            break;
          case 'ArrowUp':
            event.preventDefault();
            setActiveItem(Math.max(currentIndex - 1, 0));
            items[currentIndex]?.scrollIntoView({ block: 'nearest' });
            break;
          case 'Enter':
            event.preventDefault();
            if (currentIndex >= 0 && items[currentIndex]) {
              selectItem(items[currentIndex].dataset.value);
            }
            break;
          case 'Escape':
            hideResults();
            input.value = hidden.value;
            break;
          case 'Tab':
            hideResults();
            break;
        }
      });
    };

    // Inicializar autocompletados
    setupAutocomplete(modelInput, modelHidden, modelResults, 'model');
    setupAutocomplete(yearInput, yearHidden, yearResults, 'year');

    // Botones de limpiar filtro
    document.querySelectorAll('[data-clear-filter]').forEach((btn) => {
      if (btn.dataset.clearFilterInit) return;
      btn.dataset.clearFilterInit = 'true';
      
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        const filterType = btn.dataset.clearFilter;
        
        if (filterType === 'model') {
          if (modelInput) modelInput.value = '';
          if (modelHidden) modelHidden.value = '';
          // También limpiar año si se limpia modelo
          if (yearInput) yearInput.value = '';
          if (yearHidden) yearHidden.value = '';
        } else if (filterType === 'year') {
          if (yearInput) yearInput.value = '';
          if (yearHidden) yearHidden.value = '';
        }
        
        submitFilters('clear-filter-btn-' + filterType);
      });
    });

    // Evento global de filtros limpiados
    document.addEventListener('parts:filters-cleared', () => {
      const target = window.location.pathname;
      const frame = document.getElementById('app-frame');
      if (frame) {
        frame.src = target;
      } else {
        window.location.href = target;
      }
    });

    if (typeof window.persistCollapsePanel === 'function') {
      window.persistCollapsePanel('parts-filter-panel', 'partsFiltersPanel', { mobileDefault: 'closed' });
    }
  }

  /**
   * Inicializa el autocompletado del buscador principal estilo MercadoLibre/Amazon
   * con miniaturas de imágenes y navegación por teclado.
   */
  function initSearchSuggestions() {
    const searchInput = document.getElementById('global-part-search');
    const dropdown = document.getElementById('search-suggestions-dropdown');
    const filterForm = document.getElementById('parts-filter-form');
    
    if (!searchInput || !dropdown) return;
    if (searchInput.dataset.searchSuggestionsInit) return;
    searchInput.dataset.searchSuggestionsInit = 'true';

    const SEARCH_SUGGEST_URL = '/parts/api/search/suggest/';
    const DEBOUNCE_MS = 200;
    const MIN_CHARS = 2;
    
    let abortController = null;
    let debounceTimer = null;
    let currentIndex = -1;
    let suggestions = [];

    // Helpers
    const escapeHtml = (text) => {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    };

    // Normalizar texto removiendo acentos para comparación
    const normalizeText = (text) => {
      return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    };

    // Resaltar coincidencias por cada palabra del query (case-insensitive, ignora acentos)
    const highlightMatch = (text, query) => {
      if (!query || !text) return escapeHtml(text || '');
      
      // Tokenizar el query en palabras (mínimo 2 caracteres)
      const tokens = query.trim().split(/\s+/).filter(t => t.length >= 2);
      if (!tokens.length) return escapeHtml(text);
      
      // Normalizar tokens para búsqueda
      const normalizedTokens = tokens.map(t => normalizeText(t));
      
      // Procesar caracter por caracter para resaltar correctamente
      // independiente del case o acentos
      const normalizedText = normalizeText(text);
      const chars = [...text];
      const normalizedChars = [...normalizedText];
      const highlights = new Array(chars.length).fill(false);
      
      // Para cada token, encontrar todas las ocurrencias en el texto normalizado
      normalizedTokens.forEach(normToken => {
        let searchStart = 0;
        while (searchStart < normalizedText.length) {
          const foundIndex = normalizedText.indexOf(normToken, searchStart);
          if (foundIndex === -1) break;
          
          // Marcar estos caracteres para resaltar
          for (let i = foundIndex; i < foundIndex + normToken.length && i < chars.length; i++) {
            highlights[i] = true;
          }
          searchStart = foundIndex + 1;
        }
      });
      
      // Construir resultado con resaltado
      let result = '';
      let inHighlight = false;
      
      for (let i = 0; i < chars.length; i++) {
        if (highlights[i] && !inHighlight) {
          result += '<mark>';
          inHighlight = true;
        } else if (!highlights[i] && inHighlight) {
          result += '</mark>';
          inHighlight = false;
        }
        result += escapeHtml(chars[i]);
      }
      
      if (inHighlight) result += '</mark>';
      
      return result;
    };

    const formatPrice = (value) => {
      if (!value || value === 0) return '';
      return new Intl.NumberFormat('es-CL', {
        style: 'currency',
        currency: 'CLP',
        minimumFractionDigits: 0
      }).format(value);
    };

    const getStatusClass = (status) => {
      switch (status) {
        case 'available': return 'available';
        case 'reserved': return 'reserved';
        case 'sold': return 'sold';
        default: return 'available';
      }
    };

    const getStatusText = (status) => {
      switch (status) {
        case 'available': return 'Disponible';
        case 'reserved': return 'Reservado';
        case 'sold': return 'Vendido';
        default: return 'Disponible';
      }
    };

    const showDropdown = () => dropdown.classList.remove('d-none');
    const hideDropdown = () => {
      dropdown.classList.add('d-none');
      currentIndex = -1;
    };

    const fetchSuggestions = async (query) => {
      if (abortController) abortController.abort();
      abortController = new AbortController();

      // Mostrar loading
      dropdown.innerHTML = `
        <div class="search-suggestions-loading">
          <i class="fas fa-spinner"></i>
          <div>Buscando...</div>
        </div>`;
      showDropdown();

      try {
        const params = new URLSearchParams({ q: query, limit: '10' });
        const response = await fetch(`${SEARCH_SUGGEST_URL}?${params}`, {
          signal: abortController.signal,
          headers: { 'Accept': 'application/json' }
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        
        const data = await response.json();
        suggestions = data.suggestions || [];
        renderSuggestions(suggestions, query, data.total_matches || 0);
        
      } catch (error) {
        if (error.name === 'AbortError') return;
        console.warn('[SearchSuggestions] Error:', error);
        dropdown.innerHTML = `
          <div class="search-suggestions-empty">
            <i class="fas fa-exclamation-triangle text-warning"></i>
            <div>Error de conexión</div>
          </div>`;
      }
    };

    const renderSuggestions = (items, query, totalMatches) => {
      if (!items.length) {
        dropdown.innerHTML = `
          <div class="search-suggestions-empty">
            <i class="fas fa-search"></i>
            <div>No se encontraron resultados para "<strong>${escapeHtml(query)}</strong>"</div>
          </div>`;
        showDropdown();
        return;
      }

      const header = `
        <div class="search-suggestions-header">
          <i class="fas fa-lightbulb me-1"></i>
          ${items.length} de ${totalMatches} resultados
        </div>`;

      const itemsHtml = items.map((item, idx) => {
        const imageHtml = item.image_url 
          ? `<img src="${escapeHtml(item.image_url)}" alt="" loading="lazy">`
          : `<i class="fas fa-cube placeholder-icon"></i>`;
        
        const priceHtml = item.min_value 
          ? `<span class="search-suggestion-price">${formatPrice(item.min_value)}</span>` 
          : '';
        
        // Construir texto de auto con año y resaltar coincidencias
        const autoText = item.auto 
          ? `${item.auto}${item.year ? ' ' + item.year : ''}` 
          : '';
        const autoHtml = autoText ? highlightMatch(autoText, query) : '';

        return `
          <div class="search-suggestion-item${idx === 0 ? ' active' : ''}" 
               data-index="${idx}"
               data-part-id="${item.id}"
               role="option"
               tabindex="-1">
            <div class="search-suggestion-thumb">
              ${imageHtml}
            </div>
            <div class="search-suggestion-content">
              <div class="search-suggestion-name">${highlightMatch(item.name, query)}</div>
              ${autoHtml ? `<div class="search-suggestion-auto"><i class="fas fa-car me-1"></i>${autoHtml}</div>` : ''}
              <div class="search-suggestion-meta">
                ${priceHtml}
                <span class="search-suggestion-status ${getStatusClass(item.status)}">${getStatusText(item.status)}</span>
              </div>
            </div>
          </div>`;
      }).join('');

      const footer = totalMatches > items.length ? `
        <div class="search-suggestions-footer">
          <a href="#" data-search-all="true">
            <i class="fas fa-arrow-right me-1"></i>Ver todos los ${totalMatches} resultados
          </a>
        </div>` : '';

      dropdown.innerHTML = header + itemsHtml + footer;
      currentIndex = 0;
      showDropdown();

      // Event listeners para items
      dropdown.querySelectorAll('.search-suggestion-item').forEach((item) => {
        item.addEventListener('click', () => selectSuggestion(parseInt(item.dataset.index, 10)));
        item.addEventListener('mouseenter', () => setActiveItem(parseInt(item.dataset.index, 10)));
      });

      // "Ver todos" link
      const viewAllLink = dropdown.querySelector('[data-search-all]');
      if (viewAllLink) {
        viewAllLink.addEventListener('click', (e) => {
          e.preventDefault();
          submitSearch();
        });
      }
    };

    const selectSuggestion = (index) => {
      const item = suggestions[index];
      if (!item) return;
      
      // Navegar directamente a la pieza
      const partUrl = `/parts/${item.id}/`;
      hideDropdown();
      
      if (window.Turbo && typeof window.Turbo.visit === 'function') {
        window.Turbo.visit(partUrl, { frame: 'app-frame' });
      } else {
        window.location.href = partUrl;
      }
    };

    const submitSearch = () => {
      hideDropdown();
      if (filterForm) {
        // Usar Turbo.visit como en los filtros
        const formData = new FormData(filterForm);
        const params = new URLSearchParams();
        for (const [key, value] of formData.entries()) {
          params.set(key, value);
        }
        const fullUrl = `${filterForm.action || '/parts/'}?${params.toString()}`;
        
        if (window.Turbo && typeof window.Turbo.visit === 'function') {
          window.Turbo.visit(fullUrl, { frame: 'app-frame' });
        } else {
          window.location.href = fullUrl;
        }
      }
    };

    const setActiveItem = (index) => {
      const items = dropdown.querySelectorAll('.search-suggestion-item');
      items.forEach((item, idx) => {
        item.classList.toggle('active', idx === index);
      });
      currentIndex = index;
    };

    // Debounced search
    const debouncedSearch = (query) => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        if (query.length >= MIN_CHARS) {
          fetchSuggestions(query);
        } else {
          hideDropdown();
        }
      }, DEBOUNCE_MS);
    };

    // Input events
    searchInput.addEventListener('input', () => {
      debouncedSearch(searchInput.value.trim());
    });

    searchInput.addEventListener('focus', () => {
      const query = searchInput.value.trim();
      if (query.length >= MIN_CHARS) {
        fetchSuggestions(query);
      }
    });

    searchInput.addEventListener('blur', () => {
      // Delay para permitir click en sugerencias
      setTimeout(() => hideDropdown(), 200);
    });

    // Keyboard navigation
    searchInput.addEventListener('keydown', (event) => {
      const items = dropdown.querySelectorAll('.search-suggestion-item');
      const isVisible = !dropdown.classList.contains('d-none');

      if (!isVisible) {
        if (event.key === 'Enter') {
          event.preventDefault();
          submitSearch();
        }
        return;
      }

      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          if (items.length) {
            setActiveItem(Math.min(currentIndex + 1, items.length - 1));
            items[currentIndex]?.scrollIntoView({ block: 'nearest' });
          }
          break;
        case 'ArrowUp':
          event.preventDefault();
          if (items.length) {
            setActiveItem(Math.max(currentIndex - 1, 0));
            items[currentIndex]?.scrollIntoView({ block: 'nearest' });
          }
          break;
        case 'Enter':
          event.preventDefault();
          if (currentIndex >= 0 && suggestions[currentIndex]) {
            selectSuggestion(currentIndex);
          } else {
            submitSearch();
          }
          break;
        case 'Escape':
          hideDropdown();
          break;
        case 'Tab':
          hideDropdown();
          break;
      }
    });

    // Close dropdown when clicking outside
    document.addEventListener('click', (event) => {
      if (!searchInput.contains(event.target) && !dropdown.contains(event.target)) {
        hideDropdown();
      }
    });

    console.log('[SearchSuggestions] Inicializado');
  }

  function ensureVoiceSearchUtils() {
    if (window.VoiceSearchUtils) return window.VoiceSearchUtils;
    window.VoiceSearchUtils = (function () {
      const classList = ['text-muted', 'text-success', 'text-danger', 'text-warning', 'text-info'];
      function getStatusEl() {
        return document.getElementById('global-part-voice-status');
      }
      const readCsrfToken = () => {
        try {
          if (typeof window.getCsrfToken === 'function') {
            const value = window.getCsrfToken();
            if (value && value.length >= 32) {
              return value;
            }
          }
        } catch (_err) { /* ignore */ }
        return '';
      };
      return {
        setStatus(message, variant = 'muted') {
          const statusEl = getStatusEl();
          if (!statusEl) return;
          const span = statusEl.querySelector('span') || statusEl;
          span.textContent = message;
          classList.forEach((cls) => statusEl.classList.remove(cls));
          const map = {
            muted: 'text-muted',
            success: 'text-success',
            danger: 'text-danger',
            warning: 'text-warning',
            info: 'text-info'
          };
          statusEl.classList.add(map[variant] || 'text-muted');
        },
        getCsrfToken() {
          return readCsrfToken();
        },
        buildCsrfHeaders(base = {}) {
          const headers = { ...base };
          if (!headers.Accept) {
            headers.Accept = 'application/json';
          }
          const token = readCsrfToken();
          if (token) {
            headers['X-CSRFToken'] = token;
          }
          return headers;
        }
      };
    })();
    return window.VoiceSearchUtils;
  }

  /**
   * Envía el formulario de búsqueda.
   * @param {HTMLInputElement} searchInput - Campo de búsqueda
   */
  function submitSearchInput(searchInput) {
    if (!searchInput) return;
    const form = searchInput.form;
    if (form) {
      if (typeof form.requestSubmit === 'function') {
        form.requestSubmit();
      } else {
        form.submit();
      }
      return;
    }
    const params = new URLSearchParams(window.location.search);
    const value = (searchInput.value || '').trim();
    if (value) {
      params.set('q', value);
    } else {
      params.delete('q');
    }
    params.delete('page');
    const query = params.toString();
    const url = query ? `${window.location.pathname}?${query}` : window.location.pathname;
    const frame = document.getElementById('app-frame');
    if (frame) {
      frame.src = url;
    } else {
      window.location.href = url;
    }
  }

  /**
   * Escapa atributos HTML.
   * @param {*} value - Valor a escapar
   * @returns {string} Atributo seguro
   */
  function escapeAttribute(value) {
    return escapeHtml(value).replace(/"/g, '&quot;');
  }

  function parseJsonScript(id) {
    const node = document.getElementById(id);
    if (!node) return [];
    try {
      return JSON.parse(node.textContent) || [];
    } catch (_err) {
      return [];
    }
  }

  const MODEL_OPTIONS = parseJsonScript('parts-model-options');
  const YEAR_OPTIONS = parseJsonScript('parts-year-options');
  const currencyFormatter = (typeof Intl !== 'undefined' && Intl.NumberFormat)
    ? new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP', maximumFractionDigits: 0 })
    : null;

  function formatCurrencyCL(value) {
    if (value === null || value === undefined || value === '') return '-';
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return String(value);
    return currencyFormatter ? currencyFormatter.format(numeric) : `$${Math.round(numeric)}`;
  }

  function formatShortDate(isoText) {
    if (!isoText) return '-';
    try {
      const date = new Date(isoText);
      if (Number.isNaN(date.getTime())) return '-';
      return date.toLocaleDateString('es-CL', { day: '2-digit', month: 'short', year: 'numeric' });
    } catch (_err) {
      return isoText;
    }
  }

  const QUICK_EDIT_FIELDS = {
    name: { type: 'text', label: 'Nombre de la pieza' },
    auto_brand_model: {
      type: 'text',
      label: 'Vehículo',
      datalist: 'available-model-options',
      placeholder: 'Modelo / versión'
    },
    auto_year: {
      type: 'number',
      label: 'Año del vehículo',
      datalist: 'available-year-options',
      min: 1950,
      max: 2100
    },
    date_added: { type: 'date', label: 'Fecha de ingreso' },
    max_value: { type: 'number', label: 'Valor inicial', step: 1000 },
    min_value: { type: 'number', label: 'Valor final', step: 1000 }
  };

  function initCatalogSearch() {
    const meta = document.getElementById('parts-live-meta');
    const searchInput = document.getElementById('global-part-search');
    const quickContainer = document.getElementById('catalog-quick-results');
    const statusEl = document.getElementById('catalog-cache-status');
    if (!meta || !searchInput || !quickContainer || !statusEl) return;
    
    // URL del nuevo endpoint de sugerencias (estilo MercadoLibre/Amazon)
    const suggestUrl = '/parts/api/search/suggest/';
    
    const updateStatus = (text, variant = 'muted') => {
      const map = {
        success: 'text-success',
        danger: 'text-danger',
        warning: 'text-warning',
        info: 'text-info',
        muted: 'text-muted'
      };
      statusEl.textContent = text;
      statusEl.className = `catalog-cache-status ${map[variant] || 'text-muted'}`;
    };

    // Mostrar estado inicial
    updateStatus('Búsqueda en tiempo real activa', 'success');

    let hideTimer = null;

    const hideResults = () => {
      quickContainer.classList.add('d-none');
      quickContainer.innerHTML = '';
    };

    const quickEditState = {
      modal: document.getElementById('quickEditModal'),
      question: document.getElementById('quick-edit-question'),
      wrapper: document.getElementById('quick-edit-input-wrapper'),
      confirmBtn: document.getElementById('quick-edit-confirm-btn'),
      bsModal: null,
      cell: null,
      partId: null,
      field: null,
      originalValue: '',
      inputEl: null
    };

    if (quickEditState.modal && window.bootstrap) {
      quickEditState.bsModal = new window.bootstrap.Modal(quickEditState.modal);
    }

    const formatQuickDisplay = (field, value) => {
      if (field === 'date_added') return formatShortDate(value);
      if (field === 'max_value' || field === 'min_value') return formatCurrencyCL(value);
      if (field === 'auto_year') return value || '-';
      if (field === 'auto_brand_model') return value || 'Sin vehículo';
      return value || '-';
    };

    const setConfirmLoading = (state) => {
      if (!quickEditState.confirmBtn) return;
      quickEditState.confirmBtn.disabled = state;
      quickEditState.confirmBtn.classList.toggle('disabled', state);
    };

    const closeQuickEdit = () => {
      setConfirmLoading(false);
      quickEditState.bsModal?.hide();
      quickEditState.inputEl = null;
      quickEditState.cell = null;
    };

    const updateLocalQuickRow = (partId, field, rawValue) => {
      // Con búsqueda en servidor, no necesitamos actualizar cache local
      // La próxima búsqueda traerá datos frescos del servidor
    };

    const submitQuickEdit = () => {
      if (!quickEditState.cell || !quickEditState.partId || !quickEditState.inputEl) return;
      const newValue = quickEditState.inputEl.value;
      if (newValue === quickEditState.originalValue) {
        closeQuickEdit();
        return;
      }
      setConfirmLoading(true);
      fetch(`/parts/${quickEditState.partId}/update-field/`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
          'X-CSRFToken': (window.getCsrfToken && window.getCsrfToken()) || document.querySelector('input[name=csrfmiddlewaretoken]')?.value || ''
        },
        body: JSON.stringify({ field: quickEditState.field, value: newValue })
      })
        .then((resp) => resp.json())
        .then((data) => {
          if (!data?.success) throw new Error(data?.error || 'No se pudo guardar');
          const updatedValue = data.value ?? newValue;
          const display = formatQuickDisplay(quickEditState.field, updatedValue);
          quickEditState.cell.textContent = display;
          quickEditState.cell.dataset.value = updatedValue;
          updateLocalQuickRow(quickEditState.partId, quickEditState.field, updatedValue);
          const row = quickEditState.cell.closest('.catalog-quick-results__row');
          if (row && quickEditState.field === 'name') {
            const preferredRaw = row.dataset.preferred || '';
            if (!preferredRaw || preferredRaw === quickEditState.originalValue) {
              row.dataset.preferred = updatedValue;
            }
          }
          window.showToast?.({
            title: 'Inventario',
            body: 'Cambios aplicados correctamente.',
            variant: 'success'
          });
          closeQuickEdit();
        })
        .catch((err) => {
          setConfirmLoading(false);
          window.showToast?.({
            title: 'Inventario',
            body: err?.message || 'No se pudo actualizar el campo.',
            variant: 'danger'
          });
        });
    };

    if (quickEditState.confirmBtn && !quickEditState.confirmBtn.dataset.bound) {
      quickEditState.confirmBtn.dataset.bound = 'true';
      quickEditState.confirmBtn.addEventListener('click', submitQuickEdit);
    }

    const openQuickEdit = (cell) => {
      const field = cell?.dataset?.field;
      if (!field || !QUICK_EDIT_FIELDS[field]) {
        window.showToast?.({
          title: 'Inventario',
          body: 'Este campo no admite edición rápida.',
          variant: 'warning'
        });
        return;
      }
      const row = cell.closest('.catalog-quick-results__row');
      if (!row) return;
      quickEditState.cell = cell;
      quickEditState.partId = row.dataset.partId;
      quickEditState.field = field;
      quickEditState.originalValue = cell.dataset.value || cell.textContent.trim();
      const config = QUICK_EDIT_FIELDS[field];
      if (quickEditState.question) {
        const previous = quickEditState.originalValue || 'sin dato';
        quickEditState.question.innerHTML = `Cambiar <strong>${escapeHtml(config.label || cell.dataset.label || field)}</strong> de <em>${escapeHtml(previous)}</em> a:`;
      }
      if (quickEditState.wrapper) {
        quickEditState.wrapper.innerHTML = '';
        let input;
        if (config.type === 'textarea') {
          input = document.createElement('textarea');
          input.rows = 4;
        } else {
          input = document.createElement('input');
          input.type = config.type || 'text';
          if (config.type === 'number' && config.step) input.step = config.step;
          if (config.min) input.min = config.min;
          if (config.max) input.max = config.max;
        }
        input.className = 'form-control quick-edit-modal-input';
        if (config.placeholder) input.placeholder = config.placeholder;
        if (config.datalist) input.setAttribute('list', config.datalist);
        input.value = quickEditState.originalValue || '';
        quickEditState.wrapper.appendChild(input);
        quickEditState.inputEl = input;
        input.focus();
        input.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' && config.type !== 'textarea') {
            event.preventDefault();
            submitQuickEdit();
          }
        }, { once: true });
      }
      quickEditState.bsModal?.show();
    };

    const attachQuickEditableHandlers = () => {
      const cells = quickContainer.querySelectorAll('.quick-editable');
      cells.forEach((cell) => {
        if (cell.dataset.quickEditBound === 'true') return;
        cell.dataset.quickEditBound = 'true';
        cell.addEventListener('dblclick', (event) => {
          event.stopPropagation();
          openQuickEdit(cell);
        });
        cell.addEventListener('click', (event) => {
          event.stopPropagation();
          const now = Date.now();
          const lastTap = Number(cell.dataset.lastTap || '0');
          if (now - lastTap < 350) {
            openQuickEdit(cell);
          }
          cell.dataset.lastTap = String(now);
        });
      });
    };

    const renderResults = (items) => {
      if (!items || !items.length) {
        quickContainer.innerHTML = `
          <div class="catalog-quick-results__empty">
            <i class="bi bi-search me-2"></i>Sin coincidencias en vista previa.
            <br><small class="text-muted">Presiona <kbd>Enter</kbd> para buscar en todo el inventario.</small>
          </div>`;
        quickContainer.classList.remove('d-none');
        return;
      }
      const rows = items.map((item) => {
        const preferred = escapeAttribute(item.barcode || item.name || '');
        const name = escapeHtml(item.name || 'Sin nombre');
        const vehicle = escapeHtml(item.auto || 'Sin vehículo');
        const year = escapeHtml(item.auto_year || '');
        return `
          <tr class="catalog-quick-results__row"
              data-part-id="${item.id}"
              data-preferred="${preferred}"
              tabindex="0"
              role="button">
            <td>
              <span class="quick-result-name quick-editable"
                    data-field="name"
                    data-label="Nombre de la pieza"
                    data-value="${escapeAttribute(item.name || '')}">
                ${name}
              </span>
              <div class="text-muted small">${escapeHtml(item.workshop || '')}</div>
            </td>
            <td>
              <div class="quick-result-vehicle">
                <span class="quick-editable"
                      data-field="auto_brand_model"
                      data-label="Vehículo"
                      data-value="${escapeAttribute(item.auto || '')}">
                  ${vehicle || 'Sin vehículo'}
                </span>
                <span class="quick-editable quick-result-year"
                      data-field="auto_year"
                      data-label="Año del vehículo"
                      data-value="${escapeAttribute(item.auto_year || '')}">
                  ${year || '-'}
                </span>
              </div>
            </td>
            <td>
              <span class="quick-editable"
                    data-field="date_added"
                    data-label="Fecha de ingreso"
                    data-value="${escapeAttribute(item.date_added || '')}">
                ${formatShortDate(item.date_added)}
              </span>
            </td>
            <td>
              <div class="quick-result-prices">
                <small>Inicial</small>
                <span class="quick-editable"
                      data-field="max_value"
                      data-label="Valor inicial"
                      data-value="${escapeAttribute(item.max_value ?? '')}">
                  ${formatCurrencyCL(item.max_value)}
                </span>
              </div>
            </td>
            <td>
              <div class="quick-result-prices">
                <small>Final</small>
                <span class="quick-editable"
                      data-field="min_value"
                      data-label="Valor final"
                      data-value="${escapeAttribute(item.min_value ?? '')}">
                  ${formatCurrencyCL(item.min_value)}
                </span>
              </div>
            </td>
          </tr>
        `;
      }).join('');

      quickContainer.innerHTML = `
        <table class="catalog-quick-results-table">
          <thead>
            <tr>
              <th>Pieza</th>
              <th>Vehículo</th>
              <th>Ingreso</th>
              <th>Precio inicial</th>
              <th>Precio oferta</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      `;
      quickContainer.classList.remove('d-none');
      attachQuickEditableHandlers();
    };

    const clearHideTimer = () => {
      if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = null;
      }
    };

    const handleQuickRowSelection = (row) => {
      if (!row) return;
      clearHideTimer();
      const preferred = row.dataset.preferred || row.querySelector('.quick-result-name')?.textContent || '';
      if (preferred) {
        searchInput.value = preferred;
        submitSearchInput(searchInput);
      }
      hideResults();
    };

    /**
     * Estado de búsqueda para cancelar búsquedas obsoletas.
     */
    let currentSearchId = 0;
    let isSearching = false;
    let abortController = null;

    /**
     * Ejecuta búsqueda en el servidor estilo MercadoLibre/Amazon.
     * Usa fetch con AbortController para cancelar búsquedas obsoletas.
     * Respuesta típica: <100ms para sugerencias instantáneas.
     */
    const runServerSearch = async () => {
      const term = searchInput.value || '';
      if (!term.trim()) {
        hideResults();
        return;
      }

      // Cancelar búsqueda anterior si existe
      if (abortController) {
        abortController.abort();
      }
      abortController = new AbortController();
      
      // Incrementar ID para tracking
      const searchId = ++currentSearchId;
      isSearching = true;

      try {
        const response = await fetch(
          `${suggestUrl}?q=${encodeURIComponent(term)}&limit=${SEARCH_MAX_RESULTS}`,
          { 
            signal: abortController.signal,
            headers: { 'Accept': 'application/json' }
          }
        );
        
        // Verificar si esta búsqueda sigue siendo válida
        if (searchId !== currentSearchId) {
          return;
        }
        
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        
        const data = await response.json();
        
        // Mapear respuesta del servidor al formato esperado por renderResults
        const matches = (data.suggestions || []).map(item => ({
          id: item.id,
          name: item.name,
          barcode: item.barcode,
          auto: item.auto,
          auto_year: item.year,
          workshop: item.workshop,
          min_value: item.min_value,
          max_value: item.max_value
        }));
        
        renderResults(matches);
        
        // Debug opcional: mostrar tiempo de respuesta
        if (data.response_time_ms) {
          console.debug(`[Search] "${term}" → ${matches.length} resultados en ${data.response_time_ms}ms`);
        }
        
      } catch (error) {
        if (error.name === 'AbortError') {
          // Búsqueda cancelada - normal
          return;
        }
        console.warn('[CatalogSearch] Error en búsqueda servidor:', error);
        // Mostrar mensaje de error temporal
        if (searchId === currentSearchId) {
          quickContainer.innerHTML = `
            <div class="text-warning text-center p-2">
              <small><i class="fas fa-exclamation-triangle"></i> Error de conexión</small>
            </div>`;
          quickContainer.classList.remove('d-none');
        }
      } finally {
        if (searchId === currentSearchId) {
          isSearching = false;
        }
      }
    };

    /**
     * Búsqueda con debounce para evitar llamadas excesivas al servidor.
     * 200ms es el balance óptimo para búsqueda en servidor (un poco más que local).
     */
    const debouncedSearch = debounce(runServerSearch, SEARCH_DEBOUNCE_MS);

    searchInput.addEventListener('input', () => {
      if (!searchInput.value.trim()) {
        hideResults();
        currentSearchId++; // Cancelar búsquedas pendientes
        if (abortController) {
          abortController.abort();
          abortController = null;
        }
        return;
      }
      // Usar búsqueda con debounce al servidor
      debouncedSearch();
    });

    searchInput.addEventListener('focus', () => {
      clearHideTimer();
      if (searchInput.value.trim()) {
        runServerSearch();
      }
    });

    searchInput.addEventListener('blur', () => {
      hideTimer = setTimeout(hideResults, 120);
    });

    searchInput.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        hideResults();
      }
    });

    quickContainer.addEventListener('click', (event) => {
      if (event.target.closest('.quick-editable')) return;
      const row = event.target.closest('.catalog-quick-results__row');
      if (!row) return;
      event.preventDefault();
      handleQuickRowSelection(row);
    });

    quickContainer.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      const row = event.target.closest('.catalog-quick-results__row');
      if (!row) return;
      event.preventDefault();
      handleQuickRowSelection(row);
    });
    document.querySelectorAll('a[href$="/logout/"]').forEach((link) => {
      link.addEventListener('click', () => {
        // Con búsqueda en servidor, no hay cache local que limpiar
      });
    });

    document.addEventListener('turbo:before-visit', (event) => {
      const url = event?.detail?.url || '';
      if (/\/logout\/?$/.test(url)) {
        // Con búsqueda en servidor, no hay cache local que limpiar
      }
    });
  }

  function initVoiceSearch() {
    const voiceBtn = document.getElementById('global-part-voice-btn');
    const searchInput = document.getElementById('global-part-search');
    if (!voiceBtn || !searchInput || !navigator.mediaDevices) return;
    if (voiceBtn.dataset.voiceInit === 'true') return;
    voiceBtn.dataset.voiceInit = 'true';

    const VoiceSearchUtils = ensureVoiceSearchUtils();
    const AUDIO_MIME_CANDIDATES = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4;codecs=mp4a.40.2',
      'audio/mp4',
      'audio/mpeg'
    ];
    const DEFAULT_AUDIO_MIME = 'audio/webm';

    const pickSupportedMimeType = () => {
      if (!window.MediaRecorder || typeof window.MediaRecorder.isTypeSupported !== 'function') {
        return null;
      }
      for (const mime of AUDIO_MIME_CANDIDATES) {
        try {
          if (window.MediaRecorder.isTypeSupported(mime)) {
            return mime;
          }
        } catch (_err) {
          /* ignore and continue */
        }
      }
      return null;
    };

    const guessExtension = (mime) => {
      if (!mime) return 'webm';
      if (mime.includes('mp4')) return 'mp4';
      if (mime.includes('mpeg')) return 'mp3';
      if (mime.includes('ogg')) return 'ogg';
      return mime.includes('webm') ? 'webm' : 'webm';
    };
    const icon = document.getElementById('voice-search-btn-icon') || voiceBtn.querySelector('i');
    const label = document.getElementById('voice-search-mode-label');

    // --- HYBRID / OPENAI CONTROLLER ---
    const hybridState = {
      recorder: null,
      stream: null,
      chunks: [],
      timeoutId: null,
      shouldUpload: false,
      recording: false,
      mimeType: null
    };

    const setHybridIcon = (mode) => {
      if (!icon) return;
      icon.classList.remove('fa-wave-square', 'fa-stop', 'fa-spinner', 'fa-microphone', 'fa-spin');
      if (mode === 'stop') {
        icon.classList.add('fa-stop');
      } else if (mode === 'loading') {
        icon.classList.add('fa-spinner', 'fa-spin');
      } else if (mode === 'hybrid') {
        icon.classList.add('fa-wave-square');
      } else {
        icon.classList.add(window.isHybridMode && window.isHybridMode() ? 'fa-wave-square' : 'fa-microphone');
      }
    };

    const cleanupHybridStream = () => {
      if (hybridState.stream) {
        hybridState.stream.getTracks().forEach((track) => track.stop());
        hybridState.stream = null;
      }
      hybridState.mimeType = null;
      hybridState.recorder = null;
    };

    const finalizeHybrid = () => {
      cleanupHybridStream();
      voiceBtn.classList.remove('recording', 'loading');
      voiceBtn.disabled = false;
      setHybridIcon('idle');
    };

    const sendHybridAudio = (blob, fileName) => {
      voiceBtn.classList.add('loading');
      voiceBtn.disabled = true;
      setHybridIcon('loading');
      VoiceSearchUtils.setStatus('Transcribiendo con OpenAI...', 'info');
      const formData = new FormData();
      formData.append('audio', blob, fileName || 'openai-search.webm');
      fetch('/parts/voice-search/transcribe-openai/', {
        method: 'POST',
        headers: VoiceSearchUtils.buildCsrfHeaders(),
        credentials: 'same-origin',
        body: formData
      })
        .then(async (resp) => {
          if (resp.status === 403) {
            throw new Error('Sesión expirada. Recarga para continuar dictando.');
          }
          const data = await resp.json().catch(() => ({}));
          if (!resp.ok || !data?.success) {
            throw new Error(data?.error || 'OpenAI no devolvió resultados');
          }
          searchInput.value = data.transcript || data.normalized || '';
          submitSearchInput(searchInput);
          VoiceSearchUtils.setStatus(`Búsqueda: “${data.transcript}” (Nube)`, 'success');
        })
        .catch((err) => {
          console.error('openai-voice-search', err);
          VoiceSearchUtils.setStatus(err?.message || 'No se pudo transcribir con OpenAI', 'danger');
        })
        .finally(finalizeHybrid);
    };

    const handleHybridStop = () => {
      const currentMime = hybridState.mimeType || DEFAULT_AUDIO_MIME;
      cleanupHybridStream();
      const blob = new Blob(hybridState.chunks || [], { type: currentMime });
      hybridState.chunks = [];
      const extension = guessExtension(currentMime);
      if (!hybridState.shouldUpload) {
        finalizeHybrid();
        return;
      }
      if (!blob.size) {
        VoiceSearchUtils.setStatus('No se capturó audio. Intenta nuevamente.', 'warning');
        finalizeHybrid();
        return;
      }
      sendHybridAudio(blob, `openai-search.${extension}`);
    };

    const stopHybridRecording = (upload = true) => {
      if (!hybridState.recording) return;
      hybridState.recording = false;
      hybridState.shouldUpload = upload;
      if (hybridState.timeoutId) {
        clearTimeout(hybridState.timeoutId);
        hybridState.timeoutId = null;
      }
      if (hybridState.recorder) {
        if (hybridState.recorder.state !== 'inactive') {
          hybridState.recorder.stop();
        }
        hybridState.recorder = null;
      } else if (!upload) {
        cleanupHybridStream();
        voiceBtn.classList.remove('recording');
        setHybridIcon('idle');
      }
    };

    const startHybridRecording = () => {
      if (!window.isHybridMode || !window.isHybridMode()) return;
      if (hybridState.recording) return;
      if (typeof window.MediaRecorder === 'undefined') {
        VoiceSearchUtils.setStatus('Tu navegador no soporta grabación WebRTC', 'danger');
        return;
      }
      navigator.mediaDevices
        .getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            channelCount: 1
          }
        })
        .then((stream) => {
          hybridState.stream = stream;
          hybridState.chunks = [];
          const mimeType = pickSupportedMimeType();
          hybridState.mimeType = mimeType || DEFAULT_AUDIO_MIME;
          let recorderOptions = mimeType ? { mimeType } : undefined;
          try {
            hybridState.recorder = recorderOptions ? new MediaRecorder(stream, recorderOptions) : new MediaRecorder(stream);
          } catch (err) {
            console.warn('voice-search hybrid recorder fallback', err);
            hybridState.recorder = new MediaRecorder(stream);
            hybridState.mimeType = DEFAULT_AUDIO_MIME;
          }
          hybridState.recorder.addEventListener('dataavailable', (evt) => {
            if (evt.data && evt.data.size) hybridState.chunks.push(evt.data);
          });
          hybridState.recorder.addEventListener('stop', handleHybridStop);
          hybridState.recorder.start();
          hybridState.recording = true;
          hybridState.shouldUpload = false;
          voiceBtn.classList.add('recording');
          VoiceSearchUtils.setStatus('Grabando... suelta para buscar (Nube)', 'info');
          setHybridIcon('stop');
          hybridState.timeoutId = setTimeout(() => {
            VoiceSearchUtils.setStatus('Tiempo máximo alcanzado. Procesando...', 'warning');
            stopHybridRecording(true);
          }, 8000);
        })
        .catch((err) => {
          console.error('voice-search-openai', err);
          VoiceSearchUtils.setStatus('Permiso de micrófono denegado', 'danger');
          cleanupHybridStream();
          voiceBtn.classList.remove('recording');
          setHybridIcon('idle');
        });
    };

    const hybridPointerDown = (event) => {
      if (!window.isHybridMode || !window.isHybridMode()) return;
      if (event.button !== undefined && event.button !== 0) return;
      event.preventDefault();
      voiceBtn.setPointerCapture?.(event.pointerId);
      startHybridRecording();
    };

    const hybridPointerUp = (event) => {
      if (!window.isHybridMode || !window.isHybridMode()) return;
      if (voiceBtn.hasPointerCapture?.(event.pointerId)) {
        voiceBtn.releasePointerCapture(event.pointerId);
      }
      if (hybridState.recording) {
        VoiceSearchUtils.setStatus('Procesando búsqueda (Nube)...', 'info');
        stopHybridRecording(true);
      }
    };

    const hybridPointerCancel = () => {
      if (!window.isHybridMode || !window.isHybridMode()) return;
      stopHybridRecording(false);
      VoiceSearchUtils.setStatus('Grabación cancelada', 'warning');
    };

    const hybridKeyDown = (event) => {
      if (!window.isHybridMode || !window.isHybridMode()) return;
      if ((event.code === 'Space' || event.code === 'Enter') && !hybridState.recording) {
        event.preventDefault();
        startHybridRecording();
      }
    };

    const hybridKeyUp = (event) => {
      if (!window.isHybridMode || !window.isHybridMode()) return;
      if ((event.code === 'Space' || event.code === 'Enter') && hybridState.recording) {
        event.preventDefault();
        VoiceSearchUtils.setStatus('Procesando búsqueda (Nube)...', 'info');
        stopHybridRecording(true);
      }
    };

    voiceBtn.addEventListener('pointerdown', hybridPointerDown);
    voiceBtn.addEventListener('pointerup', hybridPointerUp);
    voiceBtn.addEventListener('pointercancel', hybridPointerCancel);
    voiceBtn.addEventListener('keydown', hybridKeyDown);
    voiceBtn.addEventListener('keyup', hybridKeyUp);

    // --- LOCAL / VOSK CONTROLLER ---
    const localState = {
      recorder: null,
      stream: null,
      chunks: [],
      timeoutId: null,
      recording: false,
      mimeType: null
    };

    const resetLocalButton = () => {
      voiceBtn.classList.remove('recording', 'loading');
      voiceBtn.disabled = false;
      if (icon) {
        icon.classList.remove('fa-spinner', 'fa-spin', 'fa-stop');
        icon.classList.add(window.isHybridMode && window.isHybridMode() ? 'fa-wave-square' : 'fa-microphone');
      }
    };

    const stopLocalStream = () => {
      if (localState.stream) {
        localState.stream.getTracks().forEach((track) => track.stop());
        localState.stream = null;
      }
      localState.mimeType = null;
      localState.recorder = null;
    };

    const handleLocalStop = () => {
      const currentMime = localState.mimeType || DEFAULT_AUDIO_MIME;
      const blob = new Blob(localState.chunks || [], { type: currentMime });
      localState.chunks = [];
      const extension = guessExtension(currentMime);
      localState.mimeType = null;
      if (!blob.size) {
        VoiceSearchUtils.setStatus('No se capturó audio. Intenta nuevamente.', 'warning');
        resetLocalButton();
        return;
      }
      voiceBtn.classList.add('loading');
      voiceBtn.disabled = true;
      if (icon) {
        icon.classList.remove('fa-microphone', 'fa-stop');
        icon.classList.add('fa-spinner', 'fa-spin');
      }
      VoiceSearchUtils.setStatus('Procesando con Vosk...', 'info');
      const formData = new FormData();
      formData.append('audio', blob, `busqueda.${extension}`);
      fetch('/parts/voice-search/transcribe/', {
        method: 'POST',
        headers: VoiceSearchUtils.buildCsrfHeaders(),
        credentials: 'same-origin',
        body: formData
      })
        .then(async (resp) => {
          if (resp.status === 403) {
            throw new Error('Sesión expirada. Recarga para continuar dictando.');
          }
          const data = await resp.json().catch(() => ({}));
          if (!resp.ok || !data?.success) {
            throw new Error(data?.error || 'No se pudo transcribir el audio');
          }
          searchInput.value = data.transcript;
          submitSearchInput(searchInput);
          VoiceSearchUtils.setStatus(`Búsqueda: “${data.transcript}” (Local)`, 'success');
        })
        .catch((err) => {
          VoiceSearchUtils.setStatus(err?.message || 'Error durante la transcripción', 'danger');
        })
        .finally(resetLocalButton);
    };

    const stopLocalRecording = () => {
      if (!localState.recording) return;
      localState.recording = false;
      if (localState.timeoutId) {
        clearTimeout(localState.timeoutId);
        localState.timeoutId = null;
      }
      if (localState.recorder) {
        if (localState.recorder.state !== 'inactive') {
          localState.recorder.stop();
        }
        localState.recorder = null;
      }
      stopLocalStream();
      voiceBtn.classList.remove('recording');
    };

    const startLocalRecording = () => {
      if (window.isHybridMode && window.isHybridMode()) return;
      if (!navigator.mediaDevices || typeof window.MediaRecorder === 'undefined') {
        VoiceSearchUtils.setStatus('Tu navegador no soporta captura de audio', 'danger');
        return;
      }
      navigator.mediaDevices
        .getUserMedia({ audio: true })
        .then((stream) => {
          localState.stream = stream;
          const mimeType = pickSupportedMimeType();
          localState.mimeType = mimeType || DEFAULT_AUDIO_MIME;
          let recorderOptions = mimeType ? { mimeType } : undefined;
          try {
            localState.recorder = recorderOptions ? new MediaRecorder(stream, recorderOptions) : new MediaRecorder(stream);
          } catch (err) {
            console.warn('voice-search local recorder fallback', err);
            localState.recorder = new MediaRecorder(stream);
            localState.mimeType = DEFAULT_AUDIO_MIME;
          }
          localState.chunks = [];
          localState.recorder.addEventListener('dataavailable', (evt) => {
            if (evt.data && evt.data.size) localState.chunks.push(evt.data);
          });
          localState.recorder.addEventListener('stop', handleLocalStop);
          localState.recorder.start();
          localState.recording = true;
          voiceBtn.classList.add('recording');
          if (icon) {
            icon.classList.remove('fa-microphone', 'fa-wave-square', 'fa-spinner', 'fa-spin');
            icon.classList.add('fa-stop');
          }
          VoiceSearchUtils.setStatus('Grabando... di el nombre de la pieza (Local)', 'info');
          localState.timeoutId = setTimeout(() => {
            VoiceSearchUtils.setStatus('Procesando búsqueda...', 'info');
            stopLocalRecording();
          }, 4500);
        })
        .catch((err) => {
          console.error('voice-search-permission', err);
          VoiceSearchUtils.setStatus('Permiso de micrófono denegado', 'danger');
          stopLocalStream();
          resetLocalButton();
        });
    };

    voiceBtn.addEventListener('click', () => {
      if (window.isHybridMode && window.isHybridMode()) {
        return;
      }
      if (localState.recording) {
        VoiceSearchUtils.setStatus('Procesando búsqueda...', 'info');
        stopLocalRecording();
        return;
      }
      startLocalRecording();
    });

    function updateVoiceButtonAppearance() {
      const hybrid = window.isHybridMode && window.isHybridMode();
      voiceBtn.classList.toggle('hybrid-mode', hybrid);
      voiceBtn.setAttribute('aria-label', hybrid ? 'Mantén presionado para dictar (Nube)' : 'Toca para dictar (Local)');
      voiceBtn.title = hybrid ? 'Mantén presionado para dictar (Nube)' : 'Toca para dictar (Local)';
      if (label) {
        label.textContent = hybrid ? 'Voz (Nube)' : 'Voz (Local)';
      }
      if (!hybrid) {
        setHybridIcon('idle');
      } else {
        setHybridIcon('hybrid');
      }
      const statusEl = document.getElementById('global-part-voice-status');
      if (statusEl) {
        const span = statusEl.querySelector('span') || statusEl;
        span.textContent = hybrid
          ? 'Mantén presionado el botón para dictar con modo Nube.'
          : 'Toca una vez para dictar usando modo Local.';
      }
    }

    window.addEventListener('transcriptionModeChanged', updateVoiceButtonAppearance);
    updateVoiceButtonAppearance();
  }

  function initLoadMore() {
    const loadBtn = document.getElementById('load-more-parts-btn');
    if (!loadBtn || loadBtn.dataset.loadMoreInit === 'true') return;
    loadBtn.dataset.loadMoreInit = 'true';

    const tableBody = document.getElementById('parts-table-body');
    const mobileContainer = document.getElementById('parts-mobile-list') || document.getElementById('parts-mobile-container');
    const counter = document.getElementById('parts-display-counter');
    const loadMoreNotice = document.getElementById('load-more-notice');
    const skeleton = document.getElementById('parts-skeleton');
    const tableWrapper = document.getElementById('parts-table-wrapper');
    const FILTERS_KEY = 'columnFilters';
    const maxFilterPages = parseInt(loadBtn.dataset.filterPages || String(LOAD_MORE_MAX_FILTER_PAGES), 10);
    const sentinel = document.getElementById('parts-load-sentinel');
    let sentinelObserver = null;

    const toggleSkeleton = (show) => {
      if (!skeleton) return;
      skeleton.classList.toggle('d-none', !show);
      skeleton.setAttribute('aria-hidden', show ? 'false' : 'true');
      if (tableWrapper) {
        tableWrapper.setAttribute('aria-busy', show ? 'true' : 'false');
      }
    };

    const setLoading = (state) => {
      const defaultText = loadBtn.querySelector('.default-text');
      const loadingText = loadBtn.querySelector('.loading-text');
      if (state) {
        loadBtn.disabled = true;
        if (defaultText) defaultText.classList.add('d-none');
        if (loadingText) loadingText.classList.remove('d-none');
      } else {
        loadBtn.disabled = false;
        if (defaultText) defaultText.classList.remove('d-none');
        if (loadingText) loadingText.classList.add('d-none');
      }
      toggleSkeleton(state);
    };

    const appendHtml = (container, html) => {
      if (!container || !html) return;
      const template = document.createElement('template');
      template.innerHTML = html.trim();
      container.appendChild(template.content);
    };

    const updateCounter = (newEnd) => {
      if (!counter) return;
      counter.dataset.current = String(newEnd);
      const start = parseInt(counter.dataset.start || '0', 10);
      const total = parseInt(counter.dataset.total || '0', 10);
      counter.textContent = `Mostrando ${start} - ${newEnd} de ${total} piezas`;
      try {
        document.dispatchEvent(new CustomEvent('parts:display-limit-changed', { detail: { current: newEnd } }));
      } catch (_) {
        document.dispatchEvent(new Event('parts:display-limit-changed'));
      }
    };

    const showNoMoreMessage = () => {
      if (loadBtn.classList.contains('d-none')) return;
      if (sentinelObserver) {
        sentinelObserver.disconnect();
        sentinelObserver = null;
      }
      setLoading(false);
      const container = loadBtn.parentElement;
      loadBtn.classList.add('d-none');
      const note = document.createElement('span');
      note.className = 'text-body-secondary small d-block';
      note.textContent = 'No hay más piezas para mostrar';
      container.appendChild(note);
    };

    const setNotice = (message, variant = 'info') => {
      if (!loadMoreNotice) return;
      loadMoreNotice.textContent = message;
      loadMoreNotice.className = `alert alert-${variant} d-block mt-3 small`;
      loadMoreNotice.classList.remove('d-none');
    };

    const clearNotice = () => {
      if (loadMoreNotice) {
        loadMoreNotice.classList.add('d-none');
        loadMoreNotice.textContent = '';
      }
    };

    const parseStoredFilters = () => {
      try {
        return JSON.parse(localStorage.getItem(FILTERS_KEY) || '{}') || {};
      } catch (_) {
        return {};
      }
    };

    const hasActiveClientFilters = () => {
      const filters = parseStoredFilters();
      const hasFilters = Object.values(filters).some((value) => String(value || '').trim().length > 0);
      const searchInput = document.getElementById('global-part-search');
      const clientSearchActive = !!(
        searchInput &&
        searchInput.dataset &&
        searchInput.dataset.clientSearch === 'true' &&
        searchInput.value.trim().length
      );
      return hasFilters || clientSearchActive;
    };

    const getBatchSize = () => {
      const raw = parseInt(loadBtn.dataset.batchSize || loadBtn.dataset.perPage || String(LOAD_MORE_DEFAULT_BATCH), 10);
      return Number.isFinite(raw) && raw > 0 ? raw : LOAD_MORE_DEFAULT_BATCH;
    };

    const countVisibleItems = () => {
      const seen = new Set();
      if (tableBody) {
        tableBody.querySelectorAll('tr.part-row').forEach((row) => {
          if (row.dataset && row.dataset.filterHidden === '1') return;
          const id = row.dataset.partId || `row-${seen.size}`;
          seen.add(id);
        });
      }
      return seen.size;
    };

  const fetchAppendPage = (rawUrl) => {
    const url = rawUrl.includes('?') ? `${rawUrl}&append=1` : `${rawUrl}?append=1`;
    return fetch(url, {
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
      credentials: 'same-origin'
    }).then((resp) => resp.json());
  };

    loadBtn.addEventListener('click', () => {
      const initialUrl = loadBtn.dataset.nextUrl;
      if (!initialUrl) {
        showNoMoreMessage();
        return;
      }
      clearNotice();
      const filtersActive = hasActiveClientFilters();
      const desiredBatch = getBatchSize();
      let remainingNeeded = desiredBatch;
      let previousVisible = countVisibleItems();
      let pagesFetched = 0;
      let emptyAppendRuns = 0;

      const processPage = (rawUrl) => {
        setLoading(true);
        return fetchAppendPage(rawUrl)
          .then((data) => {
            if (!data?.success) throw new Error('Respuesta inválida');
            pagesFetched += 1;

            appendHtml(tableBody, data.rows_html || '');
            appendHtml(mobileContainer, data.cards_html || '');

            if (typeof window.inicializarTablaFunciones === 'function') {
              window.inicializarTablaFunciones();
            }
            if (typeof data.displayed_count !== 'undefined') {
              updateCounter(data.displayed_count);
            }

            const afterVisible = countVisibleItems();
            const addedVisible = Math.max(0, afterVisible - previousVisible);
            previousVisible = afterVisible;

            if (filtersActive) {
              emptyAppendRuns = addedVisible === 0 ? emptyAppendRuns + 1 : 0;
              remainingNeeded = Math.max(0, remainingNeeded - addedVisible);
            } else {
              remainingNeeded = 0;
              emptyAppendRuns = 0;
            }

            const hasMore = Boolean(data.has_next && data.next_url);
            if (filtersActive && remainingNeeded > 0) {
              if (!hasMore) {
                setNotice('No quedan más piezas que cumplan con los filtros aplicados.', 'warning');
                loadBtn.dataset.nextUrl = '';
                showNoMoreMessage();
                return null;
              }
              if (pagesFetched >= maxFilterPages) {
                setNotice('Se revisaron varias páginas y no hay más coincidencias para estos filtros.', 'info');
                setLoading(false);
                loadBtn.dataset.nextUrl = data.next_url;
                return null;
              }
              if (emptyAppendRuns >= 2) {
                setNotice('No encontramos más piezas que coincidan con los filtros actuales.', 'warning');
                setLoading(false);
                loadBtn.dataset.nextUrl = data.next_url;
                return null;
              }
              loadBtn.dataset.nextUrl = data.next_url;
              return processPage(data.next_url);
            }

            if (hasMore) {
              loadBtn.dataset.nextUrl = data.next_url;
              setLoading(false);
            } else {
              loadBtn.dataset.nextUrl = '';
              showNoMoreMessage();
            }
            return null;
          })
          .catch((error) => {
            console.error('parts:load-more', error);
            setLoading(false);
            window.showToast?.({
              title: 'Inventario',
              body: 'No se pudieron cargar más piezas. Intenta nuevamente.',
              variant: 'danger'
            });
          });
      };

      processPage(initialUrl);
    });

    if (sentinel && 'IntersectionObserver' in window) {
      sentinelObserver = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          if (!loadBtn.dataset.nextUrl || loadBtn.disabled || loadBtn.classList.contains('d-none')) return;
          loadBtn.click();
        });
      }, { rootMargin: '200px', threshold: 0.25 });
      sentinelObserver.observe(sentinel);
    }
  }

  function initLiveSync() {
    const meta = document.getElementById('parts-live-meta');
    if (!meta) return;
    const currentPage = parseInt(meta.dataset.currentPage || '1', 10);
    if (currentPage > 1) return;
    if (window.__partsLiveSyncController) {
      window.__partsLiveSyncController.stop();
    }

    const refreshUrl = meta.dataset.refreshUrl || window.location.pathname + window.location.search;
    const tableBody = document.getElementById('parts-table-body');
    const mobileList = document.getElementById('parts-mobile-list');
    let lastUpdated = meta.dataset.lastUpdated || '';
    // Nota: Con búsqueda en servidor, no necesitamos sincronizar cache local
    let timer = null;

    const buildUrl = () => {
      const separator = refreshUrl.includes('?') ? '&' : '?';
      return `${refreshUrl}${separator}refresh=1`;
    };

    const schedule = (delay = LIVE_SYNC_IDLE_INTERVAL) => {
      clearTimeout(timer);
      timer = window.setTimeout(checkUpdates, delay);
    };

    const updateSyncLabel = (isoValue) => {
      const label = document.getElementById('inventory-sync-label');
      if (!label) return;
      if (!isoValue) {
        label.innerHTML = '<i class="bi bi-clock-history me-1"></i> Sin registros recientes';
        return;
      }
      try {
        const date = new Date(isoValue);
        const formatted = date.toLocaleString('es-CL', { hour12: false });
        label.innerHTML = `<i class="bi bi-clock-history me-1"></i> Actualizado <time datetime="${isoValue}">${formatted}</time>`;
      } catch (_) {
        label.innerHTML = `<i class="bi bi-clock-history me-1"></i> Actualizado ${isoValue}`;
      }
    };

    const checkUpdates = () => {
      if (document.visibilityState === 'hidden') {
        schedule();
        return;
      }
      fetch(buildUrl(), { headers: { 'X-Requested-With': 'XMLHttpRequest' } })
        .then((resp) => resp.json())
        .then((data) => {
          if (!data?.success) return;
          if (data.last_updated && data.last_updated !== lastUpdated) {
            lastUpdated = data.last_updated;
            meta.dataset.lastUpdated = lastUpdated;
            updateSyncLabel(lastUpdated);
            // Nota: Búsqueda en servidor siempre tiene datos frescos
            if (tableBody && data.rows_html) {
              tableBody.innerHTML = data.rows_html;
            }
            if (mobileList && data.cards_html) {
              mobileList.innerHTML = data.cards_html;
            }
            window.showToast?.({
              title: 'Inventario actualizado',
              body: 'Se sincronizaron las últimas piezas automáticamente.',
              variant: 'info'
            });
          }
        })
        .catch(() => {
          /* ignora errores intermitentes */
        })
        .finally(() => schedule(LIVE_SYNC_INTERVAL));
    };

    updateSyncLabel(lastUpdated);
    schedule(LIVE_SYNC_INTERVAL);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        schedule(1500);
      }
    });

    window.__partsLiveSyncController = {
      stop() {
        clearTimeout(timer);
      }
    };
  }

  onReady(() => {
    initPersistScroll();
    initPartListFilters();
    initSearchSuggestions();
    initCatalogSearch();
    initVoiceSearch();
    initLoadMore();
    initLiveSync();
  });
})();
