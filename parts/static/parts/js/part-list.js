/**
 * Funciones específicas para la vista de inventario de piezas.
 * Separa la lógica inline para cumplir CSP estricto y facilitar mantenimiento.
 */
(function () {
  'use strict';

  const LOAD_MORE_MAX_FILTER_PAGES = 5;
  const LOAD_MORE_DEFAULT_BATCH = 20;
  const LIVE_SYNC_INTERVAL = 60000;
  const LIVE_SYNC_IDLE_INTERVAL = 90000;

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

  function normalizeForSearch(value) {
    if (!value) return '';
    return String(value)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
  }

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

  const CatalogCache = (() => {
    const STORAGE_KEY = 'parts:catalog-cache:v1';
    const STALE_MS = 10 * 60 * 1000;
    let cache = null;
    let fetchPromise = null;
    let catalogUrl = null;
    let expectedVersion = null;

    const loadFromStorage = () => {
      if (cache) return cache;
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        cache = raw ? JSON.parse(raw) : null;
      } catch (_err) {
        cache = null;
      }
      return cache;
    };

    const saveToStorage = (data) => {
      cache = data;
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      } catch (_err) {
        /* ignore quota */
      }
    };

    const enhanceEntries = (data) => {
      if (!data || !Array.isArray(data.parts)) return data;
      data.parts.forEach((part) => {
        const combined = `${part.name || ''} ${part.auto || ''} ${part.barcode || ''}`;
        part._normalized = normalizeForSearch(combined);
        part._barcode = (part.barcode || '').toLowerCase();
      });
      return data;
    };

    const isStale = (data) => {
      if (!data || !data.fetched_at) return true;
      return (Date.now() - data.fetched_at) > STALE_MS;
    };

    const getCache = () => cache || loadFromStorage();

    const fetchLatest = () => {
      if (!catalogUrl) return Promise.resolve(null);
      if (fetchPromise) return fetchPromise;
      fetchPromise = fetch(catalogUrl, {
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
        credentials: 'same-origin'
      })
        .then((resp) => resp.json())
        .then((payload) => {
          if (!payload?.success) throw new Error('Respuesta inválida');
          payload.fetched_at = Date.now();
          saveToStorage(enhanceEntries(payload));
          return cache;
        })
        .catch((err) => {
          console.warn('catalog-cache', err);
          return getCache();
        })
        .finally(() => {
          fetchPromise = null;
        });
      return fetchPromise;
    };

    const ensureFresh = () => {
      const data = getCache();
      if (!data || isStale(data) || (expectedVersion && data.version && data.version !== expectedVersion)) {
        return fetchLatest();
      }
      return Promise.resolve(data);
    };

    const search = (term, limit = 20) => {
      const data = getCache();
      if (!data?.parts?.length) return [];
      const normalized = normalizeForSearch(term).trim();
      if (!normalized) {
        return data.parts.slice(0, limit);
      }
      const stripped = normalized.replace(/\s+/g, '');
      const results = [];
      data.parts.forEach((part) => {
        let score = 0;
        if (part._barcode && stripped && part._barcode.startsWith(stripped)) {
          score += 10;
        }
        if (part._normalized.includes(normalized)) {
          score += 6;
        } else {
          const tokens = normalized.split(/\s+/).filter(Boolean);
          const hits = tokens.filter((tok) => part._normalized.includes(tok)).length;
          score += hits;
        }
        if (score > 0) {
          results.push({ part, score });
        }
      });
      results.sort((a, b) => (b.score - a.score) || (a.part.id - b.part.id));
      return results.slice(0, limit).map((entry) => entry.part);
    };

    const clear = () => {
      cache = null;
      fetchPromise = null;
      try {
        localStorage.removeItem(STORAGE_KEY);
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
      clear,
      isReady() {
        return Boolean(getCache()?.parts?.length);
      },
      getCount() {
        return getCache()?.parts?.length || 0;
      },
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
    const modelSel = document.getElementById('filter-model');
    const yearSel = document.getElementById('filter-year');
    const filterForm = document.getElementById('parts-filter-form');

    if (!filterForm) return;

    const submitFilters = () => {
      if (typeof filterForm.requestSubmit === 'function') {
        filterForm.requestSubmit();
      } else {
        filterForm.submit();
      }
    };

    if (modelSel && !modelSel.dataset.partsFilterInit) {
      modelSel.dataset.partsFilterInit = 'true';
      modelSel.addEventListener('change', () => {
        if (yearSel) yearSel.value = '';
        submitFilters();
      });
    }

    if (yearSel && !yearSel.dataset.partsFilterInit) {
      yearSel.dataset.partsFilterInit = 'true';
      yearSel.addEventListener('change', submitFilters);
    }

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

function submitSearchInput(searchInput) {
    if (!searchInput) return;
    const form = searchInput.form;
    if (form) {
      if (typeof form.requestSubmit === 'function') {
        form.requestSubmit();
      } else {
        form.submit();
}

  function normalizeForSearch(value) {
    if (!value) return '';
    return String(value)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
  }

  function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/[&<>"']/g, (ch) => {
      switch (ch) {
        case '&':
          return '&amp;';
        case '<':
          return '&lt;';
        case '>':
          return '&gt;';
        case '"':
          return '&quot;';
        case "'":
          return '&#39;';
        default:
          return ch;
      }
    });
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

  function initCatalogSearch() {
    const meta = document.getElementById('parts-live-meta');
    const searchInput = document.getElementById('global-part-search');
    const quickContainer = document.getElementById('catalog-quick-results');
    const statusEl = document.getElementById('catalog-cache-status');
    if (!meta || !searchInput || !quickContainer || !statusEl) return;
    const catalogUrl = meta.dataset.catalogUrl;
    if (!catalogUrl) {
      statusEl.textContent = 'Índice local no disponible.';
      statusEl.classList.add('text-danger');
      return;
    }

    CatalogCache.setUrl(catalogUrl);
    CatalogCache.setExpectedVersion(meta.dataset.lastUpdated || null);

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

    CatalogCache.ensureFresh()
      .then((data) => {
        if (data?.parts?.length) {
          updateStatus(`Índice local listo (${data.parts.length} piezas)`, 'success');
        } else {
          updateStatus('No se pudo precargar el índice local.', 'danger');
        }
      })
      .catch(() => updateStatus('No se pudo precargar el índice local.', 'danger'));

    let hideTimer = null;

    const hideResults = () => {
      quickContainer.classList.add('d-none');
      quickContainer.innerHTML = '';
    };

    const renderResults = (items) => {
      if (!items || !items.length) {
        quickContainer.innerHTML = '<div class="catalog-quick-results__empty">Sin coincidencias en el índice local.</div>';
        quickContainer.classList.remove('d-none');
        return;
      }
      quickContainer.innerHTML = items.map((item) => `
        <button type="button"
                class="catalog-quick-results__item"
                data-catalog-id="${item.id}"
                data-catalog-name="${escapeHtml(item.name)}"
                data-catalog-barcode="${escapeHtml(item.barcode || '')}">
          <div class="catalog-result-meta">
            <span class="catalog-result-name">${escapeHtml(item.name)}</span>
            <div class="catalog-result-tags">
              ${item.barcode ? `<span class="badge bg-light text-dark"><i class="bi bi-upc me-1"></i>${escapeHtml(item.barcode)}</span>` : ''}
              ${item.auto ? `<span class="badge bg-primary-subtle text-primary-emphasis"><i class="bi bi-car-front me-1"></i>${escapeHtml(item.auto)}</span>` : ''}
              ${item.workshop ? `<span class="badge bg-body-secondary text-body"><i class="bi bi-geo-alt me-1"></i>${escapeHtml(item.workshop)}</span>` : ''}
            </div>
          </div>
          <i class="bi bi-arrow-return-left text-muted"></i>
        </button>
      `).join('');
      quickContainer.classList.remove('d-none');
    };

    const runLocalSearch = () => {
      const term = searchInput.value || '';
      if (!term.trim()) {
        hideResults();
        return;
      }
      if (!CatalogCache.isReady()) return;
      const matches = CatalogCache.search(term);
      renderResults(matches);
    };

    const clearHideTimer = () => {
      if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = null;
      }
    };

    searchInput.addEventListener('input', () => {
      if (!searchInput.value.trim()) {
        hideResults();
        return;
      }
      if (!CatalogCache.isReady()) {
        CatalogCache.ensureFresh();
        return;
      }
      runLocalSearch();
    });

    searchInput.addEventListener('focus', () => {
      clearHideTimer();
      if (CatalogCache.isReady()) {
        runLocalSearch();
      } else {
        CatalogCache.ensureFresh().then(runLocalSearch);
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

    quickContainer.addEventListener('mousedown', (event) => {
      // Evita que el blur cierre los resultados antes de hacer clic
      event.preventDefault();
    });

    quickContainer.addEventListener('click', (event) => {
      const item = event.target.closest('.catalog-quick-results__item');
      if (!item) return;
      clearHideTimer();
      const preferred = item.dataset.catalogBarcode || item.dataset.catalogName || '';
      if (preferred) {
        searchInput.value = preferred;
        submitSearchInput(searchInput);
      }
      hideResults();
    });
    document.querySelectorAll('a[href$="/logout/"]').forEach((link) => {
      link.addEventListener('click', () => {
        CatalogCache.clear();
      });
    });

    document.addEventListener('turbo:before-visit', (event) => {
      const url = event?.detail?.url || '';
      if (/\/logout\/?$/.test(url)) {
        CatalogCache.clear();
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
    if (lastUpdated) {
      CatalogCache.setExpectedVersion(lastUpdated);
    }
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
            CatalogCache.setExpectedVersion(lastUpdated);
            CatalogCache.ensureFresh();
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
    initCatalogSearch();
    initVoiceSearch();
    initLoadMore();
    initLiveSync();
  });
})();
