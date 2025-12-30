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
    const BAR_STYLE = { borderRadius: 8, borderSkipped: false, borderWidth: 0 };
    const LINE_STYLE = { tension: 0.4, borderWidth: 3, fill: true, pointRadius: 4, pointHoverRadius: 6 };
    
    // Paleta de colores moderna
    const COLORS = {
      primary: '#667eea',
      success: '#11998e',
      danger: '#ef5350',
      warning: '#f59e0b',
      info: '#4facfe',
      violet: '#8b5cf6',
      pink: '#ec4899',
      cyan: '#06b6d4'
    };
    
    const commonOpts = {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'bottom',
          labels: { 
            usePointStyle: true, 
            pointStyle: 'circle', 
            padding: 12,
            font: { size: 11, weight: '500' }
          }
        },
        tooltip: {
          mode: 'index',
          intersect: false,
          backgroundColor: 'rgba(17, 24, 39, 0.95)',
          padding: 10,
          boxPadding: 4,
          titleFont: { size: 12, weight: '600' },
          bodyFont: { size: 11 },
          bodySpacing: 4,
          cornerRadius: 8
        }
      },
      elements: {
        line: LINE_STYLE,
        point: { radius: 3, hoverRadius: 5 }
      },
      interaction: { mode: 'nearest', axis: 'x', intersect: false },
      scales: {
        y: {
          beginAtZero: true,
          ticks: { precision: 0, font: { size: 10 } },
          grid: { color: 'rgba(15, 60, 127, 0.08)' }
        },
        x: { 
          grid: { display: false },
          ticks: { font: { size: 10 } }
        }
      }
    };

    let statsCache = null;
    let dailyType = 'both';
    let weeklyType = 'comparison';
    let monthlyType = 'comparison';
    let yearlyType = 'trend';
    let currentMode = 'monthly';
    let currentSpecial = 'available_by_workshop';
    const canvasEl = document.querySelector(cfg.chartSelector);
    const selectorRow = document.querySelector(cfg.selectorRow);
    const descriptionEl = document.querySelector(cfg.descriptionSelector);
    const specialToolbar = document.querySelector(cfg.specialToolbarSelector);
    const modeButtons = Array.from(document.querySelectorAll('[data-summary-mode]'));
    const specialButtons = specialToolbar ? Array.from(specialToolbar.querySelectorAll('[data-special-kind]')) : [];

    function barDataset(label, data, color, order = 0) {
      return {
        label,
        data: data || [],
        backgroundColor: color,
        borderColor: color,
        order,
        ...BAR_STYLE
      };
    }
    
    function lineDataset(label, data, color, order = 0) {
      return {
        type: 'line',
        label,
        data: data || [],
        borderColor: color,
        backgroundColor: color + '20',
        fill: true,
        order,
        ...LINE_STYLE
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
      let chartType = 'bar';

      const activateSelector = (element) => {
        if (selectorRow && element) {
          selectorRow.classList.add('is-active');
          selectorRow.appendChild(element);
        }
      };

      const dataByMode = statsCache[targetMode] || {};

      if (targetMode === 'daily') {
        // DIARIO: Comparativa vendidas vs agregadas (últimos 14 días)
        const options = [
          { value: 'both', label: 'Comparativa' },
          { value: 'sold', label: 'Solo Vendidas' },
          { value: 'added', label: 'Solo Agregadas' }
        ];
        const chips = createChipGroup(dailyType, options, (next) => {
          dailyType = next;
          renderSummary('daily');
        });
        activateSelector(chips);
        labels = dataByMode.axis || [];
        
        if (dailyType === 'both') {
          datasets.push(barDataset('Vendidas', dataByMode.sold || [], COLORS.danger, 1));
          datasets.push(lineDataset('Agregadas', dataByMode.added || [], COLORS.primary, 0));
          chartDesc = 'Comparativa diaria: barras rojas = ventas, línea azul = ingresos al inventario.';
        } else if (dailyType === 'sold') {
          datasets.push(barDataset('Vendidas', dataByMode.sold || [], COLORS.danger));
          chartDesc = 'Piezas vendidas por día en las últimas 2 semanas.';
        } else {
          datasets.push(barDataset('Agregadas', dataByMode.added || [], COLORS.primary));
          chartDesc = 'Piezas agregadas al inventario por día.';
        }
        
      } else if (targetMode === 'weekly') {
        // SEMANAL: Rendimiento semanal con tendencia
        const options = [
          { value: 'comparison', label: 'Comparativa' },
          { value: 'sold', label: 'Ventas' },
          { value: 'voice_sessions', label: 'Sesiones Voz' }
        ];
        const chips = createChipGroup(weeklyType, options, (next) => {
          weeklyType = next;
          renderSummary('weekly');
        });
        activateSelector(chips);
        labels = dataByMode.axis || [];
        
        if (weeklyType === 'comparison') {
          datasets.push(barDataset('Ventas', dataByMode.sold || [], COLORS.success, 1));
          datasets.push(lineDataset('Sesiones Voz', dataByMode.voice_sessions || [], COLORS.violet, 0));
          chartDesc = 'Rendimiento semanal: ventas (barras) vs actividad de voz (línea).';
        } else if (weeklyType === 'sold') {
          datasets.push(barDataset('Ventas Semanales', dataByMode.sold || [], COLORS.success));
          chartDesc = 'Total de piezas vendidas por semana.';
        } else {
          datasets.push(barDataset('Sesiones de Voz', dataByMode.voice_sessions || [], COLORS.violet));
          chartDesc = 'Sesiones de reconocimiento de voz por semana.';
        }
        
      } else if (targetMode === 'monthly') {
        // MENSUAL: Análisis mensual completo
        const options = [
          { value: 'comparison', label: 'Comparativa' },
          { value: 'sold', label: 'Ventas' },
          { value: 'added', label: 'Ingresos' },
          { value: 'balance', label: 'Balance' }
        ];
        const chips = createChipGroup(monthlyType, options, (next) => {
          monthlyType = next;
          renderSummary('monthly');
        });
        activateSelector(chips);
        labels = dataByMode.axis || [];
        
        if (monthlyType === 'comparison') {
          datasets.push(barDataset('Vendidas', dataByMode.sold || [], COLORS.danger, 1));
          datasets.push(barDataset('Agregadas', dataByMode.added || [], COLORS.primary, 2));
          chartDesc = 'Comparativa mensual de flujo: vendidas (rojo) vs agregadas (azul).';
        } else if (monthlyType === 'sold') {
          datasets.push(barDataset('Ventas Mensuales', dataByMode.sold || [], COLORS.danger));
          chartDesc = 'Volumen de ventas mensuales del período.';
        } else if (monthlyType === 'added') {
          datasets.push(barDataset('Ingresos Mensuales', dataByMode.added || [], COLORS.primary));
          chartDesc = 'Piezas ingresadas al inventario por mes.';
        } else {
          // Balance: diferencia entre agregadas y vendidas
          const sold = dataByMode.sold || [];
          const added = dataByMode.added || [];
          const balance = added.map((v, i) => (v || 0) - (sold[i] || 0));
          datasets.push({
            label: 'Balance Neto',
            data: balance,
            backgroundColor: balance.map(v => v >= 0 ? COLORS.success : COLORS.danger),
            borderColor: balance.map(v => v >= 0 ? COLORS.success : COLORS.danger),
            ...BAR_STYLE
          });
          chartDesc = 'Balance mensual: positivo (verde) = crecimiento, negativo (rojo) = reducción de stock.';
        }
        
      } else if (targetMode === 'yearly') {
        // ANUAL: Tendencia histórica
        const options = [
          { value: 'trend', label: 'Tendencia' },
          { value: 'sold', label: 'Ventas' },
          { value: 'added', label: 'Ingresos' }
        ];
        const chips = createChipGroup(yearlyType, options, (next) => {
          yearlyType = next;
          renderSummary('yearly');
        });
        activateSelector(chips);
        labels = dataByMode.axis || [];
        
        if (yearlyType === 'trend') {
          datasets.push(lineDataset('Ventas', dataByMode.sold || [], COLORS.danger, 0));
          datasets.push(lineDataset('Ingresos', dataByMode.added || [], COLORS.primary, 1));
          chartType = 'line';
          chartDesc = 'Tendencia histórica anual: evolución de ventas e ingresos.';
        } else if (yearlyType === 'sold') {
          datasets.push(barDataset('Ventas Anuales', dataByMode.sold || [], COLORS.danger));
          chartDesc = 'Total de ventas por año.';
        } else {
          datasets.push(barDataset('Ingresos Anuales', dataByMode.added || [], COLORS.primary));
          chartDesc = 'Total de piezas ingresadas por año.';
        }
        
      } else {
        // ESPECIAL: Diferentes análisis
        const kind = currentSpecial || 'available_by_workshop';
        const dataSpecial = (statsCache.special && statsCache.special[kind]) || { labels: [], values: [] };
        labels = dataSpecial.labels || [];
        
        const specialColors = {
          available_by_workshop: COLORS.success,
          parts_by_model: COLORS.primary,
          model_value_sum: COLORS.warning,
          recent_sales_by_workshop: COLORS.danger,
          sales_all_time: COLORS.violet
        };
        
        datasets.push(barDataset('Total', dataSpecial.values || [], specialColors[kind] || COLORS.info));
        chartDesc = ({
          available_by_workshop: 'Distribución de piezas disponibles por taller.',
          parts_by_model: 'Cantidad de piezas disponibles por modelo de auto.',
          model_value_sum: 'Valor total estimado por modelo de auto.',
          recent_sales_by_workshop: 'Ventas de los últimos 30 días por taller.',
          sales_all_time: 'Histórico completo de ventas por año.'
        })[kind] || 'Análisis especial del inventario.';
      }

    descriptionEl.textContent = chartDesc || '';
    if (canvasEl) {
      canvasEl.setAttribute('aria-label', chartDesc || 'Resumen del inventario.');
    }
    updateModeButtons();
    toggleSpecialToolbar();
    updateSpecialButtons();
    
    const existingChart = canvasEl && canvasEl.__summaryChart;
    if (existingChart && typeof existingChart.destroy === 'function') {
      existingChart.destroy();
    }
    
    const newChart = new window.Chart(canvasEl, {
      type: chartType,
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
