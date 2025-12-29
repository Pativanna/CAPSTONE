/**
 * Dashboard resumen interactivo sin inline scripts.
 * Lee configuraciones desde data attributes para trabajar bajo CSP estricta.
 */
(function () {
  'use strict';

  const CONTROLLER_KEY = '__dashboardSummaryController';

  function onReady(cb) {
    const run = () => cb();
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', run, { once: true });
    } else {
      run();
    }
    document.addEventListener('turbo:load', run);
    document.addEventListener('turbo:render', run);
    document.addEventListener('turbo:frame-load', run);
    document.addEventListener('page:ready', run);
  }

  function destroyController() {
    const controller = window[CONTROLLER_KEY];
    if (controller && typeof controller.destroy === 'function') {
      controller.destroy();
    }
    window[CONTROLLER_KEY] = null;
  }

  function getConfig() {
    const root = document.querySelector('[data-dashboard-config]');
    if (!root) {
      return null;
    }
    return {
      statsUrl: root.dataset.statsUrl || '',
      chartSelector: root.dataset.chartSelector || '#summaryChart',
      selectorRow: root.dataset.selectorRow || '#summarySelectorRow',
      descriptionSelector: root.dataset.descriptionSelector || '#chartDescription',
      specialToolbarSelector: root.dataset.specialToolbar || '#specialKindToolbar'
    };
  }

  function initDashboard() {
    const cfg = getConfig();
    if (!cfg || !cfg.statsUrl) {
      destroyController();
      return;
    }
    const root = document.querySelector('[data-dashboard-config]');
    if (!root || root.__dashboardInitialized) {
      return;
    }
    destroyController();
    root.__dashboardInitialized = true;
    const BAR_STYLE = { borderRadius: 12, borderSkipped: false, borderWidth: 0 };
    const commonOpts = {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'bottom',
          labels: { usePointStyle: true, pointStyle: 'circle', padding: 16 }
        },
        tooltip: {
          mode: 'index',
          intersect: false,
          backgroundColor: 'rgba(17, 24, 39, 0.92)',
          padding: 12,
          boxPadding: 4,
          titleFont: { size: 13, weight: '600' },
          bodySpacing: 6
        }
      },
      elements: {
        line: { tension: 0.35, borderWidth: 3, fill: false },
        point: { radius: 4, hoverRadius: 6 }
      },
      interaction: { mode: 'nearest', axis: 'x', intersect: false },
      scales: {
        y: {
          beginAtZero: true,
          ticks: { precision: 0 },
          grid: { color: 'rgba(15, 60, 127, 0.12)' }
        },
        x: { grid: { display: false } }
      }
    };

    let statsCache = null;
    let dailyType = 'sold';
    let weeklyType = 'sold';
    let monthlyType = 'sold';
    let yearlyType = 'sold';
    let currentMode = 'monthly';
    let currentSpecial = 'available_by_workshop';
    const canvasEl = document.querySelector(cfg.chartSelector);
    const selectorRow = document.querySelector(cfg.selectorRow);
    const descriptionEl = document.querySelector(cfg.descriptionSelector);
    const specialToolbar = document.querySelector(cfg.specialToolbarSelector);
    const modeButtons = Array.from(document.querySelectorAll('[data-summary-mode]'));
    const specialButtons = specialToolbar ? Array.from(specialToolbar.querySelectorAll('[data-special-kind]')) : [];

    function barDataset(label, data, color) {
      return {
        label,
        data: data || [],
        backgroundColor: color,
        borderColor: color,
        ...BAR_STYLE
      };
    }

    function createChipGroup(activeValue, options, onChange) {
      const group = document.createElement('div');
      group.className = 'dashboard-chip-group';
      options.forEach((opt) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'dashboard-chip' + (opt.value === activeValue ? ' dashboard-chip--active' : '');
        btn.textContent = opt.label;
        btn.setAttribute('aria-pressed', opt.value === activeValue ? 'true' : 'false');
        btn.addEventListener('click', () => {
          if (opt.value !== activeValue) {
            onChange(opt.value);
          }
        });
        group.appendChild(btn);
      });
      return group;
    }

    function updateModeButtons() {
      modeButtons.forEach((btn) => {
        const isActive = btn.dataset.summaryMode === currentMode;
        btn.classList.toggle('dashboard-pill--active', isActive);
        btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      });
    }

    function updateSpecialButtons() {
      specialButtons.forEach((btn) => {
        const isActive = btn.dataset.specialKind === currentSpecial;
        btn.classList.toggle('dashboard-pill--active', isActive);
        btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      });
    }

    function toggleSpecialToolbar() {
      if (!specialToolbar) return;
      const show = currentMode === 'special';
      specialToolbar.hidden = !show;
      specialToolbar.classList.toggle('is-visible', show);
    }

    function renderSummary(mode) {
      if (!statsCache || !canvasEl || !descriptionEl) {
        return;
      }
      const targetMode = mode || currentMode || 'monthly';
      currentMode = targetMode;
      if (selectorRow) {
        selectorRow.innerHTML = '';
        selectorRow.classList.remove('is-active');
      }

      let labels = [];
      let datasets = [];
      let chartDesc = '';

      const activateSelector = (element) => {
        if (selectorRow && element) {
          selectorRow.classList.add('is-active');
          selectorRow.appendChild(element);
        }
      };

      const dataByMode = statsCache[targetMode] || {};

      function renderSimpleMode(typeState, options, dataKey, descriptions) {
        const chips = createChipGroup(typeState.value, options, (next) => {
          typeState.value = next;
          renderSummary(targetMode);
        });
        activateSelector(chips);
        labels = dataByMode.axis || [];
        const dataSeries = dataByMode[typeState.value] || [];
        datasets.push(barDataset(options.find((opt) => opt.value === typeState.value).label, dataSeries, options.find((opt) => opt.value === typeState.value).color));
        chartDesc = descriptions[typeState.value] || '';
      }

      if (targetMode === 'daily') {
        renderSimpleMode(
          { value: dailyType },
          [
            { value: 'sold', label: 'Vendidas', color: '#ef5350' },
            { value: 'added', label: 'Agregadas', color: '#0069BC' }
          ],
          dataByMode,
          {
            sold: 'Evolución diaria de piezas vendidas en los últimos días.',
            added: 'Evolución diaria de piezas agregadas al inventario.'
          }
        );
        dailyType = dailyType;
      } else if (targetMode === 'weekly') {
        const options = [
          { value: 'sold', label: 'Vendidas', color: '#ef5350' },
          { value: 'voice_sessions', label: 'Sesiones Voz', color: '#7e57c2' }
        ];
        const chips = createChipGroup(weeklyType, options, (next) => {
          weeklyType = next;
          renderSummary('weekly');
        });
        activateSelector(chips);
        labels = dataByMode.axis || [];
        datasets.push(barDataset(options.find((opt) => opt.value === weeklyType).label, dataByMode[weeklyType] || [], options.find((opt) => opt.value === weeklyType).color));
        chartDesc = weeklyType === 'sold'
          ? 'Cantidad de piezas vendidas agrupadas por semana.'
          : 'Cantidad de sesiones de voz agrupadas por semana.';
      } else if (targetMode === 'monthly') {
        const options = [
          { value: 'sold', label: 'Vendidas', color: '#ef5350' },
          { value: 'added', label: 'Agregadas', color: '#0069BC' }
        ];
        const chips = createChipGroup(monthlyType, options, (next) => {
          monthlyType = next;
          renderSummary('monthly');
        });
        activateSelector(chips);
        labels = dataByMode.axis || [];
        datasets.push(barDataset(options.find((opt) => opt.value === monthlyType).label, dataByMode[monthlyType] || [], options.find((opt) => opt.value === monthlyType).color));
        chartDesc = monthlyType === 'sold'
          ? 'Cantidad de piezas vendidas agrupadas por mes.'
          : 'Cantidad de piezas agregadas al inventario agrupadas por mes.';
      } else if (targetMode === 'yearly') {
        const options = [
          { value: 'sold', label: 'Vendidas', color: '#ef5350' },
          { value: 'added', label: 'Agregadas', color: '#0069BC' }
        ];
        const chips = createChipGroup(yearlyType, options, (next) => {
          yearlyType = next;
          renderSummary('yearly');
        });
        activateSelector(chips);
        labels = dataByMode.axis || [];
        const yearlyOpt = options.find((opt) => opt.value === yearlyType) || options[0];
        datasets.push(barDataset(yearlyOpt.label, dataByMode[yearlyOpt.value] || [], yearlyOpt.color));
        chartDesc = yearlyType === 'sold'
          ? 'Comportamiento anual de piezas vendidas.'
          : 'Comportamiento anual de piezas agregadas.';
      } else {
        const kind = currentSpecial || 'available_by_workshop';
        const dataSpecial = (statsCache.special && statsCache.special[kind]) || { labels: [], values: [] };
        labels = dataSpecial.labels || [];
        datasets.push(barDataset('Total', dataSpecial.values || [], '#26a69a'));
        chartDesc = ({
          available_by_workshop: 'Cantidad de piezas disponibles agrupadas por taller.',
          parts_by_model: 'Cantidad de piezas disponibles agrupadas por modelo de auto.',
          model_value_sum: 'Suma de valores referenciales por modelo.',
          recent_sales_by_workshop: 'Ventas confirmadas por taller en los últimos 30 días.',
          sales_all_time: 'Histórico de ventas por año (todas las piezas).'
        })[kind] || 'Resumen especial';
      }

    descriptionEl.textContent = chartDesc || '';
    if (canvasEl) {
      canvasEl.setAttribute('aria-label', chartDesc || 'Resumen del inventario sin descripción disponible.');
    }
    updateModeButtons();
    toggleSpecialToolbar();
    updateSpecialButtons();
    const existingChart = canvasEl && canvasEl.__summaryChart;
    if (existingChart && typeof existingChart.destroy === 'function') {
      existingChart.destroy();
    }
    const newChart = new window.Chart(canvasEl, {
      type: 'bar',
      data: { labels, datasets },
      options: commonOpts
    });
    canvasEl.__summaryChart = newChart;
    }

    function hydrateDashboard(data) {
      statsCache = data && data.data ? data.data : data;
      if (!statsCache) {
        return;
      }
      renderSummary(currentMode);
    }

    function fetchStats() {
      const url = cfg.statsUrl;
      fetch(url, { headers: { 'X-Requested-With': 'XMLHttpRequest' } })
        .then((resp) => resp.json())
        .then((data) => hydrateDashboard(data))
        .catch((err) => {
          console.error('dashboard_stats_error', err);
          if (descriptionEl) {
            const fallbackMessage = 'No se pudo cargar el resumen. Intenta nuevamente más tarde.';
            descriptionEl.textContent = fallbackMessage;
            if (canvasEl) {
              canvasEl.setAttribute('aria-label', fallbackMessage);
            }
          }
        });
    }

    const handleModeClick = (event) => {
      const btn = event.currentTarget;
      const val = btn && btn.dataset ? btn.dataset.summaryMode : null;
      if (val && currentMode !== val) {
        currentMode = val;
        renderSummary(val);
      }
    };

    const handleSpecialClick = (event) => {
      const btn = event.currentTarget;
      const val = btn && btn.dataset ? btn.dataset.specialKind : null;
      if (val && currentSpecial !== val) {
        currentSpecial = val;
        renderSummary('special');
      }
    };

    modeButtons.forEach((btn) => btn.addEventListener('click', handleModeClick));
    specialButtons.forEach((btn) => btn.addEventListener('click', handleSpecialClick));

    fetchStats();

    const destroy = () => {
      if (canvasEl && canvasEl.__summaryChart && typeof canvasEl.__summaryChart.destroy === 'function') {
        canvasEl.__summaryChart.destroy();
        delete canvasEl.__summaryChart;
      }
      modeButtons.forEach((btn) => btn.removeEventListener('click', handleModeClick));
      specialButtons.forEach((btn) => btn.removeEventListener('click', handleSpecialClick));
      if (root) {
        root.__dashboardInitialized = false;
      }
    };

    window[CONTROLLER_KEY] = { destroy };
  }

  function waitForChart(callback, attempt = 0) {
    if (typeof window.Chart !== 'undefined') {
      callback();
      return;
    }
    if (attempt > 40) {
      const cfg = getConfig();
      if (cfg) {
        const description = document.querySelector(cfg.descriptionSelector);
        if (description) {
          description.textContent = 'No se pudo inicializar los gráficos. Verifica la carga de Chart.js.';
        }
      }
      console.warn('Chart.js no estuvo disponible tras varios intentos.');
      return;
    }
    window.setTimeout(() => waitForChart(callback, attempt + 1), 150);
  }

  onReady(() => waitForChart(initDashboard));
  document.addEventListener('turbo:before-cache', destroyController);
})();
