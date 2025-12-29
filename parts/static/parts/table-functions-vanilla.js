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
  function getCsrfToken(){
    const cookie = getCookie('csrftoken');
    if (cookie && cookie.length > 20) return cookie;
    const meta = document.querySelector('meta[name="csrf-token"]');
    if (meta && meta.content && meta.content.length > 20) return meta.content;
    return null;
  }
  function formatCurrencyCL(value){
    const n = parseInt(value, 10);
    if (!n) return '-';
    return '$' + n.toLocaleString('es-CL');
  }
  const FILTERS_KEY = 'columnFilters';
  const MAX_HISTORY = 50;
  const MAX_PHOTO_SIZE = 1080;
  const undoStack = [];
  const redoStack = [];
  const photoCache = {};
  const photoUploadInput = document.getElementById('photo-upload-input');
  const photoUploadCanvas = document.createElement('canvas');
  const displayCounter = document.getElementById('parts-display-counter');
  const STATUS_META = {
    disponible: {
      label: 'Disponible',
      icon: 'far fa-circle',
      btnClass: 'btn-outline-success'
    },
    vendido: {
      label: 'Vendido',
      icon: 'fas fa-check-circle',
      btnClass: 'btn-success'
    },
    no_disponible: {
      label: 'No disponible',
      icon: 'fas fa-triangle-exclamation',
      btnClass: 'btn-warning text-dark'
    }
  };
  const REQUIRED_FIELD_LABELS = {
    name: 'Nombre',
    min_value: 'Último precio',
    workshop: 'Ubicación'
  };
  const REQUIRED_FIELDS = Object.keys(REQUIRED_FIELD_LABELS);
  const MISSING_DELIMITER = '|';
  const DETAIL_BREAK_REGEX = /(veh[íi]culo|vehiculo|auto|posici[óo]n|ubicaci[óo]n|nota|observaciones?|detalle|precio es|último precio|ultimo precio)\s*:?/gi;
  const DETAIL_META_PREFIXES = ['vehiculo', 'auto', 'posicion', 'ubicacion', 'nota', 'precio es', 'ultimo precio'];
  const DETAIL_OBS_PREFIXES = ['observaciones', 'observacion'];
  const DETAIL_VALUE_PREFIXES = ['detalle'];
  let activePhotoUploadPartId = null;

  function computeDisplayLimit(){
    if (!displayCounter) return null;
    const start = parseInt(displayCounter.dataset.start || '1', 10);
    const current = parseInt(displayCounter.dataset.current || '0', 10);
    if (!Number.isFinite(current) || current <= 0) return null;
    const limit = current - start + 1;
    return limit > 0 ? limit : null;
  }

  function markLimitHidden(element, hidden){
    if (!element) return;
    if (hidden){
      element.dataset.hiddenByLimit = '1';
      element.classList.add('limit-hidden');
      element.style.display = 'none';
    } else if (element.dataset.hiddenByLimit){
      delete element.dataset.hiddenByLimit;
      element.classList.remove('limit-hidden');
      if (element.dataset.filterHidden === '1'){
        return;
      }
      element.style.display = '';
    }
  }

  function enforceVisibleLimit(){
    const limit = computeDisplayLimit();
    if (!limit){
      qsa('[data-hidden-by-limit="1"]').forEach(el => markLimitHidden(el, false));
      return;
    }
    const allowedIds = new Set();
    let visibleCount = 0;

    qsa('#parts-table tbody tr.part-row').forEach(row => {
      const partId = row.dataset.partId || `row-${visibleCount}`;
      if (row.dataset.filterHidden === '1'){
        markLimitHidden(row, false);
        return;
      }
      if (visibleCount < limit){
        allowedIds.add(partId);
        markLimitHidden(row, false);
        visibleCount += 1;
      } else {
        markLimitHidden(row, true);
      }
    });

    qsa('.part-row-mobile').forEach(card => {
      const partId = card.dataset.partId || '';
      if (card.dataset.filterHidden === '1'){
        markLimitHidden(card, false);
        return;
      }
      if (!partId || allowedIds.has(partId)){
        markLimitHidden(card, false);
      } else {
        markLimitHidden(card, true);
      }
    });
  }

  function escapeHtml(str){
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function normalizePrefix(str){
    if (!str) return '';
    let base = str;
    if (typeof base.normalize === 'function'){
      base = base.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    }
    return base.split(':')[0].trim().toLowerCase();
  }

  function injectDetailBreaks(str){
    if (!str) return '';
    return str.replace(DETAIL_BREAK_REGEX, function(match, _prefix, offset, src){
      const needsBreak = offset > 0 && src[offset - 1] !== '\n';
      return `${needsBreak ? '\n' : ''}${match}`;
    });
  }

  function parseDetailText(raw){
    const prepared = injectDetailBreaks(String(raw || '').replace(/\r/g, '\n'));
    const lines = prepared.split(/\n+/).map(line => line.trim()).filter(Boolean);
    const detailParts = [];
    const observations = [];
    lines.forEach(line => {
      const prefix = normalizePrefix(line);
      const valuePart = line.includes(':') ? line.split(':').slice(1).join(':').trim() : '';
      if (DETAIL_OBS_PREFIXES.some(obs => prefix.startsWith(obs))){
        if (valuePart) observations.push(valuePart);
        return;
      }
      if (DETAIL_META_PREFIXES.some(meta => prefix.startsWith(meta))){
        return;
      }
      if (DETAIL_VALUE_PREFIXES.some(det => prefix.startsWith(det))){
        if (valuePart) detailParts.push(valuePart);
        return;
      }
      detailParts.push(line);
    });
    return {
      detail: detailParts.join(' ').trim(),
      observations: observations.join(' ').trim()
    };
  }

  function buildDescriptionMarkup(value, options={}){
    const trimmed = (value || '').toString();
    const catalogName = (options.catalogName || '').trim();
    const parts = parseDetailText(trimmed);
    const sections = [];
    if (catalogName){
      sections.push({ label: 'Nombre original', value: escapeHtml(catalogName) });
    }
    if (parts.detail){
      sections.push({ label: 'Detalle', value: escapeHtml(parts.detail) });
    }
    if (parts.observations){
      sections.push({ label: 'Observaciones', value: escapeHtml(parts.observations) });
    }
    if (!sections.length){
      const safe = escapeHtml(trimmed.trim());
      if (!safe){
        return '<span class="text-muted">-</span>';
      }
      sections.push({ label: '', value: safe });
    }
    let html = '<div class="description-shell" data-description-shell>';
    html += '<div class="description-toggle" data-description-toggle aria-expanded="false">';
    html += '<div class="description-text">';
    sections.forEach(section => {
      html += '<div class="description-section">';
      if (section.label){
        html += `<span class="description-label">${section.label}:</span> `;
      }
      html += `<span class="description-value">${section.value}</span>`;
      html += '</div>';
    });
    html += '</div></div>';
    html += '<button type="button" class="description-more-btn btn btn-link btn-sm px-0" data-description-toggle-btn>';
    html += '<span class="label-more">Mostrar todo</span>';
    html += '<span class="label-less d-none">Contraer</span>';
    html += '</button></div>';
    return html;
  }

  function renderDetailCell(cell, rawValue){
    if (!cell) return;
    const catalogName = (cell.dataset.originalName || '').trim();
    const raw = rawValue !== undefined && rawValue !== null
      ? String(rawValue)
      : (cell.dataset.rawDetails || '');
    cell.dataset.rawDetails = raw;
    cell.innerHTML = buildDescriptionMarkup(raw, { catalogName });
    initDescriptionToggles();
  }

  function renderEditableCell(cell, displayValue){
    if (!cell) return;
    if (cell.dataset.field === 'details'){
      renderDetailCell(cell, displayValue);
      return;
    }
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

  function isRequirementSatisfied(field, value){
    if (field === 'name'){
      return String(value || '').trim().length > 0;
    }
    if (field === 'min_value'){
      const normalized = String(value || '').replace(/[^\d-]/g, '');
      const num = parseInt(normalized, 10);
      return !Number.isNaN(num) && num > 0;
    }
    if (field === 'workshop'){
      return String(value || '').trim().length > 0;
    }
    return true;
  }

  function handleRequirementChange(partId, field, value){
    if (!REQUIRED_FIELDS.includes(field)) return;
    const nodes = getPartElements(partId);
    if (!nodes.length) return;
    const fulfilled = isRequirementSatisfied(field, value);
    let snapshot = null;
    nodes.forEach(node => {
      const info = getMissingInfo(node);
      const idx = info.fields.indexOf(field);
      if (fulfilled && idx !== -1){
        info.fields.splice(idx, 1);
        info.labels.splice(idx, 1);
      } else if (!fulfilled && idx === -1){
        info.fields.push(field);
        info.labels.push(REQUIRED_FIELD_LABELS[field] || field);
      }
      setMissingInfo(node, info.fields, info.labels);
      if (!snapshot){
        snapshot = { fields: info.fields.slice(), labels: info.labels.slice() };
      }
    });
    const wasSold = nodes.some(node => node.dataset.status === 'vendido');
    const targetStatus = wasSold ? 'vendido' : (snapshot && snapshot.fields.length ? 'no_disponible' : 'disponible');
    refreshStatusVisualState(partId, targetStatus);
  }

  function initDescriptionToggles(){
    qsa('[data-description-shell]').forEach(shell => {
      const toggle = shell.querySelector('[data-description-toggle]');
      if (!toggle) return;
      evaluateDescriptionToggle(shell, toggle);
      const btn = shell.querySelector('[data-description-toggle-btn]');
      if (btn && !btn._descBtnBound){
        btn._descBtnBound = true;
        btn.addEventListener('click', function(ev){
          ev.preventDefault();
          ev.stopPropagation();
          toggleDescription(shell, toggle, btn);
        });
      }
    });
  }

  function forceExpandDescription(cell){
    if (!cell) return;
    const shell = cell.querySelector('[data-description-shell]');
    const toggle = shell?.querySelector('[data-description-toggle]');
    const btn = shell?.querySelector('[data-description-toggle-btn]');
    if (!toggle) return;
    toggle.classList.add('expanded');
    toggle.setAttribute('aria-expanded', 'true');
    if (btn){
      btn.classList.remove('d-none');
      updateDescriptionButton(btn, true);
    }
  }

  function toggleDescription(shell, toggle, btn){
    const expanded = !toggle.classList.contains('expanded');
    toggle.classList.toggle('expanded', expanded);
    toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    updateDescriptionButton(btn, expanded);
  }

  function updateDescriptionButton(btn, expanded){
    if (!btn) return;
    const more = btn.querySelector('.label-more');
    const less = btn.querySelector('.label-less');
    if (more) more.classList.toggle('d-none', expanded);
    if (less) less.classList.toggle('d-none', !expanded);
  }

  function evaluateDescriptionToggle(shell, toggle){
    if (!toggle) return;
    const text = toggle.querySelector('.description-text');
    const styles = window.getComputedStyle(toggle);
    let maxHeight = parseFloat(styles.maxHeight);
    if (!Number.isFinite(maxHeight) || styles.maxHeight === 'none'){
      maxHeight = 56;
    }
    const textHeight = text ? text.scrollHeight : 0;
    const needsToggle = textHeight > (maxHeight + 1);
    const btn = shell.querySelector('[data-description-toggle-btn]');
    if (!needsToggle){
      toggle.classList.add('no-toggle', 'expanded');
      toggle.setAttribute('aria-expanded', 'true');
      toggle.removeAttribute('tabindex');
      toggle.removeAttribute('role');
      if (btn) btn.classList.add('d-none');
    } else {
      toggle.classList.remove('no-toggle');
      if (!toggle.hasAttribute('tabindex')) toggle.setAttribute('tabindex', '0');
      if (!toggle.getAttribute('role')) toggle.setAttribute('role', 'button');
      toggle.setAttribute('aria-expanded', toggle.classList.contains('expanded') ? 'true' : 'false');
      if (btn){
        btn.classList.remove('d-none');
        updateDescriptionButton(btn, toggle.classList.contains('expanded'));
      }
    }
  }

  function getPartElements(partId){
    if (!partId) return [];
    const nodes = [];
    const desktop = document.querySelector(`#parts-table tr[data-part-id="${partId}"]`);
    if (desktop) nodes.push(desktop);
    const mobile = document.querySelector(`.part-row-mobile[data-part-id="${partId}"]`);
    if (mobile) nodes.push(mobile);
    return nodes;
  }

  function parseList(str){
    if (!str) return [];
    return String(str).split(MISSING_DELIMITER).map(s => s.trim()).filter(Boolean);
  }

  function getMissingInfo(node){
    if (!node) return { fields: [], labels: [] };
    return {
      fields: parseList(node.dataset.missingFields),
      labels: parseList(node.dataset.missingLabels)
    };
  }

  function setMissingInfo(node, fields, labels){
    if (!node) return;
    node.dataset.missingFields = (fields || []).join(MISSING_DELIMITER);
    node.dataset.missingLabels = (labels || []).join(MISSING_DELIMITER);
    node.dataset.incomplete = fields && fields.length ? 'true' : 'false';
  }

  function currentMissingLabel(node){
    const info = getMissingInfo(node);
    return info.labels[0] || '';
  }

  function formatMissingLabel(label){
    if (!label) return '';
    return label.toLowerCase();
  }

  function applyStatusMetaToButton(btn, status){
    if (!btn) return;
    const meta = STATUS_META[status] || STATUS_META.disponible;
    btn.dataset.status = status;
    btn.dataset.sold = String(status === 'vendido');
    btn.classList.remove('btn-success', 'btn-outline-success', 'btn-warning', 'text-dark', 'btn-secondary');
    meta.btnClass.split(' ').forEach(cls => {
      if (cls) btn.classList.add(cls);
    });
    let text = meta.label;
    if (status === 'no_disponible'){
      const owner = btn.closest('.part-row, .part-row-mobile');
      const missingLabel = formatMissingLabel(currentMissingLabel(owner));
      if (missingLabel){
        text = `Falta ${missingLabel}`;
      }
    }
    btn.innerHTML = `<i class="${meta.icon}"></i> ${text}`;
  }

  function refreshStatusVisualState(partId, status){
    getPartElements(partId).forEach(node => {
      node.dataset.status = status;
      if (status === 'vendido'){
        node.classList.add('sold-row');
      } else {
        node.classList.remove('sold-row');
      }
      applyStatusMetaToButton(node.querySelector('.toggle-sold-btn'), status);
    });
  }

  function resolveBaseStatus(node){
    if (!node) return 'disponible';
    return node.dataset.incomplete === 'true' ? 'no_disponible' : 'disponible';
  }

  function normalizeValue(field, value){
    if (value === undefined || value === null) return '';
    if (field && field.includes('value')){
      return String(value).replace(/[^\d-]/g, '');
    }
    return String(value);
  }

  function notifyPhotos(body, variant='info'){
    if (window.showToast){
      window.showToast({ title: 'Fotos', body, variant, delay: 3500 });
    } else {
      alert(body);
    }
  }

  function createSquareBlob(file){
    return new Promise((resolve, reject) => {
      if (!file || !file.type.startsWith('image/')){
        return reject(new Error('Archivo inválido'));
      }
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        try {
          const side = Math.min(img.width, img.height);
          const sx = (img.width - side) / 2;
          const sy = (img.height - side) / 2;
          const canvasSize = MAX_PHOTO_SIZE;
          photoUploadCanvas.width = canvasSize;
          photoUploadCanvas.height = canvasSize;
          const ctx = photoUploadCanvas.getContext('2d');
          ctx.clearRect(0, 0, canvasSize, canvasSize);
          ctx.drawImage(img, sx, sy, side, side, 0, 0, canvasSize, canvasSize);
          photoUploadCanvas.toBlob((blob) => {
            if (!blob){
              reject(new Error('No se pudo procesar la imagen'));
            } else {
              resolve(blob);
            }
          }, 'image/jpeg', 0.85);
        } catch (err) {
          reject(err);
        } finally {
          URL.revokeObjectURL(url);
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Imagen inválida'));
      };
      img.src = url;
    });
  }

  function uploadPhotoBlobs(partId, blobs){
    if (!blobs.length){
      notifyPhotos('No se pudo procesar ninguna foto', 'warning');
      return Promise.resolve();
    }
    const formData = new FormData();
    blobs.forEach((blob, index) => {
      formData.append('photos', blob, `extra_${Date.now()}_${index + 1}.jpg`);
    });
    formData.append('source', 'manual_gallery');
    return fetch(`/parts/${partId}/photos/upload/`, {
      method: 'POST',
      body: formData,
      headers: { 'X-CSRFToken': getCookie('csrftoken') }
    }).then(resp => resp.json().then(data => ({ resp, data })).catch(() => ({ resp, data: {} })))
      .then(({ resp, data }) => {
        if (!resp.ok || !data.success){
          throw new Error(data?.error || 'No se pudieron subir las fotos');
        }
        notifyPhotos('Fotos agregadas correctamente', 'success');
        refreshPhotoPanel(partId);
      }).catch(err => {
        console.error('Upload photos failed', err);
        notifyPhotos(err?.message || 'No se pudieron subir las fotos', 'danger');
      });
  }

  function openPhotoPicker(partId){
    if (!photoUploadInput){
      notifyPhotos('Captura de fotos no disponible en este navegador', 'warning');
      return;
    }
    activePhotoUploadPartId = partId;
    photoUploadInput.value = '';
    photoUploadInput.click();
  }

  function handlePhotoInputChange(event){
    const files = Array.from(event.target.files || []);
    photoUploadInput.value = '';
    const partId = activePhotoUploadPartId;
    activePhotoUploadPartId = null;
    if (!partId || !files.length) return;
    notifyPhotos('Procesando fotos...', 'info');
    Promise.all(files.map(file => createSquareBlob(file).catch(() => null)))
      .then(blobs => blobs.filter(Boolean))
      .then(blobs => uploadPhotoBlobs(partId, blobs));
  }

  function formatFieldForDisplay(field, value){
    const normalized = normalizeValue(field, value);
    if (!normalized) return '-';
    if (field && field.includes('value')){
      return formatCurrencyCL(normalized);
    }
    return normalized;
  }

  function normalizeSearchText(str){
    return String(str || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function tokenizeSearchText(str){
    return normalizeSearchText(str).split(' ').filter(Boolean);
  }

  function levenshteinDistance(a, b){
    if (a === b) return 0;
    const m = a.length;
    const n = b.length;
    if (!m) return n;
    if (!n) return m;
    const dp = new Array(n + 1);
    for (let j = 0; j <= n; j++){
      dp[j] = j;
    }
    for (let i = 1; i <= m; i++){
      let prev = dp[0];
      dp[0] = i;
      for (let j = 1; j <= n; j++){
        const tmp = dp[j];
        if (a[i - 1] === b[j - 1]){
          dp[j] = prev;
        } else {
          dp[j] = Math.min(prev + 1, dp[j] + 1, dp[j - 1] + 1);
        }
        prev = tmp;
      }
    }
    return dp[n];
  }

  function termMatches(normalizedText, tokens, term){
    if (!term) return true;
    if (!normalizedText && !tokens.length) return false;
    if (normalizedText.includes(term)) return true;
    const limit = term.length <= 4 ? 1 : term.length <= 7 ? 2 : 3;
    for (const token of tokens){
      if (!token) continue;
      if (Math.abs(token.length - term.length) > limit) continue;
      if (levenshteinDistance(term, token) <= limit){
        return true;
      }
    }
    return false;
  }

  function matchesAllTerms(text, metaText, terms){
    if (!terms.length) return true;
    const normalized = normalizeSearchText(text);
    const tokens = normalized.split(' ').filter(Boolean);
    const metaNormalized = normalizeSearchText(metaText);
    const metaTokens = metaNormalized.split(' ').filter(Boolean);
    return terms.every(term => termMatches(normalized, tokens, term) || termMatches(metaNormalized, metaTokens, term));
  }

  function syncPartFieldDisplay(partId, field, value){
    const display = formatFieldForDisplay(field, value);
    const tableRow = document.querySelector(`#parts-table tr[data-part-id="${partId}"]`);
    if (tableRow){
      const cell = tableRow.querySelector(`[data-field="${field}"]`);
      if (cell){
        if (field === 'name'){
          renderEditableCell(cell, display);
        } else if (field === 'details'){
          renderDetailCell(cell, value);
        } else {
          cell.textContent = display;
        }
      }
    }

    const mobileCards = document.querySelectorAll(`.part-row-mobile[data-part-id="${partId}"] .editable-mobile[data-field="${field}"]`);
    mobileCards.forEach(el => {
      if (field === 'details'){
        renderDetailCell(el, value);
      } else {
        el.textContent = display;
      }
    });
    handleRequirementChange(partId, field, value);
  }

  function updatePartField(partId, field, value){
    return fetch(`/parts/${partId}/update-field/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'X-CSRFToken': getCookie('csrftoken'),
      },
      body: JSON.stringify({ field, value }),
    }).then(r => r.json());
  }

  function pushHistory(entry){
    if (!entry) return;
    if (entry.previousValue === entry.newValue) return;
    undoStack.push(entry);
    if (undoStack.length > MAX_HISTORY) undoStack.shift();
    redoStack.length = 0;
  }

  function performUndo(){
    if (!undoStack.length) return;
    const entry = undoStack.pop();
    const { partId, field, previousValue, newValue } = entry;
    updatePartField(partId, field, previousValue).then(data => {
      if (data.success){
        syncPartFieldDisplay(partId, field, previousValue);
        redoStack.push({ partId, field, previousValue, newValue });
        window.showToast?.({ title: 'Deshacer', body: 'Cambio revertido', variant: 'info' });
      } else {
        undoStack.push(entry);
        window.showToast?.({ title: 'Error', body: 'No se pudo deshacer', variant: 'danger' });
      }
    }).catch(() => {
      undoStack.push(entry);
      window.showToast?.({ title: 'Error', body: 'No se pudo deshacer', variant: 'danger' });
    });
  }

  function performRedo(){
    if (!redoStack.length) return;
    const entry = redoStack.pop();
    const { partId, field, previousValue, newValue } = entry;
    updatePartField(partId, field, newValue).then(data => {
      if (data.success){
        syncPartFieldDisplay(partId, field, newValue);
        undoStack.push({ partId, field, previousValue, newValue });
        window.showToast?.({ title: 'Rehacer', body: 'Cambio reaplicado', variant: 'info' });
      } else {
        redoStack.push(entry);
        window.showToast?.({ title: 'Error', body: 'No se pudo rehacer', variant: 'danger' });
      }
    }).catch(() => {
      redoStack.push(entry);
      window.showToast?.({ title: 'Error', body: 'No se pudo rehacer', variant: 'danger' });
    });
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
      chip.setAttribute('aria-pressed', String(isActive));
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
  if (clearBtn && !clearBtn._filtersResetBound){
    clearBtn._filtersResetBound = true;
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
    if (icon._sortBound) return;
    icon._sortBound = true;
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
        if (column === 'status'){
          const status = (row.dataset.status || '').toLowerCase();
          if (status === 'vendido') return 2;
          if (status === 'disponible') return 1;
          return 0;
        }
        if (column === 'max_value' || column === 'min_value'){
          const cell = qs(`[data-field="${column}"]`, row);
          const txt = (cell?.textContent || '').trim();
          if (txt === '-' || !txt) return 0;
          const normalized = txt.replace(/[$.,\s\u00a0\u202f]/g, '');
          return parseInt(normalized, 10) || 0;
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
    if (input._columnFilterBound) return;
    input._columnFilterBound = true;
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
    if (chip._filterChipBound) return;
    chip._filterChipBound = true;
    if (!chip.hasAttribute('aria-pressed')) {
      chip.setAttribute('aria-pressed', String(chip.classList.contains('active')));
    }
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
    const useClientSearch = !!(globalSearchEl && globalSearchEl.dataset && globalSearchEl.dataset.clientSearch === 'true');
    const globalTerm = useClientSearch ? normalizeSearchText(globalSearchEl.value) : '';
    const searchTerms = globalTerm ? globalTerm.split(/\s+/).filter(Boolean) : [];
    const hasGlobalSearch = useClientSearch && searchTerms.length > 0;
    
    qsa('#parts-table tbody tr.part-row').forEach(row => {
      let show = true;
      const rawRowText = row.textContent || '';
      const rowText = normalizeSearchText(rawRowText);
      const autoMetaRaw = row.dataset.autoSearch || '';
      const autoMeta = normalizeSearchText(autoMetaRaw);
      const partId = row.dataset.partId;
      const detailRow = partId ? document.querySelector(`.part-photo-detail-row[data-part-id="${partId}"]`) : null;
      
      if (hasGlobalSearch) {
        if (!matchesAllTerms(rawRowText, autoMetaRaw, searchTerms)){
          show = false;
        }
      }
      
      if (show) {
        Object.keys(filters).forEach(column => {
          const fv = normalizeSearchText(filters[column] || '');
          if (!fv) return;
          let cv = '';
          if (column === 'status'){
            cv = normalizeSearchText(row.dataset.status || '');
            show = show && cv === fv;
          } else if (column === 'workshop'){
            const td = row.querySelector('[data-col="workshop"]');
            cv = normalizeSearchText(td?.textContent || '');
            show = show && (cv === fv);
          } else if (column === 'date_added'){
            const td = row.querySelector('[data-col="date"]');
            cv = normalizeSearchText(td?.textContent || '');
            show = show && cv.includes(fv);
          } else if (column === 'name' || column === 'min_value' || column === 'max_value' || column === 'details'){
            const cell = qs(`[data-field="${column}"]`, row);
            const rawText = column === 'name'
              ? (cell?.querySelector('.part-name-text')?.textContent || cell?.textContent || '')
              : (cell?.textContent || '');
            cv = normalizeSearchText(rawText);
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
      if (!show && detailRow){
        detailRow.setAttribute('hidden', 'hidden');
      }

      if (show){
        delete row.dataset.filterHidden;
        if (detailRow) delete detailRow.dataset.filterHidden;
      } else {
        row.dataset.filterHidden = '1';
        if (detailRow) detailRow.dataset.filterHidden = '1';
      }
    });

    // También aplicar filtros a las cards móviles
    const filtersCopy = Object.assign({}, filters);
    const hasAnyFilter = Object.keys(filtersCopy).some(k => (filtersCopy[k] || '').toString().trim().length > 0);
    qsa('.part-row-mobile').forEach(card => {
      let show = true;
      const textRaw = card.textContent || '';
      const text = normalizeSearchText(textRaw);
      const autoMetaRaw = card.dataset.autoSearch || '';
      const autoMeta = normalizeSearchText(autoMetaRaw);
      const mobilePanel = card.querySelector('.part-photo-card-mobile');
      
      if (hasGlobalSearch) {
        if (!matchesAllTerms(textRaw, autoMetaRaw, searchTerms)){
          show = false;
        }
      }
      
      // Es para aplicar filtros de columnas
      if (show && hasAnyFilter) {
        Object.keys(filtersCopy).forEach(column => {
          const fv = normalizeSearchText(filtersCopy[column] || '');
          if (!fv) return;
          if (column === 'status'){
            const status = normalizeSearchText(card.dataset.status || '');
            if (status !== fv) {
              show = false;
            }
          } else if (!text.includes(fv)) {
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
      if (!show && mobilePanel){
        mobilePanel.setAttribute('hidden', 'hidden');
      }

      if (show){
        delete card.dataset.filterHidden;
      } else {
        card.dataset.filterHidden = '1';
      }
    });

    enforceVisibleLimit();
  }

  function getPhotoPanel(partId, mode){
    if (mode === 'mobile'){
      return document.querySelector(`.part-photo-card-mobile[data-part-id="${partId}"]`);
    }
    return document.querySelector(`.part-photo-detail-row[data-part-id="${partId}"]`);
  }

  function fetchPartPhotos(partId){
    if (photoCache[partId]){
      return Promise.resolve(photoCache[partId]);
    }
    return fetch(`/parts/${partId}/photos/`, {
      headers: { 'X-Requested-With': 'XMLHttpRequest' }
    }).then(resp => resp.json()).then(data => {
      if (!data.success){
        throw new Error(data.error || 'error');
      }
      photoCache[partId] = data.photos || [];
      return photoCache[partId];
    });
  }

  function renderPhotoGallery(container, photos){
    if (!container) return;
    if (!photos.length){
      container.innerHTML = '<div class="text-muted small py-3">Sin fotos registradas.</div>';
      return;
    }
    const frag = document.createDocumentFragment();
    photos.forEach(photo => {
      if (!photo?.url) return;
      const anchor = document.createElement('a');
      anchor.href = photo.url;
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
      anchor.className = 'photo-thumb';
      anchor.style.backgroundImage = `url(${photo.url})`;
      anchor.title = 'Abrir foto';
      frag.appendChild(anchor);
    });
    container.innerHTML = '';
    container.appendChild(frag);
  }

  function showPhotoPanel(partId, mode){
    const panel = getPhotoPanel(partId, mode);
    if (!panel) return;
    panel.removeAttribute('hidden');
    const gallery = panel.querySelector('[data-photo-gallery]');
    if (!gallery) return;
    gallery.innerHTML = '<div class="text-muted small py-3">Cargando fotos...</div>';
    fetchPartPhotos(partId).then(photos => {
      renderPhotoGallery(gallery, photos);
    }).catch(() => {
      gallery.innerHTML = '<div class="text-danger small py-3">No se pudieron cargar las fotos.</div>';
    });
  }

  function hidePhotoPanel(partId, mode){
    const panel = getPhotoPanel(partId, mode);
    if (!panel) return;
    panel.setAttribute('hidden', 'hidden');
  }

  function togglePhotoPanel(partId, mode){
    const panel = getPhotoPanel(partId, mode);
    if (!panel) return;
    const isOpen = !panel.hasAttribute('hidden');
    if (isOpen){
      hidePhotoPanel(partId, mode);
    } else {
      showPhotoPanel(partId, mode);
    }
  }

  function initPhotoGalleryControls(){
    qsa('.view-photos-btn').forEach(btn => {
      if (btn._photoBound) return;
      btn._photoBound = true;
      btn.addEventListener('click', () => {
        const partId = btn.dataset.partId;
        const mode = btn.dataset.viewMode || (btn.closest('.part-row-mobile') ? 'mobile' : 'desktop');
        togglePhotoPanel(partId, mode);
      });
    });
    qsa('.collapse-photo-btn').forEach(btn => {
      if (btn._photoCollapseBound) return;
      btn._photoCollapseBound = true;
      btn.addEventListener('click', () => {
        const partId = btn.dataset.partId;
        const mode = btn.closest('.part-photo-card-mobile') ? 'mobile' : 'desktop';
        hidePhotoPanel(partId, mode);
      });
    });
    qsa('.add-photos-btn').forEach(btn => {
      if (btn._photoAddBound) return;
      btn._photoAddBound = true;
      btn.addEventListener('click', () => {
        const partId = btn.dataset.partId;
        if (!partId){
          notifyPhotos('No se pudo identificar la pieza', 'warning');
          return;
        }
        openPhotoPicker(partId);
      });
    });
  }

  function refreshPhotoPanel(partId){
    delete photoCache[partId];
    const targets = [];
    const desktopRow = document.querySelector(`.part-photo-detail-row[data-part-id="${partId}"]`);
    if (desktopRow && !desktopRow.hasAttribute('hidden')){
      const gallery = desktopRow.querySelector('[data-photo-gallery]');
      if (gallery) targets.push(gallery);
    }
    const mobileCard = document.querySelector(`.part-photo-card-mobile[data-part-id="${partId}"]`);
    if (mobileCard && !mobileCard.hasAttribute('hidden')){
      const gallery = mobileCard.querySelector('[data-photo-gallery]');
      if (gallery) targets.push(gallery);
    }
    if (!targets.length) return;
    targets.forEach(gallery => {
      gallery.innerHTML = '<div class="text-muted small py-3">Actualizando...</div>';
    });
    fetchPartPhotos(partId).then(photos => {
      targets.forEach(gallery => renderPhotoGallery(gallery, photos));
    }).catch(() => {
      targets.forEach(gallery => {
        gallery.innerHTML = '<div class="text-danger small py-3">No se pudieron cargar las fotos.</div>';
      });
    });
  }

  window.__partsEnforceVisibleLimit = enforceVisibleLimit;
  document.addEventListener('parts:display-limit-changed', enforceVisibleLimit);

  applyFilters(savedFilters);
  initDescriptionToggles();
  initPhotoGalleryControls();
  if (photoUploadInput){
    photoUploadInput.addEventListener('change', handlePhotoInputChange);
  }

  if (!document._partsUndoListener){
    document._partsUndoListener = true;
    document.addEventListener('keydown', function(e){
      const key = e.key?.toLowerCase();
      const tag = (e.target?.tagName || '').toLowerCase();
      const isInput = ['input', 'textarea'].includes(tag);
      if (isInput) return;
      const hasCtrl = e.ctrlKey || e.metaKey;
      if (!hasCtrl) return;
      const wantsUndo = hasCtrl && !e.altKey && !e.shiftKey && key === 'z';
      const wantsRedo = hasCtrl && !e.altKey && ((e.shiftKey && key === 'z') || key === 'y');
      if (wantsUndo){
        e.preventDefault();
        performUndo();
      } else if (wantsRedo){
        e.preventDefault();
        performRedo();
      }
    });
  }

  document.addEventListener('parts:photos-updated', (event) => {
    const partId = event?.detail?.partId;
    if (!partId) return;
    refreshPhotoPanel(String(partId));
  });

  // ====== TOGGLE VENDIDO/DISPONIBLE ======
  qsa('.toggle-sold-btn').forEach(btn => {
    if (btn._toggleBound) return;
    btn._toggleBound = true;
    btn.addEventListener('click', function(){
      const partId = btn.dataset.partId;
      const csrfToken = getCsrfToken();
      if (!csrfToken){
        window.showToast?.({ title: 'Seguridad', body: 'No se encontró token CSRF. Recarga la página e inténtalo de nuevo.', variant: 'warning' });
        return;
      }
      fetch(`/parts/${partId}/toggle-sold/`, {
        method: 'POST',
        headers: { 'X-Requested-With': 'XMLHttpRequest', 'X-CSRFToken': csrfToken }
      }).then(r => r.json()).then(data => {
        if (data.success){
          const nodes = getPartElements(partId);
          const referenceNode = nodes[0] || btn.closest('tr') || btn.closest('.part-row-mobile');
          const targetStatus = data.sold ? 'vendido' : resolveBaseStatus(referenceNode);
          refreshStatusVisualState(partId, targetStatus);
          applyFilters(loadColumnFilters());
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
      } else if (field === 'details'){
        forceExpandDescription(cell);
        currentValue = cell.dataset.rawDetails || '';
      } else {
        currentValue = (cell.textContent || '').trim();
      }
      if (field.includes('value')) currentValue = currentValue.replace('$','').replace(/[.,]/g,'');
      if (currentValue === '-') currentValue = '';
      const partId = (cell.closest('tr') || cell.closest('.part-row-mobile'))?.dataset.partId;
      if (!partId) return;

      const isValueField = field.includes('value');
      const isDetailField = field === 'details';
      const input = isDetailField ? document.createElement('textarea') : document.createElement('input');
      if (!isDetailField){
        input.type = isValueField ? 'number' : 'text';
      }
      input.className = isDetailField ? 'form-control' : 'form-control form-control-sm';
      if (isDetailField){
        const lineCount = (currentValue.match(/\n/g) || []).length + 1;
        input.rows = Math.min(12, Math.max(4, lineCount));
        input.style.resize = 'vertical';
      }
      input.value = currentValue;
      cell.classList.add('editing');
      cell.innerHTML = '';
      cell.appendChild(input);
      input.focus();

      function cleanup(val){
        if (isValueField && val){
          return formatCurrencyCL(val);
        }
        if (isDetailField){
          return val || '';
        }
        return val || '-';
      }

      function save(){
        if (!editingCell) return;
        const newValue = input.value;
        if (newValue === currentValue){
          cell.classList.remove('editing');
          renderEditableCell(cell, cleanup(currentValue));
          editingCell = null;
          return;
        }
        updatePartField(partId, field, newValue).then(data => {
          if (data.success){
            pushHistory({ partId, field, previousValue: currentValue, newValue });
            cell.classList.remove('editing');
            renderEditableCell(cell, cleanup(newValue));
            syncPartFieldDisplay(partId, field, newValue);
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

  if (confirmDeleteBtn && !confirmDeleteBtn._bound){
    confirmDeleteBtn._bound = true;
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
              tr.innerHTML = '<td colspan="9" class="text-center text-muted"><i class="fas fa-inbox"></i> No hay piezas registradas</td>';
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
    if (btn._deleteBound) return;
    btn._deleteBound = true;
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
                tr.innerHTML = '<td colspan="9" class="text-center text-muted"><i class="fas fa-inbox"></i> No hay piezas registradas</td>';
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
  if (globalSearch && globalSearch.dataset && globalSearch.dataset.clientSearch === 'true'){
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
