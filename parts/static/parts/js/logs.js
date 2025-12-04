(() => {
  const MICRO_ACTION_SETTINGS = {
    click: { gap: 2500, minCount: 3, label: 'Clicks encadenados', icon: 'bi-mouse' },
    delete: { gap: 3500, minCount: 2, label: 'Eliminaciones consecutivas', icon: 'bi-trash' },
    ingest: { gap: 3500, minCount: 2, label: 'Ingestas consecutivas', icon: 'bi-lightning' }
  };
  const MICRO_ACTION_PATTERNS = {
    click: /(click|clic|tap|pulse|btn|button)/i,
    delete: /(delete|elimin|borrar|remov|trash|supres)/i,
    ingest: /(ingest|ingesta|ingresar|ingreso|ingestar|guardar|submit|upload|publicar|procesar)/i
  };
  const SOURCE_LABELS = {
    app: 'Aplicación',
    voice: 'Motor de voz',
    bluetooth: 'Impresora Bluetooth'
  };
  const EVENT_TRANSLATIONS = {
    voice_ws_connected: 'Motor de voz conectado',
    voice_ws_disconnected: 'Motor de voz desconectado',
    voice_chunk_received: 'Audio recibido',
    voice_chunk_processed: 'Audio procesado',
    voice_session_started: 'Sesión de voz iniciada',
    voice_session_finished: 'Sesión de voz finalizada',
    voice_transcription_disabled: 'Transcripción deshabilitada',
    voice_transcription_ready: 'Transcripción lista',
    autowatch_connected: 'Impresora conectada',
    autowatch_disconnected: 'Impresora desconectada',
    barcode_printed: 'Etiqueta impresa',
    barcode_generated: 'Etiqueta generada',
    barcode_error: 'Error al imprimir etiqueta',
    bt_event: 'Evento Bluetooth',
    part_created: 'Pieza creada',
    part_updated: 'Pieza actualizada',
    part_deleted: 'Pieza eliminada',
    login_success: 'Ingreso exitoso',
    login_failed: 'Ingreso fallido',
    client_connected: 'Cliente conectado',
    client_disconnected: 'Cliente desconectado',
    ingest_completed: 'Carga finalizada',
    ingest_failed: 'Carga fallida',
    error: 'Error'
  };
  const IMPORTANT_EVENT_SET = new Set([
    'voice_ws_connected',
    'voice_ws_disconnected',
    'voice_transcription_ready',
    'voice_transcription_disabled',
    'voice_chunk_received',
    'voice_chunk_processed',
    'voice_session_started',
    'voice_session_finished',
    'autowatch_disconnected',
    'autowatch_connected',
    'barcode_printed',
    'barcode_error',
    'part_created',
    'part_deleted',
    'login_failed',
    'login_success',
    'client_connected',
    'client_disconnected'
  ]);
  const FETCH_TIMEOUT_MS = 12000;

  let apiUrl;
  let auditUrl;
  let refreshInterval = 10000;
  let configEl;
  let filterForm;
  let timelineEl;
  let placeholder;
  let meta;
  let countBadge;
  let aggregationPanel;
  let aggregationList;
  let aggregationBadge;
  let metricTotal;
  let metricTotalExtra;
  let metricErrors;
  let metricLast;
  let metricLastSource;
  let infoMessage;
  let viewerLogList;
  let viewerLogCounter;
  let auditTimeline;
  let auditForm;
  let auditStatus;
  let userSummaryList;
  let typeSummaryList;
  let refreshBtn;
  let logsCssHref = '';

  const LOG_TAG = '[logs.js]';

  let state = null;
  let listeners = [];
  let activeCleanup = null;
  let domObserver = null;
  const viewerLogs = [];
  let ensureInterval = null;
  const LOG_ID_FIELDS = ['id', 'pk', 'uuid', 'log_id', 'entry_id', 'event_id'];

  function sanitizeDomKey(value, fallback = '') {
    const base = String(value ?? '').trim();
    if (base) {
      const cleaned = base
        .replace(/\s+/g, '-')
        .replace(/[^a-zA-Z0-9_-]/g, '')
        .toLowerCase();
      if (cleaned) {
        return cleaned;
      }
    }
    if (fallback) {
      return sanitizeDomKey(fallback, '');
    }
    return '';
  }

  function buildLogDomKey(log, idx) {
    if (!log) {
      return `log-${idx}`;
    }
    for (const field of LOG_ID_FIELDS) {
      const candidate = log[field];
      if (candidate !== undefined && candidate !== null && String(candidate).trim()) {
        const key = sanitizeDomKey(candidate);
        if (key) {
          return key;
        }
      }
    }
    const ts = parseLogTimestamp(log);
    const source = (log.source || 'log').toLowerCase();
    const label = (log.event || log.accion || log.message || log.name || '').slice(0, 32);
    const user = getUserKey(log);
    const fallback = `${source}-${ts}-${label}-${user || ''}` || `log-${idx}`;
    const sanitized = sanitizeDomKey(fallback);
    return sanitized || `log-${idx}`;
  }

  function captureOpenLogDetailKeys() {
    if (!timelineEl) {
      return [];
    }
    return Array.from(
      timelineEl.querySelectorAll('.log-entry-detail-panel.show[data-log-key]')
    ).map((panel) => panel.dataset.logKey).filter(Boolean);
  }

  function restoreOpenLogDetailKeys(keys) {
    if (!timelineEl || !keys || !keys.length) {
      return;
    }
    const panels = Array.from(timelineEl.querySelectorAll('.log-entry-detail-panel[data-log-key]'));
    const toggles = Array.from(timelineEl.querySelectorAll('[data-log-toggle]'));
    keys.forEach((key) => {
      const panel = panels.find((el) => el.dataset.logKey === key);
      if (!panel) {
        return;
      }
      if (typeof bootstrap !== 'undefined' && bootstrap.Collapse) {
        const collapse = bootstrap.Collapse.getOrCreateInstance(panel, { toggle: false });
        collapse.show();
      } else {
        panel.classList.add('show');
      }
      const toggleBtn = toggles.find((btn) => btn.dataset.logToggle === panel.id);
      if (toggleBtn) {
        const icon = toggleBtn.querySelector('i');
        icon?.classList.add('bi-chevron-up');
        icon?.classList.remove('bi-chevron-down');
        toggleBtn.setAttribute('aria-expanded', 'true');
      }
    });
  }

  function captureOpenAggregationKeys() {
    if (!aggregationList) {
      return [];
    }
    return Array.from(
      aggregationList.querySelectorAll('.micro-dropdown-body.show[data-micro-key]')
    ).map((panel) => panel.dataset.microKey).filter(Boolean);
  }

  function restoreOpenAggregationKeys(keys) {
    if (!aggregationList || !keys || !keys.length) {
      return;
    }
    const bodies = Array.from(aggregationList.querySelectorAll('.micro-dropdown-body[data-micro-key]'));
    const toggles = Array.from(aggregationList.querySelectorAll('[data-micro-toggle]'));
    keys.forEach((key) => {
      const panel = bodies.find((el) => el.dataset.microKey === key);
      if (!panel) {
        return;
      }
      if (typeof bootstrap !== 'undefined' && bootstrap.Collapse) {
        const collapse = bootstrap.Collapse.getOrCreateInstance(panel, { toggle: false });
        collapse.show();
      } else {
        panel.classList.add('show');
      }
      const toggleBtn = toggles.find((btn) => btn.dataset.microToggle === panel.id);
      if (toggleBtn) {
        toggleBtn.classList.add('is-open');
        toggleBtn.setAttribute('aria-expanded', 'true');
      }
    });
  }

  function addListener(target, event, handler, options) {
    if (!target) return;
    target.addEventListener(event, handler, options);
    listeners.push(() => target.removeEventListener(event, handler, options));
  }

  function clearListeners() {
    listeners.forEach((off) => off());
    listeners = [];
  }

  function setupDomReferences() {
    configEl = document.getElementById('logs-config');
    filterForm = document.getElementById('logs-filter-form');
    if (!configEl || !filterForm) {
      return false;
    }
    apiUrl = configEl.dataset.apiUrl;
    auditUrl = configEl.dataset.auditUrl;
    refreshInterval = Number(configEl.dataset.refreshInterval || '10000');
    logsCssHref = configEl.dataset.cssHref || '';
    timelineEl = document.getElementById('logs-timeline');
    placeholder = document.getElementById('logs-placeholder');
    meta = document.getElementById('meta-info');
    countBadge = document.getElementById('log-count');
    aggregationPanel = document.getElementById('aggregation-panel');
    aggregationList = document.getElementById('aggregation-list');
    aggregationBadge = document.getElementById('aggregation-count');
    metricTotal = document.getElementById('metric-total');
    metricTotalExtra = document.getElementById('metric-total-extra');
    metricErrors = document.getElementById('metric-errors');
    metricLast = document.getElementById('metric-last');
    metricLastSource = document.getElementById('metric-last-source');
    infoMessage = document.getElementById('logs-info-message');
    viewerLogList = document.getElementById('viewer-log-list');
    viewerLogCounter = document.getElementById('viewer-log-count');
    auditTimeline = document.getElementById('audit-timeline');
    auditForm = document.getElementById('audit-filter-form');
    auditStatus = document.getElementById('audit-status');
    userSummaryList = document.getElementById('user-summary-list');
    typeSummaryList = document.getElementById('type-summary-list');
    refreshBtn = document.getElementById('btn-refresh');
    ensureLogsStyles();
    return true;
  }

  function ensureLogsStyles() {
    if (!logsCssHref) return;
    const selector = `link[data-logs-style="true"][href="${logsCssHref}"]`;
    const existing = document.querySelector(selector);
    if (existing) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = logsCssHref;
    link.dataset.logsStyle = 'true';
    document.head.appendChild(link);
  }

  function initController() {
    if (!setupDomReferences()) {
      return null;
    }
    state = {
      cachedLogs: [],
      collapsedRuns: [],
      timerId: null,
      abortController: null,
      isFetching: false
    };

    const handleVisibilityChange = () => {
      if (document.hidden) {
        clearTimeout(state.timerId);
      } else {
        scheduleRefresh();
      }
    };

    const handlePopState = () => {
      syncFormWithLocation();
      fetchLogs(true);
    };

    const handleFilterSubmit = (ev) => {
      ev.preventDefault();
      const formData = new FormData(filterForm);
      const params = new URLSearchParams(formData);
      const query = params.toString();
      const nextUrl = query ? `${window.location.pathname}?${query}` : window.location.pathname;
      window.history.replaceState({}, '', nextUrl);
      fetchLogs(true);
    };

    const handleRefreshClick = (ev) => {
      ev.preventDefault();
      fetchLogs(true);
    };

    const handleAggregationClick = (ev) => {
      const toggleBtn = ev.target.closest('[data-micro-toggle]');
      if (!toggleBtn) return;
      const targetId = toggleBtn.dataset.microToggle;
      const panel = document.getElementById(targetId);
      if (!panel) return;
      if (typeof bootstrap !== 'undefined' && bootstrap.Collapse) {
        const instance = bootstrap.Collapse.getOrCreateInstance(panel, { toggle: false });
        const willExpand = !panel.classList.contains('show');
        instance.toggle();
        toggleBtn.classList.toggle('is-open', willExpand);
        toggleBtn.setAttribute('aria-expanded', String(willExpand));
      } else {
        panel.classList.toggle('show');
        const isOpen = panel.classList.contains('show');
        toggleBtn.classList.toggle('is-open', isOpen);
        toggleBtn.setAttribute('aria-expanded', String(isOpen));
      }
    };

    const handleTimelineClick = (ev) => {
      const toggleBtn = ev.target.closest('[data-log-toggle]');
      if (toggleBtn) {
        const targetId = toggleBtn.dataset.logToggle;
        const panel = document.getElementById(targetId);
        if (!panel) return;
        const bsCollapse = bootstrap.Collapse.getOrCreateInstance(panel);
        bsCollapse.toggle();
        const icon = toggleBtn.querySelector('i');
        icon?.classList.toggle('bi-chevron-down');
        icon?.classList.toggle('bi-chevron-up');
        const expanded = panel.classList.contains('show');
        toggleBtn.setAttribute('aria-expanded', String(expanded));
        return;
      }
      const copyBtn = ev.target.closest('[data-copy-target]');
      if (copyBtn) {
        const jsonId = `${copyBtn.dataset.copyTarget}-json`;
        const pre = document.getElementById(jsonId);
        if (!pre) return;
        navigator.clipboard?.writeText(pre.textContent || '');
        copyBtn.blur();
        copyBtn.classList.add('text-success');
        setTimeout(() => copyBtn.classList.remove('text-success'), 1200);
        return;
      }
      const auditBtn = ev.target.closest('.log-load-audit');
      if (auditBtn) {
        const corr = auditBtn.dataset.correlation || '';
        if (!corr || !auditForm) return;
        auditForm.querySelector('input[name="correlation_id"]').value = corr;
        auditForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
        const params = new URLSearchParams(new FormData(auditForm));
        fetchAuditEvents(params);
      }
    };

    const handleAuditSubmit = (ev) => {
      ev.preventDefault();
      const params = new URLSearchParams(new FormData(auditForm));
      fetchAuditEvents(params);
    };

    addListener(document, 'visibilitychange', handleVisibilityChange);
    addListener(window, 'popstate', handlePopState);
    addListener(filterForm, 'submit', handleFilterSubmit);
    addListener(refreshBtn, 'click', handleRefreshClick);
    addListener(aggregationList, 'click', handleAggregationClick);
    addListener(timelineEl, 'click', handleTimelineClick);
    addListener(auditForm, 'submit', handleAuditSubmit);

    syncFormWithLocation();
    fetchLogs(true);
    fetchAuditEvents(new URLSearchParams({ limit: '100' }));

    return () => {
      clearTimeout(state?.timerId);
      state?.abortController?.abort();
      state = null;
      clearListeners();
    };
  }

  function boot() {
    if (activeCleanup) {
      activeCleanup();
      activeCleanup = null;
    }
    activeCleanup = initController();
    window.logsViewerDebug = {
      startedAt: new Date().toISOString(),
      getState: () => state,
      logs: viewerLogs
    };
  }

  function ensureLogsController() {
    const hasConfig = Boolean(document.getElementById('logs-config'));
    if (hasConfig && !activeCleanup) {
      console.info(LOG_TAG, 'Inicializando visor de logs');
      appendViewerLog('Inicializando visor de logs...', 'info');
      boot();
    } else if (!hasConfig && activeCleanup) {
      console.info(LOG_TAG, 'Desmontando visor de logs');
      appendViewerLog('Desmontando visor de logs...', 'info');
      activeCleanup();
      activeCleanup = null;
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureLogsController, { once: true });
  } else {
    ensureLogsController();
  }
  document.addEventListener('turbo:load', ensureLogsController);
  document.addEventListener('turbo:frame-load', ensureLogsController);
  document.addEventListener('turbo:before-cache', () => {
    if (activeCleanup) {
      activeCleanup();
      activeCleanup = null;
    }
  });

  if (typeof MutationObserver !== 'undefined') {
    domObserver = new MutationObserver(() => {
      ensureLogsController();
    });
    domObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  ensureInterval = window.setInterval(ensureLogsController, 1200);

  function scheduleRefresh() {
    if (!state) return;
    clearTimeout(state.timerId);
    if (document.hidden) return;
    state.timerId = window.setTimeout(() => fetchLogs(), refreshInterval);
  }

  function setInfoMessage(text, variant = 'info') {
    if (!infoMessage) return;
    if (!text) {
      infoMessage.classList.remove('is-visible', 'alert-info', 'alert-warning', 'alert-danger');
      infoMessage.textContent = '';
      return;
    }
    infoMessage.classList.add('is-visible', `alert-${variant}`);
    infoMessage.textContent = text;
  }

  function appendViewerLog(message, level = 'info') {
    if (!viewerLogList) return;
    const timestamp = new Date().toLocaleTimeString('es-CL', { hour12: false });
    const palette = {
      info: 'text-secondary',
      success: 'text-success',
      warning: 'text-warning',
      danger: 'text-danger'
    };
    const entry = {
      timestamp,
      message,
      levelClass: palette[level] || palette.info
    };
    viewerLogs.push(entry);
    console.log(LOG_TAG, message);
    const latest = viewerLogs.slice(-15)
      .map((item) => `<li class="${item.levelClass}"><strong>${item.timestamp}</strong> · ${escapeHtml(item.message)}</li>`)
      .join('');
    viewerLogList.innerHTML = latest || '<li class="text-muted">Sin actividad registrada.</li>';
    if (viewerLogCounter) {
      viewerLogCounter.textContent = String(viewerLogs.length);
    }
  }

  function formatDate(asctime) {
    if (!asctime) return '-';
    const [datePart, timePartRaw] = asctime.split(' ');
    if (!datePart || !timePartRaw) return asctime;
    const [year, month, day] = datePart.split('-');
    const timePart = timePartRaw.replace(',', ':');
    return `${day}-${month}-${year} ${timePart.slice(0, 8)}`;
  }

  function parseLogTimestamp(log) {
    if (!log) return Date.now();
    const raw = log.asctime || log.timestamp || '';
    if (raw) {
      const normalized = raw.replace(' ', 'T').replace(',', '.');
      const parsed = Date.parse(normalized);
      if (!Number.isNaN(parsed)) return parsed;
    }
    const ts = Number(log.ts || log.created || log.time || 0);
    if (Number.isFinite(ts)) {
      return ts > 1e12 ? ts : ts * 1000;
    }
    return Date.now();
  }

  function formatTimeOfDay(asctime) {
    if (!asctime) return '--:--:--';
    const parts = asctime.split(' ');
    if (parts.length < 2) return asctime.slice(0, 8);
    return parts[1].replace(',', ':').slice(0, 8);
  }

  function getUserKey(log) {
    const meta = log?.meta || log?.metadata || {};
    const candidate = (
      log?.user_id ??
      log?.usuario_id ??
      meta.user_id ??
      meta.usuario_id ??
      log?.usuario ??
      log?.user ??
      ''
    );
    return String(candidate || '').trim();
  }

  function getSessionKey(log) {
    const meta = log?.meta || log?.metadata || {};
    return String(log?.session_id ?? meta.session_id ?? '').trim();
  }

  function escapeHtml(str) {
    return (str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function shortenId(value) {
    if (!value) return '';
    const str = String(value);
    if (str.length <= 12) return str;
    return `${str.slice(0, 4)}…${str.slice(-4)}`;
  }

  function buildHaystack(log) {
    return [
      log.event,
      log.evento,
      log.accion,
      log.module,
      log.name,
      log.message,
      log.detail,
      log.descripcion,
      log.description,
      JSON.stringify(log.meta || log.metadata || ''),
      JSON.stringify(log.datos || '')
    ].join(' ').toLowerCase();
  }

  function extractStepLabel(log, type) {
    if (!log) return '';
    const meta = log.meta || log.metadata || {};
    const datos = log.datos || {};
    function fromUrl() {
      const rawUrl = meta.path || log.page_url || log.href || '';
      if (!rawUrl) return '';
      try {
        const parsed = new URL(rawUrl, window.location.origin);
        const cleanPath = parsed.pathname.replace(/\/+/g, '/').replace(/\/$/, '');
        const segments = cleanPath.split('/').filter(Boolean);
        return segments.slice(-1)[0] || cleanPath || rawUrl;
      } catch {
        const parts = rawUrl.split('/').filter(Boolean);
        return parts.slice(-1)[0] || rawUrl;
      }
    }
    const candidates = [
      meta.label,
      meta.action,
      meta.button,
      meta.step,
      datos.label,
      datos.action,
      datos.button,
      log.label,
      log.descripcion,
      log.description,
      log.evento,
      log.event,
      log.message,
      log.module,
      fromUrl()
    ];
    const chosen = candidates.find((val) => val && String(val).trim());
    if (chosen) {
      return String(chosen).trim().slice(0, 140);
    }
    if (type === 'click') return 'interfaz';
    if (type === 'delete') return 'eliminar';
    if (type === 'ingest') return 'ingesta';
    return '';
  }

  function detectMicroAction(log) {
    const haystack = buildHaystack(log);
    const evento = (log.evento || '').toLowerCase();
    for (const [type, pattern] of Object.entries(MICRO_ACTION_PATTERNS)) {
      if (pattern.test(haystack) || pattern.test(evento)) {
        const label = extractStepLabel(log, type);
        return { type, label };
      }
    }
    return null;
  }

  function formatDuration(ms) {
    if (!ms || ms < 250) return '<1s';
    const seconds = ms / 1000;
    if (seconds < 60) {
      return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
    }
    const minutes = Math.floor(seconds / 60);
    const remaining = Math.round(seconds % 60);
    return `${minutes}m ${remaining.toString().padStart(2, '0')}s`;
  }

  function microTypeLabel(type) {
    return MICRO_ACTION_SETTINGS[type]?.label || 'Secuencia';
  }

  function microTypeIcon(type) {
    return MICRO_ACTION_SETTINGS[type]?.icon || 'bi-diagram-3';
  }

  function buildMicroSummary(type, labels) {
    const clean = labels.map((label) => (label || '').trim()).filter(Boolean);
    if (!clean.length) {
      return MICRO_ACTION_SETTINGS[type]?.label || 'Secuencia';
    }
    if (type === 'click') {
      return `Click en ${clean.join(' → ')}`;
    }
    if (type === 'delete') {
      return `Eliminaciones: ${clean.join(' → ')}`;
    }
    if (type === 'ingest') {
      return `Ingestas: ${clean.join(' → ')}`;
    }
    return `${MICRO_ACTION_SETTINGS[type]?.label || 'Secuencia'}: ${clean.join(' → ')}`;
  }

  function compressMicroBursts(logs) {
    const result = [];
    let buffer = [];

    function flushBuffer() {
      if (!buffer.length) return;
      const type = buffer[0].micro.type;
      const settings = MICRO_ACTION_SETTINGS[type] || { minCount: 2 };
      if (buffer.length >= (settings.minCount || 2)) {
        const first = buffer[0];
        const last = buffer[buffer.length - 1];
        const combined = Object.assign({}, last.log);
        const labels = buffer.map((item) => item.label || type);
        combined.__isMicroGroup = true;
        combined.__groupId = `micro-group-${type}-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`;
        combined.microType = type;
        combined.microCount = buffer.length;
        combined.microDurationMs = Math.max(0, last.ts - first.ts);
        combined.microSteps = buffer.map((item) => ({
          label: item.label || type,
          asctime: item.log.asctime,
          log: item.log
        }));
        combined.microSummary = buildMicroSummary(type, labels);
        combined.event = `${type}_group`;
        combined.levelname = combined.levelname || 'INFO';
        combined.clickCount = combined.microCount;
        combined.clickDurationMs = combined.microDurationMs;
        combined.clickSummary = combined.microSummary;
        combined.clickLogs = combined.microSteps.map((step) => step.log);
        result.push(combined);
      } else {
        buffer.forEach((item) => result.push(item.log));
      }
      buffer = [];
    }

    logs.forEach((log) => {
      const micro = detectMicroAction(log);
      if (!micro) {
        flushBuffer();
        result.push(log);
        return;
      }
      const ts = parseLogTimestamp(log);
      const userKey = getUserKey(log);
      const sessionKey = getSessionKey(log);
      const settings = MICRO_ACTION_SETTINGS[micro.type] || { gap: 2500 };
      if (!buffer.length) {
        buffer.push({ log, ts, label: micro.label, micro, userKey, sessionKey });
        return;
      }
      const last = buffer[buffer.length - 1];
      const base = buffer[0];
      const gap = ts - last.ts;
      const sameType = micro.type === base.micro.type;
      const sameUser = !base.userKey || !userKey || base.userKey === userKey;
      const sameSession = !base.sessionKey || !sessionKey || base.sessionKey === sessionKey;
      if (sameType && gap <= (settings.gap || 2500) && sameUser && sameSession) {
        buffer.push({ log, ts, label: micro.label, micro, userKey, sessionKey });
      } else {
        flushBuffer();
        buffer.push({ log, ts, label: micro.label, micro, userKey, sessionKey });
      }
    });
    flushBuffer();
    return result;
  }

  function buildRunKey(log) {
    return [
      friendlyUserLabel(log).toLowerCase(),
      friendlyEventLabel(log).toLowerCase(),
      (log.module || '').toLowerCase()
    ].join('|');
  }

  function collapseRepeatedEvents(logs) {
    const collapsed = [];
    const summaries = [];
    let index = 0;
    while (index < logs.length) {
      const current = logs[index];
      if (current.__isMicroGroup) {
        collapsed.push(current);
        index += 1;
        continue;
      }
      const key = buildRunKey(current);
      let runLength = 1;
      let runner = index + 1;
      while (
        runner < logs.length &&
        !logs[runner].__isMicroGroup &&
        buildRunKey(logs[runner]) === key
      ) {
        runLength += 1;
        runner += 1;
      }
      if (runLength >= 5) {
        const summary = createCollapsedRun(logs.slice(index, runner));
        collapsed.push(summary);
        summaries.push(summary);
      } else {
        collapsed.push(...logs.slice(index, runner));
      }
      index = runner;
    }
    return { collapsedLogs: collapsed, collapsedRuns: summaries };
  }

  function createCollapsedRun(runLogs) {
    const first = runLogs[0];
    return {
      __isCollapsedRun: true,
      collapsedCount: runLogs.length,
      collapsedLabel: friendlyEventLabel(first),
      collapsedUser: friendlyUserLabel(first),
      collapsedModule: friendlyModuleLabel(first),
      collapsedSource: friendlySourceLabel(first.source),
      collapsedSummary: buildSummaryLine(first),
      collapsedSamples: runLogs.slice(0, 3),
      asctime: first.asctime,
      sampleLog: first
    };
  }

  function prepareDisplayLogs(logs) {
    const hasUserFilter = Boolean((timelineEl?.dataset?.currentUser || '').trim());
    const importantLogs = hasUserFilter ? logs : logs.filter(isImportantEvent);
    const hasImportant = Boolean(importantLogs.length);
    const fallbackLogs = !hasUserFilter && !hasImportant && logs.length
      ? logs.slice(0, 150)
      : [];
    const baseLogs = hasUserFilter ? importantLogs : (hasImportant ? importantLogs : fallbackLogs);
    const { collapsedLogs, collapsedRuns } = collapseRepeatedEvents(baseLogs);
    return {
      displayLogs: collapsedLogs,
      baseLogs,
      collapsedRuns,
      microGroups: baseLogs.filter((log) => log.__isMicroGroup),
      hasUserFilter,
      usedFallback: !hasUserFilter && !hasImportant && Boolean(logs.length)
    };
  }

  function classifyAction(log) {
    const haystack = buildHaystack(log);
    if (/elimin|delete|borrar|remov/i.test(haystack)) return 'eliminó';
    if (/ingest|guardar|insert|crear|registr|actualiz/i.test(haystack)) return 'registró';
    if (/error|fail|exception|forbidden|not found|timeout|denied/.test(haystack)) return 'generó un error en';
    if (/login|ingres|acces|sesion/.test(haystack)) return 'ingresó a';
    if (/click|clic|pulse/.test(haystack)) return 'hizo click en';
    return 'interactuó con';
  }

  function extractDetail(log) {
    const friendly = friendlyEventLabel(log);
    if (friendly && friendly !== 'Evento') {
      return friendly;
    }
    if (log.pieza) return String(log.pieza);
    const candidates = [
      log.descripcion,
      log.description,
      log.message,
      log.detail,
      log.module,
      log.name
    ];
    for (const text of candidates) {
      if (text && String(text).trim()) {
        return String(text).trim().slice(0, 140);
      }
    }
    return '';
  }

  function buildSummaryLine(log) {
    const userLabel = escapeHtml(friendlyUserLabel(log));
    const actionLabel = classifyAction(log);
    const detail = extractDetail(log);
    return `${userLabel} ${actionLabel} ${escapeHtml(detail || '')}`.trim();
  }

  function buildActionDetail(log) {
    const meta = log.meta || log.metadata || {};
    const datos = log.datos || {};
    if ((log.source || '').toLowerCase() === 'bluetooth' && datos.name) {
      return `en impresora ${escapeHtml(String(datos.name))}`;
    }
    if (meta.path) {
      return `en ${escapeHtml(String(meta.path))}`;
    }
    if (meta.label) {
      return `sobre ${escapeHtml(String(meta.label))}`;
    }
    if (log.href) {
      return `en ${escapeHtml(String(log.href))}`;
    }
    const haystack = buildHaystack(log);
    const match = haystack.match(/(\/[A-Za-z0-9_\-\/]+)/);
    if (match) {
      return `en ${escapeHtml(match[1])}`;
    }
    return '';
  }

  function humanizeText(value) {
    return String(value || '')
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\b\w/g, (c) => c.toUpperCase()) || 'Evento';
  }

  function translateEventLabel(value) {
    if (!value) return '';
    const raw = String(value).trim();
    if (!raw) return '';
    const key = raw
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    return EVENT_TRANSLATIONS[key] || '';
  }

  function friendlySourceLabel(source) {
    if (!source) return 'Sistema';
    const key = String(source).toLowerCase();
    return SOURCE_LABELS[key] || 'Sistema';
  }

  function friendlyUserLabel(log) {
    const meta = log.meta || log.metadata || {};
    const datos = log.datos || {};
    const candidates = [
      meta.user_label,
      meta.user_name,
      meta.username,
      meta.usuario,
      meta.owner,
      meta.operator,
      log.usuario_nombre,
      log.usuario,
      log.usuario_label,
      log.operator_label,
      log.operator,
      log.username,
      log.user,
      log.user_label,
      datos.usuario,
      datos.user_label,
      datos.operator,
      log.user_id ? `Usuario #${log.user_id}` : '',
      log.usuario_id ? `Usuario #${log.usuario_id}` : ''
    ];
    const label = candidates.find((val) => val && String(val).trim());
    if (label) {
      return String(label).trim();
    }
    const fallbackId = meta.user_id || meta.usuario_id || log.user_id || log.usuario_id;
    if (fallbackId) {
      return `Usuario #${fallbackId}`;
    }
    return 'Usuario sin identificar';
  }

  function friendlyModuleLabel(log) {
    const meta = log.meta || log.metadata || {};
    const tag = meta.module_label || meta.module || log.module || log.name || log.category || '';
    if (!tag) return 'Sin módulo';
    return humanizeText(tag);
  }

  function friendlyEventLabel(log) {
    const meta = log.meta || log.metadata || {};
    const datos = log.datos || {};
    const candidates = [
      meta.event_label,
      meta.action,
      meta.label,
      meta.button,
      meta.step,
      datos.label,
      datos.action,
      datos.button,
      log.descripcion,
      log.description,
      log.evento,
      log.event,
      log.message,
      log.detail
    ];
    const label = candidates.find((val) => val && String(val).trim());
    if (label) {
      const translated = translateEventLabel(label);
      return translated || humanizeText(label);
    }
    const fallbackTranslated = translateEventLabel(log.event || log.evento || '');
    if (fallbackTranslated) {
      return fallbackTranslated;
    }
    return 'Evento';
  }

  function isImportantEvent(log) {
    if (!log) return false;
    if (log.__isMicroGroup) return true;
    const level = (log.levelname || log.level || '').toUpperCase();
    if (['ERROR', 'WARNING', 'CRITICAL'].includes(level)) {
      return true;
    }
    const source = (log.source || '').toLowerCase();
    if (source === 'bluetooth') {
      return true;
    }
    const eventKey = (log.event || log.evento || '').toLowerCase();
    if (IMPORTANT_EVENT_SET.has(eventKey)) {
      return true;
    }
    const haystack = buildHaystack(log);
    if (/(error|fall|timeout|rechaz|desconect|impresora|voz|transcrip|barcode|ingest|public|guard|imprimir)/i.test(haystack)) {
      return true;
    }
    return false;
  }

  function renderLogs(logs, options = {}) {
    if (!timelineEl) return;
    const {
      baseCount = logs.length,
      summaryLogs = logs,
      hasUserFilter = false,
      usedFallback = false
    } = options;
    placeholder?.classList.add('d-none');
    if (!logs.length) {
      timelineEl.innerHTML = '<div class="text-center text-muted py-4">No hay eventos para mostrar con estos filtros.</div>';
      if (countBadge) {
        countBadge.textContent = baseCount ? `0 / ${baseCount}` : '0';
      }
      if (!hasUserFilter) {
        setInfoMessage('No encontramos eventos relevantes en este rango. Ajusta los filtros o reduce los criterios.', 'info');
      } else {
        setInfoMessage('');
      }
      updateSummaries([]);
      return;
    }
    const openDetailKeys = captureOpenLogDetailKeys();
    const rows = logs.map((log, idx) => renderLogCard(log, idx)).join('');
    timelineEl.innerHTML = rows;
    restoreOpenLogDetailKeys(openDetailKeys);
    if (countBadge) {
      countBadge.textContent = baseCount && baseCount !== logs.length
        ? `${logs.length} / ${baseCount}`
        : `${logs.length}`;
    }
    if (!hasUserFilter) {
      if (usedFallback) {
        setInfoMessage('Mostramos los eventos más recientes porque no detectamos actividad prioritaria en este rango.', 'warning');
      } else {
        setInfoMessage('Agrupamos eventos repetidos y mostramos la actividad importante. Filtra por usuario para ver cada acción.', 'info');
      }
    } else {
      setInfoMessage('');
    }
    updateSummaries(summaryLogs);
  }

  function renderLogCard(log, idx) {
    if (log.__isCollapsedRun) {
      return renderCollapsedLogCard(log, idx);
    }
    const isMicroGroup = Boolean(log.__isMicroGroup);
    const level = (log.levelname || log.level || 'INFO').toUpperCase();
    let levelClass = 'info';
    let badgeClass = isMicroGroup ? 'bg-info-subtle text-info-emphasis' : 'bg-success';
    switch (level) {
      case 'ERROR':
        levelClass = 'error';
        badgeClass = 'bg-danger';
        break;
      case 'CRITICAL':
        levelClass = 'critical';
        badgeClass = 'bg-danger text-white';
        break;
      case 'WARNING':
        levelClass = 'warning';
        badgeClass = 'bg-warning text-dark';
        break;
      case 'DEBUG':
        levelClass = 'debug';
        badgeClass = 'bg-secondary';
        break;
      default:
        break;
    }
    const logKey = buildLogDomKey(log, idx);
    const detailId = `log-detail-${logKey}-${idx}`;
    const jsonPayload = escapeHtml(JSON.stringify(log, null, 2));
    const summaryLine = isMicroGroup
      ? `${escapeHtml(log.microSummary || microTypeLabel(log.microType))} ×${log.microCount || log.clickCount}`
      : buildSummaryLine(log);
    const actionDetail = isMicroGroup ? '' : buildActionDetail(log);
    const metaItems = [
      `<span><i class="bi bi-person"></i>${escapeHtml(friendlyUserLabel(log))}</span>`,
      `<span><i class="bi bi-diagram-3"></i>${escapeHtml(friendlySourceLabel(log.source))}</span>`,
      `<span><i class="bi bi-gear"></i>${escapeHtml(friendlyModuleLabel(log))}</span>`
    ];
    if (isMicroGroup) {
      metaItems.push(`<span><i class="bi ${microTypeIcon(log.microType)}"></i>${microTypeLabel(log.microType)}</span>`);
    } else if (log.duration_ms) {
      metaItems.push(`<span><i class="bi bi-stopwatch"></i>${log.duration_ms} ms</span>`);
    }
    const detailContent = isMicroGroup
      ? renderMicroDetail(log)
      : renderStandardDetail(log);
    const correlationButton = log.correlation_id
      ? `<button class="btn btn-sm btn-link text-decoration-none log-load-audit" data-correlation="${log.correlation_id}">
            <i class="bi bi-diagram-3-fill me-1"></i>Ver auditoría
         </button>`
      : '';
    return `
      <article class="log-entry-card" data-log-key="${logKey}">
        <span class="log-entry-node ${levelClass}"></span>
        <div class="log-entry-shell ${levelClass}">
          <div class="log-entry-header">
            <div>
              <div class="timestamp">${formatDate(log.asctime)}</div>
              <small>${escapeHtml(friendlyEventLabel(log))}</small>
            </div>
            <span class="badge ${badgeClass}">${level}</span>
          </div>
          <div class="log-entry-body">
            <div class="log-entry-summary">${summaryLine} ${actionDetail}</div>
          </div>
          <div class="log-entry-meta mt-2">
            ${metaItems.join('')}
          </div>
          <div class="log-entry-actions">
            <button class="btn btn-sm btn-outline-primary log-toggle" data-log-toggle="${detailId}">
              <i class="bi bi-chevron-down me-1"></i>Ver detalle
            </button>
            ${correlationButton}
          </div>
          <div class="log-entry-detail-panel collapse" id="${detailId}" data-log-key="${logKey}">
            ${detailContent}
            <div class="d-flex justify-content-between align-items-center mb-2">
              <span class="text-muted small">Ver datos completos</span>
              <button class="btn btn-sm btn-link text-decoration-none log-copy" data-copy-target="${detailId}">
                <i class="bi bi-clipboard"></i> Copiar
              </button>
            </div>
            <pre class="log-json" id="${detailId}-json">${jsonPayload}</pre>
          </div>
        </div>
      </article>
    `;
  }

  function renderMicroDetail(log) {
    const chainView = (log.microSteps || []).map((step) => escapeHtml(step.label || '')).filter(Boolean).join(' &rarr; ');
    const detailList = (log.microSteps || log.clickLogs || []).map((entry) => {
      const ts = formatTimeOfDay(entry.asctime);
      const label = escapeHtml(entry.label || extractStepLabel(entry, log.microType) || 'Paso');
      return `<li><strong>${ts}</strong> · ${label}</li>`;
    }).join('') || '<li>Sin detalle disponible</li>';
    return `
      <div class="mb-3">
        <div class="fw-semibold text-uppercase small text-primary">${escapeHtml(microTypeLabel(log.microType))}</div>
        <p class="text-muted mb-2">Se detectaron ${log.microCount || log.clickCount} eventos parecidos en ${formatDuration(log.microDurationMs)}.</p>
        ${chainView ? `<div class="fw-semibold small text-uppercase mb-2">${chainView}</div>` : ''}
        <ul class="click-summary-list">${detailList}</ul>
      </div>
    `;
  }

  function renderStandardDetail(log) {
    const detailFallback = escapeHtml(log.message || log.detail || log.descripcion || 'Sin descripción adicional.');
    return `
      <div class="mb-3">
        <div class="fw-semibold text-uppercase small text-primary">${escapeHtml(friendlyEventLabel(log))}</div>
        <p class="text-muted mb-2">${detailFallback}</p>
        ${renderTechnicalDetails(log)}
      </div>
    `;
  }

  function renderTechnicalDetails(log) {
    const meta = log.meta || log.metadata || {};
    const bits = [];
    const sessionId = log.session_id || meta.session_id;
    const requestId = log.request_id || meta.request_id;
    const correlationId = log.correlation_id || meta.correlation_id;
    if (sessionId) bits.push(`Sesión ${escapeHtml(shortenId(sessionId))}`);
    if (requestId) bits.push(`Solicitud ${escapeHtml(shortenId(requestId))}`);
    if (correlationId) bits.push(`Correlación ${escapeHtml(shortenId(correlationId))}`);
    if (!bits.length) return '';
    return `<div class="text-muted small mb-2">${bits.join(' · ')}</div>`;
  }

  function renderCollapsedLogCard(log, idx) {
    const detailId = `collapsed-detail-${idx}-${Math.random().toString(16).slice(2, 6)}`;
    const listItems = (log.collapsedSamples || []).map((sample) => {
      const ts = formatTimeOfDay(sample.asctime);
      return `<li><strong>${ts}</strong> · ${escapeHtml(friendlyEventLabel(sample))}</li>`;
    }).join('') || '<li>Sin ejemplos disponibles</li>';
    return `
      <article class="log-entry-card">
        <span class="log-entry-node info"></span>
        <div class="log-entry-shell info">
          <div class="log-entry-header">
            <div>
              <div class="timestamp">Eventos agrupados</div>
              <small>${escapeHtml(log.collapsedUser)}</small>
            </div>
            <span class="badge bg-info-subtle text-info-emphasis">×${log.collapsedCount}</span>
          </div>
          <div class="log-entry-body">
            <div class="log-entry-summary">${escapeHtml(log.collapsedSummary || '')}</div>
            <p class="text-muted mb-2">Agrupamos acciones idénticas para evitar ruido visual.</p>
          </div>
          <div class="log-entry-meta mt-2">
            <span><i class="bi bi-diagram-3"></i>${escapeHtml(log.collapsedSource || 'Sistema')}</span>
            <span><i class="bi bi-gear"></i>${escapeHtml(log.collapsedModule || 'Módulo')}</span>
          </div>
          <div class="log-entry-detail-panel collapse show" id="${detailId}">
            <div class="mb-2">
              <div class="fw-semibold text-uppercase small text-primary">${escapeHtml(log.collapsedLabel)}</div>
              <p class="text-muted mb-2">Ejemplos recientes:</p>
              <ul class="click-summary-list">
                ${listItems}
              </ul>
            </div>
          </div>
        </div>
      </article>
    `;
  }

  function renderSummary(metaInfo) {
    if (!metaInfo) {
      if (metricTotal) metricTotal.textContent = '--';
      if (metricErrors) metricErrors.textContent = '--';
      if (metricLast) metricLast.textContent = '--';
      if (metricLastSource) metricLastSource.textContent = '-';
      if (metricTotalExtra) metricTotalExtra.textContent = '';
      return;
    }
    if (metricTotal) {
      metricTotal.textContent = metaInfo.total ?? '--';
      if (metricTotalExtra) {
        const sourceCounts = metaInfo.source_counts || {};
        const summary = Object.entries(sourceCounts)
          .map(([source, value]) => `${friendlySourceLabel(source)}: ${value}`)
          .join(' · ');
        metricTotalExtra.textContent = summary || 'Sin registros en el rango';
      }
    }
    if (metricErrors) {
      metricErrors.textContent = metaInfo.error_count ?? 0;
    }
    if (metricLast) {
      metricLast.textContent = metaInfo.latest_label || '--';
      if (metricLastSource) {
        const primarySource = Object.entries(metaInfo.source_counts || {})
          .sort((a, b) => b[1] - a[1])[0]?.[0];
        const label = primarySource ? friendlySourceLabel(primarySource) : null;
        metricLastSource.textContent = label ? `Fuente: ${label}` : '-';
      }
    }
  }

  function renderAggregationSummary(microGroups, collapsedRuns) {
    if (!aggregationList || !aggregationBadge || !aggregationPanel) return;
    const openKeys = captureOpenAggregationKeys();
    const items = [];
    microGroups.forEach((group, idx) => items.push(renderMicroAggregationItem(group, idx)));
    collapsedRuns.forEach((run, idx) => items.push(renderCollapsedAggregationItem(run, idx)));
    if (!items.length) {
      aggregationList.innerHTML = '<div class="text-muted small">Sin agrupaciones detectadas.</div>';
      aggregationBadge.textContent = '0 agrupaciones';
      aggregationPanel.classList.add('d-none');
      return;
    }
    aggregationBadge.textContent = `${items.length} ${items.length === 1 ? 'agrupación' : 'agrupaciones'}`;
    aggregationList.innerHTML = items.join('');
    restoreOpenAggregationKeys(openKeys);
    aggregationPanel.classList.remove('d-none');
  }

  function renderMicroAggregationItem(group, idx) {
    const duration = formatDuration(group.microDurationMs);
    const microKey = sanitizeDomKey(
      group.__groupId || `${group.microType || 'micro'}-${group.microCount || group.clickCount || 0}-${idx}`,
      `micro-${idx}`
    );
    const detailId = `micro-group-${microKey}-${idx}`;
    const steps = group.microSteps || [];
    const chain = steps.map((step) => escapeHtml(step.label || '')).filter(Boolean).join(' &rarr; ') || escapeHtml(group.microSummary || microTypeLabel(group.microType));
    const listItems = steps.map((step) => {
      const ts = formatTimeOfDay(step.asctime);
      const label = escapeHtml(step.label || '');
      return `<li><strong>${ts}</strong> · ${label}</li>`;
    }).join('') || '<li>Sin detalle disponible</li>';
    const icon = microTypeIcon(group.microType);
    const title = microTypeLabel(group.microType);
    return `
      <div class="click-summary-item micro-dropdown">
        <button class="micro-dropdown-toggle" type="button" data-micro-toggle="${detailId}" data-micro-key="${microKey}" aria-expanded="false" aria-controls="${detailId}">
          <div class="micro-dropdown-meta">
            <div class="d-flex align-items-center flex-wrap gap-2">
              <strong><i class="bi ${icon} me-1"></i>${title}</strong>
              <span class="badge bg-primary-subtle text-primary-emphasis">×${group.microCount || group.clickCount}</span>
            </div>
            <small class="text-muted">${duration}</small>
          </div>
          <i class="bi bi-chevron-down micro-dropdown-icon"></i>
        </button>
        <div class="micro-dropdown-body collapse" id="${detailId}" data-micro-key="${microKey}">
          ${chain ? `<div class="micro-chain mb-2">${chain}</div>` : ''}
          <ul class="click-summary-list" id="${detailId}-list">
            ${listItems}
          </ul>
        </div>
      </div>
    `;
  }

  function renderCollapsedAggregationItem(run, idx) {
    const collapseKey = sanitizeDomKey(
      run.collapsedKey || `${run.collapsedLabel || 'collapsed'}-${run.collapsedCount || 0}-${idx}`,
      `collapsed-${idx}`
    );
    const detailId = `collapsed-summary-${collapseKey}-${idx}`;
    const listItems = (run.collapsedSamples || []).map((sample) => {
      const ts = formatTimeOfDay(sample.asctime);
      return `<li><strong>${ts}</strong> · ${escapeHtml(friendlyEventLabel(sample))}</li>`;
    }).join('') || '<li>Sin ejemplos disponibles</li>';
    return `
      <div class="click-summary-item micro-dropdown">
        <button class="micro-dropdown-toggle" type="button" data-micro-toggle="${detailId}" data-micro-key="${collapseKey}" aria-expanded="false" aria-controls="${detailId}">
          <div class="micro-dropdown-meta">
            <div class="d-flex align-items-center flex-wrap gap-2">
              <strong><i class="bi bi-layers me-1"></i>${escapeHtml(run.collapsedLabel)}</strong>
              <span class="badge bg-primary-subtle text-primary-emphasis">×${run.collapsedCount}</span>
            </div>
            <small class="text-muted">Agrupados para evitar ruido visual</small>
          </div>
          <i class="bi bi-chevron-down micro-dropdown-icon"></i>
        </button>
        <div class="micro-dropdown-body collapse" id="${detailId}" data-micro-key="${collapseKey}">
          <div class="micro-chain mb-2">${escapeHtml(run.collapsedSummary || '')}</div>
          <ul class="click-summary-list">
            ${listItems}
          </ul>
        </div>
      </div>
    `;
  }

  function updateSummaries(logs) {
    if (!userSummaryList || !typeSummaryList) return;
    if (!logs.length) {
      userSummaryList.innerHTML = '<div class="text-muted small">Sin datos</div>';
      typeSummaryList.innerHTML = '<div class="text-muted small">Sin datos</div>';
      return;
    }
    const userMap = new Map();
    const typeCounts = {
      eliminaciones: 0,
      clicks: 0,
      ingresos: 0,
      impresiones: 0
    };

    logs.forEach((log) => {
      const weight = log.__isMicroGroup ? (log.microCount || log.clickCount || 1) : 1;
      const userKey = friendlyUserLabel(log);
      userMap.set(userKey, (userMap.get(userKey) || 0) + weight);

      const haystack = buildHaystack(log);

      if (/(eliminar|delete|borrar)/.test(haystack)) {
        typeCounts.eliminaciones += weight;
      }
      if (/(click|pulse|clic)/.test(haystack)) {
        typeCounts.clicks += weight;
      }
      if (/(ingresar|login|acceso|entr[oó])/.test(haystack)) {
        typeCounts.ingresos += weight;
      }
      if (/(impresora|autowatch|barcode|etiqueta|bt_event)/i.test(haystack)) {
        typeCounts.impresiones += weight;
      }
    });

    const topUsers = Array.from(userMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([user, count]) => `<div class="d-flex justify-content-between py-1"><span>${escapeHtml(user)}</span><strong>${count}</strong></div>`)
      .join('');
    userSummaryList.innerHTML = topUsers || '<div class="text-muted small">Sin actividad destacada</div>';

    typeSummaryList.innerHTML = `
      <div class="d-flex justify-content-between py-1">
        <span><i class="bi bi-trash me-1 text-danger"></i>Eliminaciones</span><strong>${typeCounts.eliminaciones}</strong>
      </div>
      <div class="d-flex justify-content-between py-1">
        <span><i class="bi bi-mouse me-1 text-primary"></i>Clicks</span><strong>${typeCounts.clicks}</strong>
      </div>
      <div class="d-flex justify-content-between py-1">
        <span><i class="bi bi-box-arrow-in-right me-1 text-success"></i>Ingresos</span><strong>${typeCounts.ingresos}</strong>
      </div>
      <div class="d-flex justify-content-between py-1">
        <span><i class="bi bi-printer me-1 text-info"></i>Impresiones</span><strong>${typeCounts.impresiones}</strong>
      </div>
    `;
  }

  async function fetchLogs(force = false) {
    if (!apiUrl || !state) return;
    if (state.isFetching && !force) return;
    if (state.abortController) {
      state.abortController.abort();
    }
    state.abortController = new AbortController();
    const timeoutId = window.setTimeout(() => {
      state.abortController?.abort();
    }, FETCH_TIMEOUT_MS);
    state.isFetching = true;
    setInfoMessage('Actualizando eventos...', 'info');
    appendViewerLog('Solicitando eventos al servidor...', 'info');
    placeholder?.classList.remove('d-none');
    let aborted = false;
    try {
      const params = new URLSearchParams(window.location.search);
      const res = await fetch(`${apiUrl}?${params.toString()}`, { signal: state.abortController.signal });
      if (!res.ok) {
        if (res.status === 403) {
          throw new Error('No tienes permisos para ver los logs (403).');
        }
        throw new Error(`Respuesta no válida (${res.status})`);
      }
      const data = await res.json();
      if (meta) {
        meta.textContent = new Date().toLocaleTimeString('es-CL', { hour12: false });
      }
      const rawLogs = data.logs || [];
      state.cachedLogs = compressMicroBursts(rawLogs);
      const prepared = prepareDisplayLogs(state.cachedLogs);
      state.collapsedRuns = prepared.collapsedRuns;
      renderSummary(data.meta || {});
      renderAggregationSummary(prepared.microGroups, prepared.collapsedRuns);
      renderLogs(prepared.displayLogs, {
        baseCount: prepared.baseLogs.length,
        summaryLogs: prepared.baseLogs,
        hasUserFilter: prepared.hasUserFilter,
        usedFallback: prepared.usedFallback
      });
      appendViewerLog(`Recibimos ${data.count || 0} eventos (total ${data.meta?.total ?? 'desconocido'}).`, 'success');
      if (prepared.usedFallback) {
        appendViewerLog('No se detectó actividad prioritaria; mostrando los registros más recientes disponibles.', 'warning');
      }
    } catch (error) {
      if (error.name === 'AbortError') {
        aborted = true;
        appendViewerLog('Actualización cancelada (timeout o navegación).', 'warning');
      } else {
        console.error(error);
        if (timelineEl) {
          timelineEl.innerHTML = '<div class="text-center text-danger py-4">Error cargando logs</div>';
        }
        setInfoMessage('No se pudieron obtener los registros. Revisa tu conexión o intenta nuevamente.', 'danger');
      appendViewerLog(`Error cargando registros: ${error.message}`, 'danger');
      }
    } finally {
      window.clearTimeout(timeoutId);
      if (state) {
        state.isFetching = false;
      }
      placeholder?.classList.add('d-none');
      if (!aborted) {
        appendViewerLog('Actualización completada.', 'info');
      }
      scheduleRefresh();
    }
  }

  function renderAuditEvents(events) {
    if (!auditTimeline) return;
    if (!events.length) {
      auditTimeline.innerHTML = '<div class="text-center text-muted py-4">Sin registros</div>';
      return;
    }
    const rows = events.map((ev, idx) => {
      const levelClass = ev.nivel || 'info';
      const detailId = `audit-detail-${ev.id || idx}`;
      const pseudoLog = {
        asctime: (ev.timestamp || '').replace('T', ' ').replace('Z', '').split('.')[0],
        user: ev.usuario,
        user_id: ev.usuario_id,
        event: ev.accion,
        accion: ev.accion,
        module: ev.categoria,
        pieza: ev.pieza,
        sesion_voz_id: ev.sesion_voz_id,
        message: ev.descripcion,
        descripcion: ev.descripcion
      };
      const summary = buildSummaryLine(pseudoLog);
      const actionDetail = buildActionDetail(pseudoLog);
      return `
        <article class="log-entry-card">
          <span class="log-entry-node ${levelClass}"></span>
          <div class="log-entry-shell ${levelClass}">
            <div class="log-entry-header">
              <div>
                <div class="timestamp">${(new Date(ev.timestamp)).toLocaleString('es-CL')}</div>
                <small>${ev.correlation_id || 'sin correlación'}</small>
              </div>
              <span class="badge bg-secondary text-uppercase">${ev.categoria}</span>
            </div>
            <div class="log-entry-body">
              <div class="log-entry-summary">${summary} ${actionDetail}</div>
            </div>
            <div class="log-entry-meta mt-2">
              <span><i class="bi bi-person"></i>${ev.usuario || '-'}</span>
              <span><i class="bi bi-box"></i>${ev.pieza || 'Sin pieza'}</span>
              <span><i class="bi bi-lightning"></i>${ev.exito ? 'Éxito' : 'Error'}</span>
              <span><i class="bi bi-clock"></i>${ev.duracion_ms || 0} ms</span>
            </div>
            <div class="log-entry-detail-panel mt-3">
              <div class="mb-3">
                <div class="fw-semibold text-uppercase small text-primary">${ev.accion}</div>
                <p class="text-muted mb-2">${escapeHtml(ev.descripcion || '')}</p>
              </div>
              <pre class="log-json" id="${detailId}">${escapeHtml(JSON.stringify(ev.datos || {}, null, 2))}</pre>
            </div>
          </div>
        </article>
      `;
    }).join('');
    auditTimeline.innerHTML = rows;
  }

  async function fetchAuditEvents(params) {
    if (!auditTimeline || !auditUrl) return;
    const query = params instanceof URLSearchParams ? params : new URLSearchParams(params);
    try {
      appendViewerLog('Consultando auditoría estructurada...', 'info');
      auditTimeline.innerHTML = '<div class="text-center text-muted py-4">Cargando auditoría...</div>';
      auditStatus.textContent = 'Consultando...';
      const res = await fetch(`${auditUrl}?${query.toString()}`);
      if (!res.ok) {
        if (res.status === 403) {
          throw new Error('Sin permisos para la auditoría (403).');
        }
        throw new Error(`Error consultando auditoría (${res.status})`);
      }
      const data = await res.json();
      if (!data?.success) {
        throw new Error(data?.error || 'Sin datos');
      }
      renderAuditEvents(data.events || []);
      auditStatus.textContent = `${(data.events || []).length} eventos`;
      appendViewerLog(`Auditoría lista: ${(data.events || []).length} eventos.`, 'success');
    } catch (err) {
      console.error(err);
      auditTimeline.innerHTML = '<div class="text-center text-danger py-4">No se pudo cargar la auditoría</div>';
      if (auditStatus) auditStatus.textContent = 'Error';
      appendViewerLog(`Error al consultar la auditoría estructurada: ${err.message}`, 'danger');
    }
  }

  function syncFormWithLocation() {
    if (!filterForm) return;
    const params = new URLSearchParams(window.location.search);
    filterForm.querySelectorAll('input, select').forEach((input) => {
      if (!input.name) return;
      const current = params.get(input.name) || '';
      if (input.value !== current) {
        input.value = current;
      }
    });
  }
})();
