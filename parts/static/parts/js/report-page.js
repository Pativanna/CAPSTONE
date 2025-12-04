/**
 * Interacciones para la página de reportes automáticos.
 */
(function () {
  'use strict';

  let selectedFrequency = 'weekly';

  function onReady(cb) {
    const fire = () => cb();
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

  function updateFrequencyInput() {
    const freqInput = document.getElementById('reportFrequency');
    if (freqInput) {
      freqInput.value = selectedFrequency;
    }
  }

  function setSelectedFrequency(value) {
    selectedFrequency = value || 'weekly';
    updateFrequencyInput();
  }

  function resetButtonStyles(button) {
    if (!button) return;
    button.classList.remove('active');
    button.setAttribute('aria-pressed', 'false');
    const badge = button.querySelector('.frequency-badge');
    if (badge) badge.remove();
  }

  function activateButtonStyles(button) {
    if (!button) return;
    button.classList.add('active');
    button.setAttribute('aria-pressed', 'true');
    if (!button.querySelector('.frequency-badge')) {
      const badge = document.createElement('span');
      badge.className = 'frequency-badge';
      badge.textContent = 'Seleccionado';
      button.appendChild(badge);
    }
  }

  function hidePreview() {
    const container = document.getElementById('previewContainer');
    if (container) container.hidden = true;
  }

  function initFrequencyButtons() {
    const buttons = Array.from(document.querySelectorAll('.frequency-btn'));
    if (!buttons.length) return;

    const freqInputValue = document.getElementById('reportFrequency')?.value;
    const activeButton = buttons.find((btn) => btn.classList.contains('active'));
    setSelectedFrequency(
      freqInputValue ||
      activeButton?.dataset.frequency ||
      buttons[0]?.dataset.frequency ||
      'weekly'
    );

    buttons.forEach((btn) => resetButtonStyles(btn));
    const initialButton = buttons.find((btn) => btn.dataset.frequency === selectedFrequency) || buttons[0];
    if (initialButton) activateButtonStyles(initialButton);

    buttons.forEach((btn) => {
      if (btn.dataset.frequencyBound === 'true') return;
      btn.dataset.frequencyBound = 'true';
      btn.addEventListener('click', () => {
        buttons.forEach((item) => resetButtonStyles(item));
        activateButtonStyles(btn);
        setSelectedFrequency(btn.dataset.frequency || 'weekly');
        hidePreview();
      });
    });
  }

  function initPreviewButton() {
    const button = document.getElementById('previewBtn');
    const container = document.getElementById('previewContainer');
    const iframe = document.getElementById('pdfPreview');
    if (!button || !container || !iframe || button.dataset.previewBound === 'true') return;
    const originalContent = button.innerHTML;
    button.dataset.previewBound = 'true';
    button.addEventListener('click', () => {
      button.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Cargando...';
      button.disabled = true;
      container.hidden = false;
      iframe.src = `/reports/preview/?frequency=${encodeURIComponent(selectedFrequency)}`;
      window.setTimeout(() => {
        button.innerHTML = originalContent;
        button.disabled = false;
      }, 1000);
      window.setTimeout(() => {
        container.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 100);
    });
  }

  function initDownloadButton() {
    const button = document.getElementById('downloadBtn');
    if (!button || button.dataset.downloadBound === 'true') return;
    const originalContent = button.innerHTML;
    button.dataset.downloadBound = 'true';
    button.addEventListener('click', () => {
      button.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Generando...';
      button.disabled = true;
      window.open(`/reports/preview/?frequency=${encodeURIComponent(selectedFrequency)}`, '_blank', 'noopener');
      window.setTimeout(() => {
        button.innerHTML = originalContent;
        button.disabled = false;
      }, 1500);
    });
  }

  function initClosePreview() {
    const button = document.getElementById('closePreview');
    if (!button || button.dataset.closeBound === 'true') return;
    button.dataset.closeBound = 'true';
    button.addEventListener('click', () => hidePreview());
  }

  function initSendForm() {
    const form = document.getElementById('sendForm');
    if (!form || form.dataset.sendBound === 'true') return;
    form.dataset.sendBound = 'true';
    const recipientsSelect = document.getElementById('reportRecipients');
    const submitBtn = form.querySelector('button[type=\"submit\"]');
    const originalContent = submitBtn ? submitBtn.innerHTML : '';

    form.addEventListener('submit', (event) => {
      if (!recipientsSelect) return;
      const selected = Array.from(recipientsSelect.selectedOptions || []);
      if (!selected.length) {
        event.preventDefault();
        alert('Por favor selecciona al menos un destinatario');
        return;
      }
      if (submitBtn) {
        submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Enviando...';
        submitBtn.disabled = true;
      }
    });

    form.addEventListener('reset', () => {
      if (submitBtn) {
        submitBtn.innerHTML = originalContent;
        submitBtn.disabled = false;
      }
    });
  }

  function initReportPage() {
    initFrequencyButtons();
    initPreviewButton();
    initDownloadButton();
    initClosePreview();
    initSendForm();
  }

  onReady(initReportPage);
})();
