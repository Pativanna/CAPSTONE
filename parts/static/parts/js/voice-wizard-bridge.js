/**
 * Voice Wizard Bridge
 * 
 * Conecta la nueva UI del wizard con la lógica existente en hands-free-voice.js
 * Sigue el patrón onReady/init/cleanup documentado en Calidad/PRACTICAS_DESARROLLO.txt
 * 
 * @version 2026-01-02
 */

(function() {
  'use strict';

  let initialized = false;
  let currentStep = 0;
  const STEPS = {
    SELECT: 0,
    VOICE: 1,
    REVIEW: 2,
    SUCCESS: 3,
    PROCESSING: 'processing'
  };

  // Referencias a elementos del DOM
  let elements = {};

  function onReady(callback) {
    const fire = () => {
      if (!document.getElementById('voice-wizard-root')) return;
      callback();
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fire, { once: true });
    } else {
      fire();
    }
    document.addEventListener('turbo:load', fire);
    document.addEventListener('turbo:render', fire);
    document.addEventListener('turbo:frame-load', fire);
  }

  function init() {
    if (initialized) return;
    initialized = true;
    
    console.log('[VoiceWizard] Inicializando bridge...');
    
    // Cachear elementos
    elements = {
      // Pasos
      stepSelect: document.getElementById('step-select'),
      stepVoice: document.getElementById('step-voice'),
      stepReview: document.getElementById('step-review'),
      stepSuccess: document.getElementById('step-success'),
      stepProcessing: document.getElementById('step-processing'),
      
      // Indicadores
      wizardTitle: document.getElementById('wizard-title'),
      wizardSteps: document.getElementById('wizard-steps'),
      
      // Selectores
      workshopSelect: document.getElementById('vw-workshop-select'),
      autoSelect: document.getElementById('vw-auto-select'),
      btnStartSession: document.getElementById('btn-start-session'),
      
      // Voz
      btnHandsFree: document.getElementById('btn-hands-free'),
      micIcon: document.getElementById('mic-icon'),
      voiceInstruction: document.getElementById('voice-instruction'),
      voiceHint: document.getElementById('voice-hint'),
      audioLevelBar: document.getElementById('audio-level-bar'),
      audioLevelLabel: document.getElementById('audio-level-label'),
      voiceConfidence: document.getElementById('voice-confidence'),
      confidenceDot: document.getElementById('confidence-dot'),
      confidenceText: document.getElementById('confidence-text'),
      currentStatus: document.getElementById('current-status'),
      
      // Preview de datos
      previewParte: document.getElementById('preview-parte'),
      previewValor: document.getElementById('preview-valor'),
      previewMinValue: document.getElementById('preview-min-value'),
      previewDetalles: document.getElementById('preview-detalles'),
      btnConfirmData: document.getElementById('btn-confirm-data'),
      btnCancelData: document.getElementById('btn-cancel-data'),
      
      // Éxito
      btnAddAnother: document.getElementById('btn-add-another'),
      successMessage: document.getElementById('success-message'),
      
      // Processing
      processingText: document.getElementById('processing-text'),
      
      // Footer
      btnSelectVehicle: document.getElementById('btn-select-vehicle'),
      btnManualEntry: document.getElementById('btn-manual-entry'),
      wizardFooter: document.getElementById('wizard-footer'),
      
      // Context badge
      contextBadge: document.getElementById('context-badge'),
      contextBadgeText: document.getElementById('context-badge-text'),
      
      // Elementos ocultos para compatibilidad
      hiddenAutoSelect: document.getElementById('select-auto'),
      hiddenWorkshopSelect: document.getElementById('select-workshop'),
      hiddenDataPanel: document.getElementById('data-panel'),
      hiddenDataParte: document.getElementById('data-parte'),
      hiddenDataValor: document.getElementById('data-valor'),
      hiddenDataMinValue: document.getElementById('data-min-value'),
      hiddenDataDetalles: document.getElementById('data-detalles')
    };

    // Event listeners
    setupEventListeners();
    
    // Restaurar selección anterior si existe
    restoreLastSelection();
    
    // Validar selección inicial
    validateSelection();
    
    console.log('[VoiceWizard] Bridge inicializado');
  }

  function setupEventListeners() {
    // Selectores de paso 0
    if (elements.workshopSelect) {
      elements.workshopSelect.addEventListener('change', () => {
        syncToHiddenSelect('workshop');
        validateSelection();
      });
    }
    
    if (elements.autoSelect) {
      elements.autoSelect.addEventListener('change', () => {
        syncToHiddenSelect('auto');
        validateSelection();
      });
    }
    
    if (elements.btnStartSession) {
      elements.btnStartSession.addEventListener('click', () => {
        saveSelection();
        goToStep(STEPS.VOICE);
      });
    }
    
    // Footer buttons
    if (elements.btnSelectVehicle) {
      elements.btnSelectVehicle.addEventListener('click', () => {
        goToStep(STEPS.SELECT);
      });
    }
    
    if (elements.btnManualEntry) {
      elements.btnManualEntry.addEventListener('click', () => {
        // Sincronizar selección al modal
        syncSelectionToModal();
        const modal = new bootstrap.Modal(document.getElementById('manualEntryModal'));
        modal.show();
      });
    }
    
    // Botón de cancelar en review
    if (elements.btnCancelData) {
      elements.btnCancelData.addEventListener('click', () => {
        goToStep(STEPS.VOICE);
        // Notificar al sistema original
        if (window.handsFreeBridge?.cancelVoiceCapture) {
          window.handsFreeBridge.cancelVoiceCapture();
        }
      });
    }
    
    // Botón agregar otra
    if (elements.btnAddAnother) {
      elements.btnAddAnother.addEventListener('click', () => {
        goToStep(STEPS.VOICE);
        // Reset para nueva pieza
        resetDataPreview();
      });
    }
    
    // Escuchar eventos del sistema original
    document.addEventListener('handsfree:statechange', handleStateChange);
    document.addEventListener('handsfree:dataCaptured', handleDataCaptured);
    document.addEventListener('handsfree:saved', handleSaved);
    document.addEventListener('handsfree:audioLevel', handleAudioLevel);
    document.addEventListener('handsfree:confidence', handleConfidence);
  }

  function validateSelection() {
    const hasWorkshop = elements.workshopSelect?.value;
    const hasAuto = elements.autoSelect?.value;
    const valid = hasWorkshop && hasAuto;
    
    if (elements.btnStartSession) {
      elements.btnStartSession.disabled = !valid;
    }
    
    return valid;
  }

  function syncToHiddenSelect(type) {
    if (type === 'workshop' && elements.workshopSelect && elements.hiddenWorkshopSelect) {
      elements.hiddenWorkshopSelect.value = elements.workshopSelect.value;
    }
    if (type === 'auto' && elements.autoSelect && elements.hiddenAutoSelect) {
      elements.hiddenAutoSelect.value = elements.autoSelect.value;
    }
  }

  function syncSelectionToModal() {
    const modalAuto = document.getElementById('modal-auto-select');
    const modalWorkshop = document.getElementById('modal-workshop-select');
    
    if (modalAuto && elements.autoSelect) {
      modalAuto.value = elements.autoSelect.value;
    }
    if (modalWorkshop && elements.workshopSelect) {
      modalWorkshop.value = elements.workshopSelect.value;
    }
  }

  function saveSelection() {
    try {
      if (elements.autoSelect?.value) {
        localStorage.setItem('last_auto_id', elements.autoSelect.value);
      }
      if (elements.workshopSelect?.value) {
        localStorage.setItem('last_workshop_id', elements.workshopSelect.value);
      }
    } catch (e) {
      console.warn('[VoiceWizard] No se pudo guardar selección:', e);
    }
    
    // Actualizar context badge
    updateContextBadge();
  }

  function restoreLastSelection() {
    try {
      const lastAuto = localStorage.getItem('last_auto_id');
      const lastWorkshop = localStorage.getItem('last_workshop_id');
      
      if (lastAuto && elements.autoSelect) {
        const option = elements.autoSelect.querySelector(`option[value="${lastAuto}"]`);
        if (option) {
          elements.autoSelect.value = lastAuto;
          syncToHiddenSelect('auto');
        }
      }
      
      if (lastWorkshop && elements.workshopSelect) {
        const option = elements.workshopSelect.querySelector(`option[value="${lastWorkshop}"]`);
        if (option) {
          elements.workshopSelect.value = lastWorkshop;
          syncToHiddenSelect('workshop');
        }
      }
    } catch (e) {
      console.warn('[VoiceWizard] No se pudo restaurar selección:', e);
    }
  }

  function updateContextBadge() {
    if (!elements.contextBadge || !elements.contextBadgeText) return;
    
    const autoText = elements.autoSelect?.selectedOptions[0]?.text || '-';
    elements.contextBadgeText.textContent = autoText;
  }

  function goToStep(stepIndex) {
    const prevStep = currentStep;
    currentStep = stepIndex;
    
    // Ocultar todos los pasos
    const allSteps = document.querySelectorAll('.voice-wizard-step');
    allSteps.forEach(step => {
      step.classList.remove('active', 'exiting');
    });
    
    // Animar salida del paso anterior
    const prevStepEl = getStepElement(prevStep);
    if (prevStepEl && prevStep !== stepIndex) {
      prevStepEl.classList.add('exiting');
    }
    
    // Mostrar nuevo paso
    setTimeout(() => {
      const newStepEl = getStepElement(stepIndex);
      if (newStepEl) {
        newStepEl.classList.add('active');
      }
      
      // Actualizar indicadores de paso
      updateStepIndicators(stepIndex);
      
      // Actualizar título
      updateTitle(stepIndex);
      
      // Mostrar/ocultar footer según paso
      updateFooterVisibility(stepIndex);
      
      // Mostrar/ocultar context badge
      updateContextBadgeVisibility(stepIndex);
    }, 50);
    
    console.log('[VoiceWizard] Cambio de paso:', prevStep, '->', stepIndex);
  }

  function getStepElement(stepIndex) {
    switch(stepIndex) {
      case STEPS.SELECT: return elements.stepSelect;
      case STEPS.VOICE: return elements.stepVoice;
      case STEPS.REVIEW: return elements.stepReview;
      case STEPS.SUCCESS: return elements.stepSuccess;
      case STEPS.PROCESSING:
      case 'processing': return elements.stepProcessing;
      default: return null;
    }
  }

  function updateStepIndicators(stepIndex) {
    if (!elements.wizardSteps) return;
    
    const dots = elements.wizardSteps.querySelectorAll('.voice-wizard-step-dot');
    const numericStep = typeof stepIndex === 'number' ? stepIndex : 1;
    
    dots.forEach((dot, i) => {
      dot.classList.remove('active', 'completed');
      if (i === numericStep) {
        dot.classList.add('active');
      } else if (i < numericStep) {
        dot.classList.add('completed');
      }
    });
  }

  function updateTitle(stepIndex) {
    if (!elements.wizardTitle) return;
    
    const titles = {
      [STEPS.SELECT]: 'Ingesta por Voz',
      [STEPS.VOICE]: 'Escuchando',
      [STEPS.REVIEW]: 'Revisar datos',
      [STEPS.SUCCESS]: '¡Éxito!',
      'processing': 'Procesando...'
    };
    
    elements.wizardTitle.textContent = titles[stepIndex] || 'Ingesta por Voz';
  }

  function updateFooterVisibility(stepIndex) {
    if (!elements.wizardFooter) return;
    
    // Ocultar footer durante processing y success
    const hideFooter = stepIndex === STEPS.PROCESSING || 
                       stepIndex === STEPS.SUCCESS || 
                       stepIndex === 'processing';
    
    elements.wizardFooter.style.display = hideFooter ? 'none' : 'flex';
  }

  function updateContextBadgeVisibility(stepIndex) {
    if (!elements.contextBadge) return;
    
    // Mostrar badge solo durante paso de voz
    const show = stepIndex === STEPS.VOICE;
    elements.contextBadge.classList.toggle('d-none', !show);
  }

  // ============================================
  // Handlers de eventos del sistema original
  // ============================================

  function handleStateChange(event) {
    const { state, buttonState } = event.detail || {};
    console.log('[VoiceWizard] State change:', state, buttonState);
    
    // Mapear estados del sistema original a pasos del wizard
    switch(state) {
      case 'inactive':
        // No cambiar paso automáticamente
        updateVoiceUI('inactive');
        break;
        
      case 'listening_init':
        if (currentStep !== STEPS.VOICE) goToStep(STEPS.VOICE);
        updateVoiceUI('listening');
        break;
        
      case 'recording':
        if (currentStep !== STEPS.VOICE) goToStep(STEPS.VOICE);
        updateVoiceUI('recording');
        break;
        
      case 'processing':
        goToStep(STEPS.PROCESSING);
        break;
        
      case 'showing_data':
        // Los datos ya fueron capturados, ir a review
        goToStep(STEPS.REVIEW);
        break;
        
      case 'confirming':
        if (elements.processingText) {
          elements.processingText.textContent = 'Guardando pieza...';
        }
        goToStep(STEPS.PROCESSING);
        break;
        
      case 'waiting_photos':
        // No cambiar UI del wizard, el overlay de fotos se maneja aparte
        break;
        
      case 'success':
        goToStep(STEPS.SUCCESS);
        break;
    }
  }

  function updateVoiceUI(state) {
    if (!elements.btnHandsFree) return;
    
    // Actualizar estado del botón
    elements.btnHandsFree.dataset.state = state;
    
    // Actualizar icono
    if (elements.micIcon) {
      elements.micIcon.className = 'fas';
      switch(state) {
        case 'inactive':
          elements.micIcon.classList.add('fa-microphone');
          break;
        case 'listening':
          elements.micIcon.classList.add('fa-microphone');
          break;
        case 'recording':
          elements.micIcon.classList.add('fa-stop');
          break;
        case 'processing':
          elements.micIcon.classList.add('fa-spinner', 'fa-spin');
          break;
        case 'success':
          elements.micIcon.classList.add('fa-check');
          break;
      }
    }
    
    // Actualizar instrucción (solo un comando visible)
    if (elements.voiceInstruction && elements.voiceHint) {
      switch(state) {
        case 'inactive':
          elements.voiceInstruction.textContent = 'Toca para iniciar';
          elements.voiceHint.innerHTML = 'Luego di <span class="vw-instruction-command">"Iniciar"</span> para dictar';
          break;
        case 'listening':
          elements.voiceInstruction.textContent = 'Escuchando...';
          elements.voiceHint.innerHTML = 'Di <span class="vw-instruction-command">"Iniciar"</span> para comenzar a dictar';
          break;
        case 'recording':
          elements.voiceInstruction.textContent = 'Dictando pieza';
          elements.voiceHint.innerHTML = 'Di <span class="vw-instruction-command">"Detener"</span> cuando termines';
          break;
        case 'processing':
          elements.voiceInstruction.textContent = 'Procesando...';
          elements.voiceHint.textContent = 'Analizando tu grabación';
          break;
      }
    }
    
    // Status para screen readers
    if (elements.currentStatus) {
      const statusTexts = {
        'inactive': 'Inactivo - toca el botón para iniciar',
        'listening': 'Escuchando - di Iniciar para comenzar',
        'recording': 'Grabando - di Detener para finalizar',
        'processing': 'Procesando grabación'
      };
      elements.currentStatus.textContent = statusTexts[state] || state;
    }
  }

  function handleDataCaptured(event) {
    const data = event.detail || {};
    console.log('[VoiceWizard] Data captured:', data);
    
    // Actualizar preview
    if (elements.previewParte) {
      elements.previewParte.textContent = data.parte || data.name || '-';
    }
    if (elements.previewValor) {
      elements.previewValor.textContent = formatPrice(data.valor || data.max_value);
    }
    if (elements.previewMinValue) {
      elements.previewMinValue.textContent = formatPrice(data.min_value);
    }
    if (elements.previewDetalles) {
      elements.previewDetalles.textContent = data.detalles || data.details || '-';
    }
    
    // Sincronizar con elementos ocultos
    if (elements.hiddenDataParte) elements.hiddenDataParte.textContent = data.parte || '';
    if (elements.hiddenDataValor) elements.hiddenDataValor.textContent = data.valor || '';
    if (elements.hiddenDataMinValue) elements.hiddenDataMinValue.textContent = data.min_value || '';
    if (elements.hiddenDataDetalles) elements.hiddenDataDetalles.textContent = data.detalles || '';
    
    goToStep(STEPS.REVIEW);
  }

  function handleSaved(event) {
    const data = event.detail || {};
    console.log('[VoiceWizard] Saved:', data);
    
    if (elements.successMessage) {
      const partName = data.parte || data.name || 'La pieza';
      elements.successMessage.textContent = `${partName} se ha agregado al inventario`;
    }
    
    goToStep(STEPS.SUCCESS);
  }

  function handleAudioLevel(event) {
    const level = event.detail?.level || 0;
    
    if (elements.audioLevelBar) {
      // Normalizar a porcentaje (0-100)
      const percent = Math.min(100, Math.max(0, level * 100));
      elements.audioLevelBar.style.width = `${percent}%`;
    }
    
    if (elements.audioLevelLabel) {
      if (level < 0.05) {
        elements.audioLevelLabel.textContent = 'Sin audio detectado';
      } else if (level < 0.2) {
        elements.audioLevelLabel.textContent = 'Audio bajo';
      } else if (level < 0.6) {
        elements.audioLevelLabel.textContent = 'Audio normal';
      } else {
        elements.audioLevelLabel.textContent = 'Audio fuerte';
      }
    }
  }

  function handleConfidence(event) {
    const confidence = event.detail?.confidence;
    
    if (!elements.voiceConfidence) return;
    
    if (confidence === null || confidence === undefined) {
      elements.voiceConfidence.classList.add('d-none');
      return;
    }
    
    elements.voiceConfidence.classList.remove('d-none');
    
    const percent = Math.round(confidence * 100);
    
    if (elements.confidenceText) {
      elements.confidenceText.textContent = `${percent}%`;
    }
    
    if (elements.confidenceDot) {
      elements.confidenceDot.classList.remove('high', 'medium', 'low');
      if (percent >= 70) {
        elements.confidenceDot.classList.add('high');
      } else if (percent >= 40) {
        elements.confidenceDot.classList.add('medium');
      } else {
        elements.confidenceDot.classList.add('low');
      }
    }
  }

  function formatPrice(value) {
    if (!value && value !== 0) return '-';
    const num = parseInt(String(value).replace(/[^0-9]/g, ''), 10);
    if (isNaN(num)) return '-';
    return '$' + num.toLocaleString('es-CL');
  }

  function resetDataPreview() {
    if (elements.previewParte) elements.previewParte.textContent = '-';
    if (elements.previewValor) elements.previewValor.textContent = '-';
    if (elements.previewMinValue) elements.previewMinValue.textContent = '-';
    if (elements.previewDetalles) elements.previewDetalles.textContent = '-';
  }

  function cleanup() {
    initialized = false;
    document.removeEventListener('handsfree:statechange', handleStateChange);
    document.removeEventListener('handsfree:dataCaptured', handleDataCaptured);
    document.removeEventListener('handsfree:saved', handleSaved);
    document.removeEventListener('handsfree:audioLevel', handleAudioLevel);
    document.removeEventListener('handsfree:confidence', handleConfidence);
  }

  // Exponer funciones para que hands-free-voice.js pueda comunicarse
  window.voiceWizardBridge = {
    goToStep,
    updateVoiceUI,
    handleDataCaptured,
    handleSaved,
    STEPS
  };

  onReady(init);
  document.addEventListener('turbo:before-render', cleanup);
  document.addEventListener('turbo:before-cache', cleanup);
})();
