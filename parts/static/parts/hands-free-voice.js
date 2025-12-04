/**
 * Sistema de Manos Libres con 3 Fases
 * Fase 1: Escucha comando "Iniciar ingreso"
 * Fase 2: Grabación hasta comando "detener"
 * Fase 3: Confirmación con comando "confirmar"
 */

(function() {
  'use strict';

  const MODO_DEBUG = (function resolveDebugFlag(){
    if (typeof window === 'undefined') return false;
    try {
      if (window.location && window.location.hostname === 'localhost'){
        return true;
      }
      const stored = localStorage.getItem('handsfree_debug');
      return stored === 'true';
    } catch (_err) {
      return false;
    }
  })();
  const bitacora = (...args) => MODO_DEBUG && console.log('[ManosLibres]', ...args);
  const VALORES_RESPALDO = Object.freeze({ max: 150000, min: 120000 });

  // Estados del sistema
  const ESTADOS = {
    INACTIVE: 'inactive',
    LISTENING_INIT: 'listening_init',
    RECORDING: 'recording',
    PROCESSING: 'processing',
    SHOWING_DATA: 'showing_data',
    CONFIRMING: 'confirming',
    WAITING_PHOTOS: 'waiting_photos',
    SUCCESS: 'success'
  };

  // Comandos esperados por fase
  // Configuración
  const AJUSTES = {
    voiceEndpoint: '/parts/upload/',
    saveEndpoint: '/parts/add/'
  };

  function humanizeCommandLabel(cmd){
    if (!cmd) return 'Comando';
    return cmd.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function extractConfidencePercent(source){
    if (source === null || source === undefined){
      return null;
    }
    if (typeof source === 'number'){
      return Math.round(source * 100);
    }
    if (typeof source === 'object' && typeof source.vosk_conf_avg === 'number'){
      return Math.round(source.vosk_conf_avg * 100);
    }
    return null;
  }

  class PuenteComandosVoz {
    constructor(options = {}) {
      this.options = options;
      this.mediaStream = null;
      this.audioContext = null;
      this.sourceNode = null;
      this.processorNode = null;
      this.websocket = null;
      const baseProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      this.wsBase = `${baseProto}//${window.location.host}/vosk-ws/?scope=comandos`;
      this.sampleRate = 16000;
      this.captureChunks = [];
      this.captureActive = false;
      this.captureStartedAt = null;
      this.captureLimitMs = 60000;
      this.level = 0;
      this.connected = false;
    }

    async connect() {
      if (this.websocket || this.audioContext) {
        return;
      }
      this.emitState('connecting');
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 48000
        },
        video: false
      });

      this.audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
      }
      this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);
      const bufferSize = 4096;
      this.processorNode = this.audioContext.createScriptProcessor(bufferSize, 1, 1);
      this.processorNode.onaudioprocess = (event) => this.handleAudioProcess(event);
      this.sourceNode.connect(this.processorNode);
      this.processorNode.connect(this.audioContext.destination);

      await this.openWebsocket();
    }

    async openWebsocket() {
      return new Promise((resolve, reject) => {
        let url = this.wsBase;
        const uid = document.getElementById('hands-free-card')?.getAttribute('data-user-id');
        if (uid) {
          url += `&usuario_id=${encodeURIComponent(uid)}`;
        }
        this.websocket = new WebSocket(url);
        this.websocket.binaryType = 'arraybuffer';
        this.websocket.onopen = () => {
          this.connected = true;
          this.emitState('connected');
          if (uid) {
            try {
              this.websocket.send(JSON.stringify({ type: 'identificacion', usuario_id: uid }));
            } catch (_) {}
          }
          resolve();
        };
        this.websocket.onerror = (err) => {
          this.emitError(err);
          reject(err);
        };
        this.websocket.onclose = () => {
          this.connected = false;
          this.emitState('disconnected');
        };
        this.websocket.onmessage = (event) => this.handleMessage(event);
      });
    }

    handleAudioProcess(event) {
      const inputBuffer = event.inputBuffer.getChannelData(0);
      const downsampled = this.downsampleBuffer(inputBuffer, this.audioContext.sampleRate, this.sampleRate);
      if (!downsampled || !downsampled.length) {
        return;
      }

      // Enviar audio al backend SOLO si el WebSocket está realmente abierto,
      // pero calcular el nivel local SIEMPRE para que el medidor funcione
      // aunque haya problemas de conexión con Vosk.
      if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
        const pcm = this.floatTo16BitPCM(downsampled);
        try {
          this.websocket.send(pcm.buffer);
        } catch (err) {
          this.emitError(err);
        }
      }

      const level = Math.sqrt(
        downsampled.reduce((acc, sample) => acc + sample * sample, 0) / downsampled.length
      );
      this.emitLevel(level);

      if (this.captureActive) {
        const chunk = new Float32Array(downsampled);
        this.captureChunks.push(chunk);
        if (this.captureLimitMs && this.captureStartedAt && (performance.now() - this.captureStartedAt) > this.captureLimitMs) {
          this.stopCapture(false);
        }
      }
    }

    handleMessage(event) {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch (_) {
        return;
      }
      if (data.type === 'command_feedback') {
        if (typeof this.options.onCommandFeedback === 'function') {
          try {
            this.options.onCommandFeedback(data);
          } catch (err) {
            bitacora('Error propagando command_feedback', err);
          }
        }
        if (typeof window.handleVoskMessage === 'function') {
          try {
            window.handleVoskMessage(data);
          } catch (err) {
            bitacora('Error reenviando command_feedback a handler legacy', err);
          }
        }
        return;
      }
      if (data.type === 'command' && typeof this.options.onCommand === 'function') {
        bitacora('WS command recibido:', data);
        this.options.onCommand(data.command, data);
        return;
      }
      if (data.type === 'diag') {
        if (typeof data.rms === 'number') {
          this.emitLevel(data.rms);
        }
        if (typeof this.options.onDiag === 'function') {
          try {
            this.options.onDiag(data);
          } catch (err) {
            bitacora('Error propagando diag', err);
          }
        }
        return;
      }
      if ((data.type === 'partial' || data.type === 'final') && typeof this.options.onTranscript === 'function') {
        this.options.onTranscript(data);
      }
    }

    startCapture() {
      this.captureChunks = [];
      this.captureActive = true;
      this.captureStartedAt = performance.now();
    }

    cancelCapture() {
      this.captureActive = false;
      this.captureChunks = [];
      this.captureStartedAt = null;
    }

    async stopCapture(returnBlob = true) {
      if (!this.captureActive) {
        return null;
      }
      this.captureActive = false;
      this.captureStartedAt = null;
      if (!returnBlob || !this.captureChunks.length) {
        this.captureChunks = [];
        return null;
      }
      const totalSamples = this.captureChunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const merged = new Float32Array(totalSamples);
      let offset = 0;
      for (const chunk of this.captureChunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
      this.captureChunks = [];
      const wav = this.createWavFromFloat32(merged, this.sampleRate);
      return wav ? new Blob([wav], { type: 'audio/wav' }) : null;
    }

    disconnect() {
      this.cancelCapture();
      if (this.websocket) {
        try { this.websocket.close(); } catch (_) {}
        this.websocket = null;
      }
      if (this.processorNode) {
        try { this.processorNode.disconnect(); } catch (_) {}
        this.processorNode = null;
      }
      if (this.sourceNode) {
        try { this.sourceNode.disconnect(); } catch (_) {}
        this.sourceNode = null;
      }
      if (this.audioContext) {
        try { this.audioContext.close(); } catch (_) {}
        this.audioContext = null;
      }
      if (this.mediaStream) {
        this.mediaStream.getTracks().forEach(track => track.stop());
        this.mediaStream = null;
      }
    }

    emitLevel(level) {
      this.level = level;
      if (typeof this.options.onLevel === 'function') {
        const clamped = Math.min(1, Math.max(0, level * 4)); // leve compresión
        this.options.onLevel(clamped);
      }
    }

    emitState(state) {
      if (typeof this.options.onStateChange === 'function') {
        this.options.onStateChange(state);
      }
    }

    emitError(err) {
      if (typeof this.options.onError === 'function') {
        this.options.onError(err);
      } else {
        console.error('[PuenteComandosVoz]', err);
      }
    }

    downsampleBuffer(buffer, inputSampleRate, outputSampleRate) {
      if (!buffer || !buffer.length) return null;
      if (outputSampleRate === inputSampleRate) {
        return new Float32Array(buffer);
      }
      const sampleRateRatio = inputSampleRate / outputSampleRate;
      const newLength = Math.round(buffer.length / sampleRateRatio);
      const result = new Float32Array(newLength);
      let offsetResult = 0;
      let offsetBuffer = 0;
      while (offsetResult < result.length) {
        const nextOffset = Math.round((offsetResult + 1) * sampleRateRatio);
        let accum = 0;
        let count = 0;
        for (let i = offsetBuffer; i < nextOffset && i < buffer.length; i++) {
          accum += buffer[i];
          count++;
        }
        result[offsetResult] = count ? accum / count : 0;
        offsetResult++;
        offsetBuffer = nextOffset;
      }
      return result;
    }

    floatTo16BitPCM(float32Array) {
      const buffer = new ArrayBuffer(float32Array.length * 2);
      const view = new DataView(buffer);
      for (let i = 0; i < float32Array.length; i++) {
        let s = Math.max(-1, Math.min(1, float32Array[i]));
        view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      }
      return view;
    }

    createWavFromFloat32(samples, sampleRate) {
      if (!samples || !samples.length) {
        return null;
      }
      const buffer = new ArrayBuffer(44 + samples.length * 2);
      const view = new DataView(buffer);
      const writeString = (offset, string) => {
        for (let i = 0; i < string.length; i++) {
          view.setUint8(offset + i, string.charCodeAt(i));
        }
      };
      writeString(0, 'RIFF');
      view.setUint32(4, 36 + samples.length * 2, true);
      writeString(8, 'WAVE');
      writeString(12, 'fmt ');
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate * 2, true);
      view.setUint16(32, 2, true);
      view.setUint16(34, 16, true);
      writeString(36, 'data');
      view.setUint32(40, samples.length * 2, true);
      let offset = 44;
      for (let i = 0; i < samples.length; i++, offset += 2) {
        let s = Math.max(-1, Math.min(1, samples[i]));
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      }
      return buffer;
    }
  }

  class HandsFreeSystem {
    constructor() {
      this.state = ESTADOS.INACTIVE;
      this.capturedData = null;
      this.puenteVoz = null;
      this.sesionActiva = false; // Control de sesión activa
      this.printerWasConnected = false; // Para tracking de impresora
      this.printerConnected = false;
      this.printerAlertDismissed = false;
      this.printerModal = null;
      this.printerModalResolve = null;
      this.printerModalInitialized = false;
      this.printerModalEl = null;
      this.printerModalMessageEl = null;
      this.printerModalErrorEl = null;
      this.printerManager = null;
      this.audioLevel = 0;
      this.audioCueContext = null;
      this.lastUtterance = null;
      this.pendingPhotoPartId = null;
      this.pendingPhotoData = null;
      this.capturePhotosEnabled = true;
      this.photoOverlay = null;
      this.photoVideo = null;
      this.photoCanvas = null;
      this.photoThumbs = null;
      this.photoCountLabel = null;
      this.photoStream = null;
      this.capturedPhotos = [];
      this.photoUploadInProgress = false;
      this.lastCommandConfidence = null;
      this.lastCommandLabel = null;
      this.lastCommandStatus = null;
      this.lastCommandReason = null;
      this.viewportHandlersBound = false;
      
      // Guard de autenticación: si el backend no reconoce al usuario
      // como autenticado, redirigir a login antes de permitir Manos Libres.
      const body = document.body;
      const authAttr = body ? body.getAttribute('data-user-authenticated') : null;
      const isAuthenticated = authAttr === 'true';
      if (!isAuthenticated) {
        try {
          if (window.showToast) {
            window.showToast({
              title: 'Sesión requerida',
              body: 'Debes iniciar sesión para usar el modo manos libres.',
              variant: 'warning',
              delay: 4500
            });
          } else {
            alert('Debes iniciar sesión para usar el modo manos libres.');
          }
        } catch (_) {}
        const nextUrl = encodeURIComponent(window.location.pathname + window.location.search);
        window.location.href = `/login/?next=${nextUrl}`;
        return;
      }
      
      this.initElements();
      this.initEventListeners();
      this.initPrinterBridge();
      this.checkInitialState();
      this.updatePhotoPreference(true);
      this.updateUI();
      this.updateAudioLevel(0);
      this.ensureViewportUnitListeners();
    }

    checkInitialState() {
      // Al cargar página en parts/add, SIEMPRE limpiar selección previa y pedir que elijan de nuevo
      const autoSelect = document.getElementById('select-auto');
      const workshopSelect = document.getElementById('select-workshop');
      const modalAutoSelect = document.getElementById('modal-auto-select');
      const modalWorkshopSelect = document.getElementById('modal-workshop-select');
      
      // Limpiar localStorage para forzar nueva selección
      try {
        localStorage.removeItem('last_auto_id');
        localStorage.removeItem('last_workshop_id');
      } catch(e) {}
      
      // Limpiar valores de los selectores
      if (autoSelect) autoSelect.value = '';
      if (workshopSelect) workshopSelect.value = '';
      if (modalAutoSelect) modalAutoSelect.value = '';
      if (modalWorkshopSelect) modalWorkshopSelect.value = '';
      
      // SIEMPRE mostrar modal de selección al inicio (cada recarga de página)
      setTimeout(() => {
        const modal = new bootstrap.Modal(document.getElementById('vehicleSelectModal'), {
          backdrop: 'static',  // No permitir cerrar clickeando fuera
          keyboard: false       // No permitir cerrar con ESC
        });
        modal.show();
      }, 300);
      this.updateContextSummary(false);
    }

    initElements() {
      this.btnHandsFree = document.getElementById('btn-hands-free');
      this.btnManualEntry = document.getElementById('btn-manual-entry');
      this.btnSelectVehicle = document.getElementById('btn-select-vehicle');
      this.btnConfirmData = document.getElementById('btn-confirm-data');
      this.btnUseManual = document.getElementById('btn-use-manual');
      this.btnConfirmVehicle = document.getElementById('btn-confirm-vehicle');
      
      this.statusEl = document.getElementById('current-status');
      this.commandEl = document.getElementById('expected-command');
      this.commandBox = document.getElementById('command-box');
      this.commandFeedbackCard = document.getElementById('voice-command-feedback');
      this.commandFeedbackText = document.getElementById('voice-command-feedback-text');
      this.commandFeedbackDetail = document.getElementById('voice-command-feedback-detail');
      this.commandFeedbackConfidence = document.getElementById('voice-command-confidence');
      this.commandConfidenceBar = document.getElementById('voice-command-confidence-bar');
      this.commandConfidenceLabel = document.getElementById('voice-command-confidence-label');
      this.audioQualityHint = document.getElementById('audio-quality-hint');
      this.voiceDataCard = document.getElementById('voice-data-feedback');
      this.voiceDataPill = document.getElementById('voice-data-status-pill');
      this.voiceDataSummary = document.getElementById('voice-data-summary');
      this.voiceDataList = document.getElementById('voice-data-list');
      this.dataPanel = document.getElementById('data-panel');
      this.successAnimation = document.getElementById('success-animation');
      this.transcriptionLog = document.getElementById('transcription-log');
      this.transcriptionText = document.getElementById('transcription-text');
      this.audioMeterWrapper = document.getElementById('audio-meter-wrapper');
      this.mainButtonContainer = document.getElementById('hands-free-main-button-container');
      this.confirmHint = document.getElementById('confirm-hint');
      this.inlineCancelBtn = document.getElementById('inline-cancel-btn');
      this.handsFreeCard = document.getElementById('hands-free-card');
      this.contextSummary = document.getElementById('context-summary');
      this.summaryAuto = document.getElementById('summary-auto');
      this.summaryTaller = document.getElementById('summary-taller');
      this.summaryPhotos = document.getElementById('summary-photos');
      this.capturePhotosSwitch = document.getElementById('capture-photos-switch');
      this.modalCapturePhotosSwitch = document.getElementById('modal-capture-photos-switch');
      this.photoOverlay = document.getElementById('photo-capture-overlay');
      this.photoVideo = document.getElementById('photo-preview-video');
      this.photoCanvas = document.getElementById('photo-capture-canvas');
      this.photoThumbs = document.getElementById('photo-thumbnails');
      this.photoCountLabel = document.getElementById('photo-count');
      this.btnStartPhotoCamera = document.getElementById('btn-start-photo-camera');
      this.btnTakePhoto = document.getElementById('btn-take-photo');
      this.btnUploadPhotos = document.getElementById('btn-upload-photos');
      this.btnSkipPhotos = document.getElementById('btn-skip-photos');
      this.btnClosePhotos = document.getElementById('btn-close-photos');

      if (this.confirmHint) {
        this.confirmHint.dataset.defaultDisplay = 'flex';
      }
      if (this.contextSummary) {
        this.contextSummary.dataset.defaultDisplay = 'block';
      }
      if (this.commandBox) {
        this.commandBox.dataset.defaultDisplay = 'block';
      }
      if (this.commandFeedbackCard) {
        this.commandFeedbackCard.dataset.defaultDisplay = 'block';
      }
      
      this.dataFields = {
        parte: document.getElementById('data-parte'),
        valor: document.getElementById('data-valor'),
        min_value: document.getElementById('data-min-value'),
        detalles: document.getElementById('data-detalles')
      };

      [this.audioMeterWrapper, this.audioQualityHint, this.mainButtonContainer, this.btnSelectVehicle, this.btnManualEntry, this.confirmHint, this.contextSummary, this.commandBox].forEach(el => this.rememberDefaultDisplay(el));

      if (this.inlineCancelBtn && !this.inlineCancelBtn.__HFBound) {
        this.inlineCancelBtn.__HFBound = true;
        this.inlineCancelBtn.addEventListener('click', () => this.cancelVoiceCapture());
      }

      if (this.btnSelectVehicle) {
        this.btnSelectVehicle.disabled = true;
        this.btnSelectVehicle.title = 'Para cambiar el vehículo recarga la página';
      }
      this.resetCommandFeedback({ preserve: false });
      this.resetDataFeedback();
    }

    ensureViewportUnitListeners() {
      if (this.viewportHandlersBound) return;
      this.viewportHandlersBound = true;
      this.syncPhotoViewportUnit();
      const handler = () => this.syncPhotoViewportUnit();
      window.addEventListener('resize', handler);
      if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', handler);
      }
    }

    syncPhotoViewportUnit() {
      const viewport = window.visualViewport?.height || window.innerHeight || 0;
      if (!viewport) return;
      const unit = (viewport / 100).toFixed(4);
      document.documentElement.style.setProperty('--photo-safe-vh', `${unit}px`);
    }

    initEventListeners() {
      if (this.btnHandsFree) this.btnHandsFree.addEventListener('click', () => this.handleMainButton());
      if (this.btnManualEntry) this.btnManualEntry.addEventListener('click', () => this.showManualEntry());
      if (this.btnSelectVehicle) this.btnSelectVehicle.addEventListener('click', () => this.showVehicleSelect());
      if (this.btnConfirmVehicle) this.btnConfirmVehicle.addEventListener('click', () => this.confirmVehicleSelection());
      if (this.btnConfirmData) this.btnConfirmData.addEventListener('click', () => this.confirmData());
      if (this.btnUseManual) this.btnUseManual.addEventListener('click', () => this.applyManualEntry());
      if (this.capturePhotosSwitch) {
        this.capturePhotosSwitch.addEventListener('change', () => this.updatePhotoPreference(this.capturePhotosSwitch.checked));
      }
      if (this.modalCapturePhotosSwitch) {
        this.modalCapturePhotosSwitch.addEventListener('change', () => this.updatePhotoPreference(this.modalCapturePhotosSwitch.checked));
      }
      if (this.btnStartPhotoCamera) {
        this.btnStartPhotoCamera.addEventListener('click', async () => {
          try {
            this.btnStartPhotoCamera.disabled = true;
            await this.ensurePhotoStream({ fromUserGesture: true });
          } catch (_err) {
            /* handled inside ensurePhotoStream */
          } finally {
            this.btnStartPhotoCamera.disabled = false;
          }
        });
      }
      if (this.btnTakePhoto) {
        this.btnTakePhoto.addEventListener('click', () => this.capturePhotoFrame());
      }
      if (this.btnUploadPhotos) {
        this.btnUploadPhotos.addEventListener('click', () => this.uploadCapturedPhotos());
      }
      if (this.btnSkipPhotos) {
        this.btnSkipPhotos.addEventListener('click', () => this.skipPhotoWorkflow());
      }
      if (this.btnClosePhotos) {
        this.btnClosePhotos.addEventListener('click', () => this.skipPhotoWorkflow());
      }

      const autoSelect = document.getElementById('select-auto');
      const workshopSelect = document.getElementById('select-workshop');
      [autoSelect, workshopSelect].forEach((el) => {
        if (el && !el.__HFBound) {
          el.__HFBound = true;
          el.addEventListener('change', () => this.updateContextSummary(false));
        }
      });
      
      // Edición de campos con doble click/tap
      Object.entries(this.dataFields).forEach(([key, el]) => {
        if (!el) return;
        el.addEventListener('dblclick', () => this.editField(el, key));
        el.addEventListener('keydown', (event) => {
          if ((event.key === 'Enter' || event.key === ' ') && !el.isContentEditable){
            event.preventDefault();
            this.editField(el, key);
          }
        });
        // Touch para móviles
        let tapCount = 0;
        let tapTimer = null;
        el.addEventListener('touchend', (e) => {
          tapCount++;
          if (tapCount === 1) {
            tapTimer = setTimeout(() => { tapCount = 0; }, 300);
          } else if (tapCount === 2) {
            clearTimeout(tapTimer);
            tapCount = 0;
            this.editField(el, key);
          }
        });
      });
    }

    rememberDefaultDisplay(el) {
      if (el && !el.dataset.defaultDisplay) {
        const computed = window.getComputedStyle(el).display;
        el.dataset.defaultDisplay = computed && computed !== 'none' ? computed : '';
      }
    }

    setElementVisibility(el, show) {
      if (!el) return;
      this.rememberDefaultDisplay(el);
      el.style.display = show ? (el.dataset.defaultDisplay || '') : 'none';
    }

    toggleReviewMode(enabled) {
      const showControls = !enabled;
      this.setElementVisibility(this.audioMeterWrapper, showControls);
      this.setElementVisibility(this.mainButtonContainer, showControls);
      this.setElementVisibility(this.btnSelectVehicle, showControls);
      this.setElementVisibility(this.btnManualEntry, showControls);
      this.setElementVisibility(this.confirmHint, enabled);
      if (this.inlineCancelBtn) {
        this.inlineCancelBtn.disabled = !enabled;
      }
      if (this.btnHandsFree) {
        if (enabled) {
          this.btnHandsFree.setAttribute('aria-hidden', 'true');
          this.btnHandsFree.style.visibility = 'hidden';
          this.btnHandsFree.disabled = true;
        } else {
          this.btnHandsFree.removeAttribute('aria-hidden');
          this.btnHandsFree.style.visibility = '';
          this.btnHandsFree.disabled = false;
        }
      }
      this.updateContextSummary(enabled);
    }

    updatePhotoPreference(enabled) {
      const bool = !!enabled;
      this.capturePhotosEnabled = bool;
      if (this.capturePhotosSwitch && this.capturePhotosSwitch.checked !== bool) {
        this.capturePhotosSwitch.checked = bool;
      }
      if (this.modalCapturePhotosSwitch && this.modalCapturePhotosSwitch.checked !== bool) {
        this.modalCapturePhotosSwitch.checked = bool;
      }
      const showPanel = !!(this.dataPanel && this.dataPanel.style.display !== 'none');
      this.updateContextSummary(showPanel);
    }

    updateContextSummary(showInPanel) {
      if (!this.contextSummary) return;
      const autoSelect = document.getElementById('select-auto');
      const workshopSelect = document.getElementById('select-workshop');
      const autoLabel = autoSelect && autoSelect.value ? autoSelect.selectedOptions[0]?.text?.trim() : '';
      const workshopLabel = workshopSelect && workshopSelect.value ? workshopSelect.selectedOptions[0]?.text?.trim() : '';
      if (this.summaryAuto) this.summaryAuto.textContent = autoLabel || 'Sin seleccionar';
      if (this.summaryTaller) this.summaryTaller.textContent = workshopLabel || 'Sin seleccionar';
      if (this.summaryPhotos) this.summaryPhotos.textContent = this.capturePhotosEnabled ? 'Sí' : 'No';
      const shouldShow = !!showInPanel && (autoLabel || workshopLabel);
      this.setElementVisibility(this.contextSummary, shouldShow);
    }

    updateCommandBoxVisibility() {
      this.setElementVisibility(this.commandBox, !!this.sesionActiva);
    }

    triggerCardPulse(kind) {
      if (!this.handsFreeCard) return;
      const cls = kind === 'confirm' ? 'card-pulse--confirm' : 'card-pulse--cancel';
      this.handsFreeCard.classList.remove('card-pulse--confirm', 'card-pulse--cancel');
      void this.handsFreeCard.offsetWidth;
      this.handsFreeCard.classList.add(cls);
      setTimeout(() => this.handsFreeCard.classList.remove(cls), 900);
    }

    initPrinterBridge(retries = 0) {
      if (window.printerManager) {
        this.printerManager = window.printerManager;
        if (typeof this.printerManager.onStatusChange === 'function') {
          this.printerManager.onStatusChange((status) => this.handlePrinterStatus(status));
        }
        if (typeof this.printerManager.isConnected === 'function' && this.printerManager.isConnected()) {
          this.printerConnected = true;
          this.printerWasConnected = true;
        }
        return;
      }
      if (retries > 20) {
        console.warn('printerManager no disponible tras múltiples intentos');
        return;
      }
      setTimeout(() => this.initPrinterBridge(retries + 1), 300);
    }

    ensureCueContext() {
      if (this.audioCueContext) {
        if (this.audioCueContext.state === 'suspended') {
          this.audioCueContext.resume().catch(() => {});
        }
        return this.audioCueContext;
      }
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) {
        return null;
      }
      try {
        this.audioCueContext = new AudioCtx();
      } catch (error) {
        console.warn('AudioContext no disponible para cues', error);
        this.audioCueContext = null;
      }
      return this.audioCueContext;
    }

    playCommandCue(command) {
      const sequences = {
        iniciar_proceso: [
          { freq: 1200, duration: 0.08, gain: 0.18 },
          { freq: 1650, duration: 0.12, gain: 0.18 }
        ],
        finalizar_proceso: [
          { freq: 540, duration: 0.12, gain: 0.2 },
          { freq: 320, duration: 0.16, gain: 0.18 }
        ]
      };
      const seq = sequences[command];
      if (!seq) {
        return;
      }
      const ctx = this.ensureCueContext();
      if (!ctx) {
        return;
      }
      const startTime = ctx.currentTime + 0.01;
      let cursor = startTime;
      seq.forEach((segment) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(segment.freq, cursor);
        gain.gain.setValueAtTime(0.0001, cursor);
        gain.gain.exponentialRampToValueAtTime(segment.gain ?? 0.2, cursor + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, cursor + segment.duration);
        osc.connect(gain).connect(ctx.destination);
        osc.start(cursor);
        osc.stop(cursor + segment.duration + 0.05);
        cursor += segment.duration + 0.02;
      });
    }

    cancelSpeechAnnouncement() {
      if ('speechSynthesis' in window) {
        try {
          window.speechSynthesis.cancel();
        } catch (_) {}
      }
      this.lastUtterance = null;
    }

    announceCapturedData() {
      if (!this.capturedData || !('speechSynthesis' in window) || typeof SpeechSynthesisUtterance === 'undefined') {
        return;
      }
      const fragments = [];
      const nombre = this.capturedData.parte || 'Pieza detectada';
      fragments.push(nombre);

      const mainPriceText = this.formatPriceForSpeech(this.capturedData.valor);
      if (mainPriceText) {
        fragments.push(`Precio normal ${mainPriceText}`);
      }

      const minPriceText = this.formatPriceForSpeech(this.capturedData.min_value);
      if (minPriceText) {
        fragments.push(`Precio mínimo ${minPriceText}`);
      }

      if (this.capturedData.detalles) {
        fragments.push(`Detalles: ${this.capturedData.detalles}`);
      }

      const speechText = fragments.join('. ').replace(/\s+/g, ' ').trim();
      if (!speechText) {
        return;
      }
      this.cancelSpeechAnnouncement();
      const utterance = new SpeechSynthesisUtterance(speechText);
      utterance.lang = 'es-CL';
      utterance.rate = 1.03;
      this.lastUtterance = utterance;
      window.speechSynthesis.speak(utterance);
    }

    normalizePriceValue(value) {
      if (typeof window.normalizeCLPNumber === 'function') {
        return window.normalizeCLPNumber(value);
      }
      if (value === null || value === undefined) {
        return null;
      }
      const numeric = Number(String(value).replace(/[^0-9]/g, ''));
      return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
    }

    /**
     * Formato especial para voz: evita puntos decimales que el TTS lee como "punto cero cero cero".
     * Ejemplo: 40000 -> "40 mil pesos", 950 -> "950 pesos".
     */
    formatPriceForSpeech(value) {
      const n = this.normalizePriceValue(value);
      if (n === null) return '';

      // Tratar miles exactos de forma más natural
      if (n >= 1000 && n < 1000000 && n % 1000 === 0) {
        const miles = n / 1000;
        return `${miles} mil pesos`;
      }

      try {
        // Sin separadores de miles para que el TTS no diga "punto"
        const plain = new Intl.NumberFormat('es-CL', {
          minimumFractionDigits: 0,
          maximumFractionDigits: 0,
          useGrouping: false
        }).format(n);
        return `${plain} pesos`;
      } catch (_) {
        return `${n} pesos`;
      }
    }

    formatPriceValue(value) {
      if (typeof window.formatCLP === 'function') {
        return window.formatCLP(value);
      }
      try {
        return new Intl.NumberFormat('es-CL', { minimumFractionDigits: 0 }).format(value);
      } catch (_) {
        return String(value ?? '');
      }
    }

    async ensureVoiceBridge() {
      if (this.puenteVoz) {
        return;
      }
      this.puenteVoz = new PuenteComandosVoz({
        onCommandFeedback: (payload) => this.updateCommandFeedback(payload),
        onCommand: (command, payload) => this.handleVoiceCommand(command, payload),
        onLevel: (level) => this.updateAudioLevel(level),
        onDiag: (payload) => this.handleDiagEvent(payload),
        onStateChange: (state) => this.handleVoiceBridgeState(state),
        onError: (err) => this.handleVoiceBridgeError(err)
      });
    }

    handlePrinterStatus(status) {
      if (!status || typeof status !== 'object') return;
      switch (status.type) {
        case 'connected':
          this.printerConnected = true;
          this.printerWasConnected = true;
          this.hidePrinterModal();
          break;
        case 'disconnected':
          this.printerConnected = false;
          if (this.printerWasConnected && !this.printerAlertDismissed) {
            this.promptPrinterReconnect('La impresora Bluetooth se desconectó.');
          }
          break;
        default:
          break;
      }
    }

    ensurePrinterModal() {
      if (this.printerModal) {
        return this.printerModal;
      }
      const modalId = 'printerDisconnectModal';
      if (!document.getElementById(modalId)) {
        const template = `
          <div class="modal fade" id="${modalId}" tabindex="-1" aria-hidden="true">
            <div class="modal-dialog">
              <div class="modal-content">
                <div class="modal-header">
                  <h5 class="modal-title">Impresora desconectada</h5>
                </div>
                <div class="modal-body">
                  <p id="printer-modal-message" class="mb-2">
                    La impresora Bluetooth se desconectó. ¿Deseas reconectarla antes de continuar?
                  </p>
                  <div id="printer-modal-error" class="text-danger small hf-min-height"></div>
                  <p class="small text-muted mb-0">Puedes elegir no volver a mostrar este aviso durante esta sesión.</p>
                </div>
                <div class="modal-footer">
                  <button type="button" class="btn btn-outline-secondary" data-action="dismiss">
                    No volver a mostrar
                  </button>
                  <button type="button" class="btn btn-primary" data-action="connect">
                    Conectar impresora
                  </button>
                </div>
              </div>
            </div>
          </div>`;
        document.body.insertAdjacentHTML('beforeend', template);
      }
      this.printerModalEl = document.getElementById(modalId);
      this.printerModalMessageEl = this.printerModalEl.querySelector('#printer-modal-message');
      this.printerModalErrorEl = this.printerModalEl.querySelector('#printer-modal-error');
      this.printerModalConnectBtn = this.printerModalEl.querySelector('[data-action="connect"]');
      this.printerModalDismissBtn = this.printerModalEl.querySelector('[data-action="dismiss"]');
      const modalInstance = new bootstrap.Modal(this.printerModalEl, { backdrop: 'static', keyboard: false });
      this.printerModal = modalInstance;

      if (!this.printerModalInitialized) {
        this.printerModalConnectBtn.addEventListener('click', async () => {
          if (!this.printerModalConnectBtn) return;
          this.printerModalConnectBtn.disabled = true;
          if (this.printerModalErrorEl) {
            this.printerModalErrorEl.textContent = '';
          }
          try {
            await this.connectPrinter();
            this.printerAlertDismissed = false;
            this.resolvePrinterModal('connect');
            this.hidePrinterModal();
          } catch (error) {
            console.error('Error al reconectar impresora:', error);
            if (this.printerModalErrorEl) {
              this.printerModalErrorEl.textContent = error?.message || 'No se pudo conectar la impresora';
            }
            this.printerModalConnectBtn.disabled = false;
          }
        });

        this.printerModalDismissBtn.addEventListener('click', () => {
          this.printerAlertDismissed = true;
          this.resolvePrinterModal('dismiss');
          this.hidePrinterModal();
        });

        this.printerModalEl.addEventListener('hidden.bs.modal', () => {
          this.resolvePrinterModal('closed');
          if (this.printerModalConnectBtn) {
            this.printerModalConnectBtn.disabled = false;
          }
        });

        this.printerModalInitialized = true;
      }

      return this.printerModal;
    }

    hidePrinterModal() {
      if (this.printerModal) {
        this.printerModal.hide();
      }
      this.printerModalResolve = null;
      if (this.printerModalErrorEl) {
        this.printerModalErrorEl.textContent = '';
      }
      if (this.printerModalConnectBtn) {
        this.printerModalConnectBtn.disabled = false;
      }
    }

    resolvePrinterModal(result) {
      if (this.printerModalResolve) {
        this.printerModalResolve(result);
        this.printerModalResolve = null;
      }
    }

    async promptPrinterReconnect(reason) {
      if (!this.printerWasConnected || this.printerAlertDismissed) {
        return 'skipped';
      }
      this.ensurePrinterModal();
      if (this.printerModalMessageEl && reason) {
        this.printerModalMessageEl.textContent = reason;
      }
      if (!this.printerModal) {
        return 'skipped';
      }
      this.printerModal.show();
      return new Promise((resolve) => {
        this.printerModalResolve = resolve;
      });
    }

    async handleMainButton() {
      bitacora('Button clicked, current state:', this.state);
      this.ensureCueContext();
      this.cancelSpeechAnnouncement();
      
      // Si está en sesión activa, el botón funciona como detener
      if (this.sesionActiva && this.state !== ESTADOS.INACTIVE) {
        this.stopSession();
        return;
      }
      
      // Si está inactivo, iniciar sesión
      if (this.state === ESTADOS.INACTIVE) {
        await this.startSession();
      }
    }
    
    async startSession() {
      bitacora('Starting hands-free session');
      await this.ensureVoiceBridge();
      this.ensureCueContext();
      try {
        await this.puenteVoz.connect();
        this.sesionActiva = true;
        this.setState(ESTADOS.LISTENING_INIT);
        this.showStatusMessage('Esperando comando: Diga "Iniciar"', 'info');
        this.updateCommandBoxVisibility();
      } catch (error) {
        console.error('Error iniciando sesión manos libres:', error);
        alert('No se pudo iniciar el micrófono. Verifica los permisos.');
        this.sesionActiva = false;
        if (this.puenteVoz) {
          this.puenteVoz.disconnect();
          this.puenteVoz = null;
        }
        this.updateCommandBoxVisibility();
      }
    }
    
    stopSession() {
      bitacora('Stopping hands-free session');
      this.sesionActiva = false;
      this.closePhotoOverlay();
      this.clearCapturedPhotos();
      this.pendingPhotoPartId = null;
      this.pendingPhotoData = null;
      if (this.puenteVoz) {
        this.puenteVoz.disconnect();
        this.puenteVoz = null;
      }
      this.updateCommandBoxVisibility();
      this.reset();
    }

    handleVoiceCommand(command, payload) {
      if (!this.sesionActiva || !command) {
        return;
      }
      if (this.state === ESTADOS.WAITING_PHOTOS) {
        return;
      }
      if (command === 'iniciar_proceso' || command === 'finalizar_proceso') {
        this.playCommandCue(command);
      }
      switch (command) {
        case 'iniciar_proceso':
          this.beginVoiceCapture();
          break;
        case 'finalizar_proceso':
          this.finalizeVoiceCapture(payload);
          break;
        case 'cancelar_proceso':
          this.cancelVoiceCapture();
          break;
        case 'repetir_proceso':
          this.restartVoiceCapture();
          break;
        case 'confirmar_datos':
          if (this.state === ESTADOS.SHOWING_DATA) {
            this.confirmData();
          }
          break;
        default:
          break;
      }
    }

    updateCommandFeedback(evt) {
      if (!this.commandFeedbackCard) {
        return;
      }
      const status = evt?.status || (evt?.type === 'command' ? 'accepted' : 'info');
      const cmdLabel = humanizeCommandLabel(evt?.command) || evt?.raw_text || 'Comando';
      const confidencePercent = extractConfidencePercent(evt?.confidence);
      const thresholdPercent = typeof evt?.threshold === 'number' ? Math.round(evt.threshold * 100) : null;
      const reason = evt?.reason || null;
      if (confidencePercent === null) {
        bitacora('CONFIDENCE_NA', {
          rawConfidence: evt?.confidence,
          status,
          cmdLabel,
          rawEvent: evt
        });
      }

      this.commandFeedbackCard.style.display = 'block';

      let badgeClass = 'text-bg-secondary';
      let badgeText = '--';
      let detailText = 'Esperando comandos válidos';
      let headline = cmdLabel;

      if (status === 'accepted') {
        badgeClass = 'text-bg-success';
        if (confidencePercent !== null) {
          badgeText = `${confidencePercent}%`;
        } else if (reason === 'confidence_pending') {
          badgeText = '...';
        } else {
          badgeText = 'OK';
        }
        headline = `Comando detectado: ${cmdLabel}`;
        if (confidencePercent !== null) {
          detailText = `Confianza ${confidencePercent}%`;
        } else if (reason === 'confidence_pending') {
          detailText = 'Esperando evaluación de confianza...';
        } else {
          detailText = 'Confianza no disponible';
        }
        this.commandFeedbackCard.classList.remove('feedback-rejected');
        this.commandFeedbackCard.classList.add('feedback-accepted');
      } else if (status === 'rejected') {
        badgeClass = 'text-bg-warning';
        badgeText = confidencePercent !== null ? `${confidencePercent}%` : 'N/D';
        headline = `Ignorado: ${cmdLabel}`;
        if (evt?.reason === 'low_confidence' && thresholdPercent !== null && confidencePercent !== null) {
          detailText = `Confianza ${confidencePercent}% (mínimo ${thresholdPercent}%)`;
        } else if (evt?.reason === 'low_confidence' && thresholdPercent !== null) {
          detailText = `Confianza bajo el mínimo (${thresholdPercent}%)`;
        } else {
          detailText = 'No alcanzó los criterios requeridos';
        }
        this.commandFeedbackCard.classList.remove('feedback-accepted');
        this.commandFeedbackCard.classList.add('feedback-rejected');
      } else {
        this.commandFeedbackCard.classList.remove('feedback-accepted', 'feedback-rejected');
      }

      if (this.commandFeedbackText) {
        this.commandFeedbackText.textContent = headline;
      }
      if (this.commandFeedbackDetail) {
        this.commandFeedbackDetail.textContent = detailText;
      }
      if (this.commandFeedbackConfidence) {
        this.commandFeedbackConfidence.textContent = badgeText;
        this.commandFeedbackConfidence.className = `badge ${badgeClass} text-uppercase`;
      }
      const clamped = typeof confidencePercent === 'number'
        ? Math.max(0, Math.min(100, confidencePercent))
        : null;
      if (this.commandConfidenceBar) {
        const width = clamped !== null ? clamped : 0;
        this.commandConfidenceBar.style.width = `${width}%`;
        const track = this.commandConfidenceBar.parentElement;
        if (track) {
          track.setAttribute('aria-valuenow', width);
        }
      }
      if (confidencePercent !== null) {
        this.lastCommandConfidence = confidencePercent;
      }
      if (cmdLabel) {
        this.lastCommandLabel = cmdLabel;
      }
      this.lastCommandStatus = status;
      this.lastCommandReason = reason;

      if (this.commandConfidenceLabel) {
        if (confidencePercent !== null) {
          this.commandConfidenceLabel.textContent = `Confianza en vivo: ${confidencePercent}%`;
        } else if (reason === 'confidence_pending') {
          this.commandConfidenceLabel.textContent = 'Confianza en vivo: midiendo...';
        } else if (status === 'rejected' && evt?.reason === 'low_confidence' && thresholdPercent !== null) {
          this.commandConfidenceLabel.textContent = `Confianza insuficiente (mínimo ${thresholdPercent}%)`;
        } else {
          this.commandConfidenceLabel.textContent = 'Confianza en vivo: N/D';
          bitacora('CONFIDENCE_LABEL_NA', {
            reason: evt?.reason || 'unknown',
            thresholdPercent,
            lastConfidence: this.lastCommandConfidence
          });
        }
      }
    }

    resetCommandFeedback(options = {}) {
      const preserve = !!options.preserve;
      const hasConfidence = typeof this.lastCommandConfidence === 'number';
      const pendingConfidence = preserve && !hasConfidence && this.lastCommandReason === 'confidence_pending';
      if (this.commandFeedbackCard) {
        this.commandFeedbackCard.classList.remove('feedback-accepted', 'feedback-rejected');
        if (preserve && hasConfidence) {
          this.commandFeedbackCard.classList.add(this.lastCommandStatus === 'rejected' ? 'feedback-rejected' : 'feedback-accepted');
        } else if (pendingConfidence) {
          this.commandFeedbackCard.classList.add('feedback-accepted');
        } else if (this.commandFeedbackCard.dataset?.defaultDisplay) {
          this.commandFeedbackCard.style.display = this.commandFeedbackCard.dataset.defaultDisplay;
        }
      }
      if (this.commandFeedbackText) {
        if (preserve && (hasConfidence || pendingConfidence) && this.lastCommandLabel) {
          this.commandFeedbackText.textContent = `Último comando: ${this.lastCommandLabel}`;
        } else {
          this.commandFeedbackText.textContent = 'Sin comandos detectados';
        }
      }
      if (this.commandFeedbackDetail) {
        if (preserve && hasConfidence) {
          this.commandFeedbackDetail.textContent = 'Esperando un nuevo comando válido.';
        } else if (pendingConfidence) {
          this.commandFeedbackDetail.textContent = 'Esperando evaluación de confianza pendiente.';
        } else {
          this.commandFeedbackDetail.textContent = 'Usa “Iniciar ingreso”, “Detener ingreso”, “Confirmar ingreso”, “Cancelar ingreso” o “Repetir ingreso”.';
        }
      }
      if (this.commandFeedbackConfidence) {
        if (preserve && hasConfidence) {
          const badgeStyle = this.lastCommandStatus === 'rejected'
            ? 'text-bg-warning'
            : (this.lastCommandStatus === 'accepted' ? 'text-bg-success' : 'text-bg-secondary');
          this.commandFeedbackConfidence.textContent = `${this.lastCommandConfidence}%`;
          this.commandFeedbackConfidence.className = `badge ${badgeStyle} text-uppercase`;
        } else if (pendingConfidence) {
          this.commandFeedbackConfidence.textContent = '...';
          this.commandFeedbackConfidence.className = 'badge text-bg-secondary text-uppercase';
        } else {
          this.commandFeedbackConfidence.textContent = '--';
          this.commandFeedbackConfidence.className = 'badge text-bg-secondary text-uppercase';
        }
      }
      if (this.commandConfidenceBar) {
        const width = preserve && hasConfidence ? this.lastCommandConfidence : 0;
        this.commandConfidenceBar.style.width = `${width}%`;
        const track = this.commandConfidenceBar.parentElement;
        if (track) {
          track.setAttribute('aria-valuenow', width);
        }
      }
      if (this.commandConfidenceLabel) {
        if (preserve && hasConfidence) {
          this.commandConfidenceLabel.textContent = `Última confianza: ${this.lastCommandConfidence}% (esperando nuevo comando)`;
        } else if (pendingConfidence) {
          this.commandConfidenceLabel.textContent = 'Última confianza: pendiente de cálculo...';
        } else {
          this.commandConfidenceLabel.textContent = 'Confianza en vivo: --';
        }
      }
      if (!preserve) {
        this.lastCommandConfidence = null;
        this.lastCommandLabel = null;
        this.lastCommandStatus = null;
        this.lastCommandReason = null;
      }
    }

    resetDataFeedback() {
      if (!this.voiceDataCard) return;
      this.voiceDataCard.hidden = true;
      this.voiceDataCard.classList.add('d-none');
      if (this.voiceDataPill) {
        this.voiceDataPill.textContent = '--';
        this.voiceDataPill.className = 'badge text-bg-secondary text-uppercase';
      }
      if (this.voiceDataSummary) {
        this.voiceDataSummary.textContent = 'Aún no hay datos para mostrar.';
      }
      if (this.voiceDataList) {
        this.voiceDataList.innerHTML = '<li class="text-muted">Sin resultados.</li>';
      }
    }

    updateDataFeedback({ variant = 'info', pill = '--', summary = '', items = [] } = {}) {
      if (!this.voiceDataCard) return;
      this.voiceDataCard.hidden = false;
      this.voiceDataCard.classList.remove('d-none');
      const map = {
        success: 'text-bg-success',
        info: 'text-bg-info',
        warning: 'text-bg-warning',
        danger: 'text-bg-danger',
        secondary: 'text-bg-secondary'
      };
      if (this.voiceDataPill) {
        this.voiceDataPill.className = `badge ${map[variant] || 'text-bg-secondary'} text-uppercase`;
        this.voiceDataPill.textContent = pill;
      }
      if (this.voiceDataSummary) {
        this.voiceDataSummary.textContent = summary || '';
      }
      if (this.voiceDataList) {
        if (!items.length) {
          this.voiceDataList.innerHTML = '<li class="text-muted">Sin resultados.</li>';
        } else {
          this.voiceDataList.innerHTML = items
            .map((item) => `<li><strong>${item.label}:</strong> ${item.value || '-'}</li>`)
            .join('');
        }
      }
    }

    showDataFeedback(data) {
      if (!data) {
        this.updateDataFeedback({
          variant: 'warning',
          pill: 'VACÍO',
          summary: 'No se detectaron campos relevantes. Intenta dictar nuevamente.'
        });
        return;
      }
      const items = [
        { label: 'Nombre', value: data.parte || '--' },
        { label: 'Posición', value: data.posicion || data.posicion_normalizada || '--' },
        { label: 'Precio', value: window.formatCLP?.(data.valor) || data.valor || '--' },
        { label: 'Oferta', value: window.formatCLP?.(data.min_value) || data.min_value || '--' },
        { label: 'Detalles', value: data.detalles || '--' }
      ];
      this.updateDataFeedback({
        variant: 'success',
        pill: 'LISTO',
        summary: 'Datos extraídos correctamente.',
        items
      });
    }

    showDataProcessingStatus() {
      this.updateDataFeedback({
        variant: 'info',
        pill: 'Procesando',
        summary: 'Extrayendo datos del audio, por favor espera…'
      });
    }

    showDataError(message) {
      this.updateDataFeedback({
        variant: 'danger',
        pill: 'Error',
        summary: message || 'No se pudieron extraer datos del audio.'
      });
    }

    beginVoiceCapture() {
      if (!this.puenteVoz || !this.sesionActiva || this.state === ESTADOS.RECORDING) {
        return;
      }
      this.resetDataFeedback();
      this.puenteVoz.startCapture();
      this.setState(ESTADOS.RECORDING);
      this.showStatusMessage('Grabando', 'info');
    }

    async finalizeVoiceCapture(payload) {
      if (!this.puenteVoz || this.state !== ESTADOS.RECORDING) {
        return;
      }
      this.setState(ESTADOS.PROCESSING);
      this.showDataProcessingStatus();
      this.showStatusMessage('Procesando...', 'info');
      try {
        const audioBlob = await this.puenteVoz.stopCapture(true);
        await this.processAudio(audioBlob);
      } catch (error) {
        console.error('Error finalizando captura:', error);
        alert('No se pudo procesar el audio. Intenta nuevamente.');
        this.showDataError('Error al procesar el audio.');
        this.returnToListening();
      }
    }

    cancelVoiceCapture() {
      if (this.puenteVoz) {
        this.puenteVoz.cancelCapture();
      }
      this.triggerCardPulse('cancel');
      this.returnToListening();
    }

    restartVoiceCapture() {
      if (!this.puenteVoz || !this.sesionActiva) {
        return;
      }
      this.puenteVoz.cancelCapture();
      this.puenteVoz.startCapture();
      this.dataPanel.style.display = 'none';
      this.btnConfirmData.style.display = 'none';
      this.capturedData = null;
      this.resetDataFeedback();
      this.setState(ESTADOS.RECORDING);
      this.showStatusMessage('Grabando', 'info');
    }

    updateAudioLevel(level) {
      this.audioLevel = level;
      const bar = document.getElementById('audio-level-bar');
      const label = document.getElementById('audio-level-label');
      if (bar) {
        bar.style.width = Math.round(level * 100) + '%';
      }
      if (label) {
        label.textContent = level > 0.25 ? 'Audio detectado' : 'Esperando audio...';
      }
    }

    handleDiagEvent(payload) {
      if (!payload) return;
      const hintEl = this.audioQualityHint;
      if (!hintEl) return;
      const quality = payload.audio_quality || 'unknown';
      const message = payload.audio_hint || this.defaultQualityHint(quality);
      if (!message) {
        hintEl.textContent = '';
        hintEl.classList.remove('text-warning', 'text-danger');
        return;
      }
      hintEl.textContent = message;
      hintEl.classList.remove('text-warning', 'text-danger');
      if (quality === 'too_low') {
        hintEl.classList.add('text-warning');
      } else if (quality === 'too_high') {
        hintEl.classList.add('text-danger');
      }
    }

    defaultQualityHint(quality){
      switch (quality){
        case 'too_low':
          return 'Micrófono con señal muy baja';
        case 'too_high':
          return 'Demasiado ruido o micrófono saturado';
        case 'ok':
          return 'Nivel de audio estable';
        default:
          return '';
      }
    }

    handleVoiceBridgeState(state) {
      if (state === 'disconnected' && this.sesionActiva) {
        this.showStatusMessage('Reconectando audio...', 'info');
      }
      if (state === 'connected' && this.sesionActiva) {
        this.showStatusMessage('Esperando comando: Diga "Iniciar"', 'info');
      }
    }

    handleVoiceBridgeError(err) {
      console.error('Voice bridge error:', err);
      if (this.sesionActiva) {
        this.showStatusMessage('Error de audio', 'info');
      }
    }

    async processAudio(audioBlob) {
      if (!audioBlob) {
        alert('No se capturó audio. Intenta de nuevo.');
        this.returnToListening();
        return;
      }
      const formData = new FormData();
      formData.append('audio', audioBlob, 'recording.wav');
      formData.append('use_cloud', 'true');
      
      bitacora('Processing audio, size:', audioBlob.size);
      
      try {
        const response = await fetch(AJUSTES.voiceEndpoint, {
          method: 'POST',
          body: formData,
          headers: this.buildAuthHeaders(),
          credentials: 'same-origin'
        });
        
        bitacora('Audio processing response:', response.status);
        
        if (response.ok) {
          const data = await response.json();
          bitacora('Audio processed:', data);
          
          this.updateTranscription(data.transcription);
          
          if (data.vehicle_info) {
            this.capturedData = data.vehicle_info;
            await this.showData();
          } else {
            this.showDataError('No se pudieron extraer datos del audio. Intenta de nuevo.');
            alert('No se pudieron extraer datos del audio. Intenta de nuevo.');
            this.returnToListening();
          }
        } else {
          const errorText = await response.text();
          console.error('Audio processing failed:', response.status, errorText);
          throw new Error('Error processing audio');
        }
      } catch (error) {
        console.error('Error processing audio:', error);
        alert('Error al procesar el audio. Intenta de nuevo.');
        this.showDataError(error?.message || 'No se pudieron extraer datos.');
        this.returnToListening();
      }
    }

    async showData() {
      bitacora('Showing captured data:', this.capturedData);
      this.setState(ESTADOS.SHOWING_DATA);
      this.toggleReviewMode(true);

      // Llenar campos
      Object.entries(this.dataFields).forEach(([key, el]) => {
        if (!el) return;
        let value = this.capturedData[key];
        if (key === 'parte' && value) {
          value = value.toUpperCase();
          this.capturedData.parte = value;
        }
        if (key === 'valor' || key === 'min_value') {
          const formatted = window.formatCLP?.(value);
          value = formatted || '';
        }
        el.textContent = value || '-';
        el.dataset.value = value || '';
      });
      
      // Adjuntar selección actual de auto/taller si ya elegidos
      const autoSelect = document.getElementById('select-auto');
      const workshopSelect = document.getElementById('select-workshop');
      if (autoSelect && autoSelect.value) {
        this.capturedData.auto_id = autoSelect.value;
      }
      if (workshopSelect && workshopSelect.value) {
        this.capturedData.taller_id = workshopSelect.value;
      }
      this.updateContextSummary(true);
      
      this.dataPanel.style.display = 'block';
      // En pantallas móviles, al ocultar el botón principal queda mucho espacio.
      // Desplazamos suavemente el panel de datos hacia la parte visible.
      try {
        this.dataPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } catch (_) {}
      this.btnConfirmData.style.display = 'inline-block';
      this.announceCapturedData();
      this.showDataFeedback(this.capturedData);
    }

    editField(element, fieldName) {
      if (this.state !== ESTADOS.SHOWING_DATA) return;
      
      bitacora('Editing field:', fieldName);
      
      const currentValue = element.textContent;
      element.setAttribute('contenteditable', 'true');
      element.focus();
      
      // Seleccionar todo el texto
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      
      const saveEdit = () => {
        element.setAttribute('contenteditable', 'false');
        const newValue = element.textContent.trim();
        element.dataset.value = newValue;
        this.capturedData[fieldName] = newValue;
        bitacora('Field updated:', fieldName, '=', newValue);
      };
      
      element.addEventListener('blur', saveEdit, { once: true });
      element.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          element.blur();
        }
      }, { once: true });
    }

    async confirmData() {
      bitacora('Confirming data:', this.capturedData);
      
      // Validar que se hayan seleccionado auto y taller
      const autoSelect = document.getElementById('select-auto');
      const workshopSelect = document.getElementById('select-workshop');
      
      if (!autoSelect.value) {
        alert('Por favor selecciona un Auto');
        autoSelect.focus();
        return;
      }
      
      if (!workshopSelect.value) {
        alert('Por favor selecciona un Taller');
        workshopSelect.focus();
        return;
      }
      
      this.setState(ESTADOS.CONFIRMING);
      this.showStatusMessage('Guardado...', 'info');
      
      // Determinar precios capturados (con respaldo solo si faltan)
      const extractedMax = this.normalizePriceValue(
        this.capturedData.valor ??
        this.capturedData.precio ??
        this.capturedData.max_value
      );
      const extractedMin = this.normalizePriceValue(
        this.capturedData.min_value ??
        this.capturedData.minValue ??
        this.capturedData.ultimo_precio ??
        this.capturedData.minPrice
      );
      const maxValue = extractedMax ?? VALORES_RESPALDO.max;
      const minValue = extractedMin ?? extractedMax ?? VALORES_RESPALDO.min;

      // Preparar datos para enviar (SOLO los campos del modelo Part)
      const formData = new FormData();
      formData.append('name', this.capturedData.parte || '');
      formData.append('details', this.capturedData.detalles || '');
      formData.append('max_value', maxValue);
      formData.append('min_value', minValue);
      formData.append('auto', autoSelect.value);
      formData.append('workshop', workshopSelect.value);
      formData.append('ajax', 'true');
      
      bitacora('Sending data to:', AJUSTES.saveEndpoint);
      
      try {
        const response = await fetch(AJUSTES.saveEndpoint, {
          method: 'POST',
          body: formData,
          headers: this.buildAuthHeaders(),
          credentials: 'same-origin'
        });
        
        bitacora('Save response:', response.status, 'redirected=', response.redirected);

        const contentType = response.headers.get('content-type') || '';

        // Si el backend devolvió HTML (por ejemplo, login) en vez de JSON
        if (response.redirected || (response.ok && !contentType.includes('application/json'))) {
          const text = await response.text();
          console.error('Unexpected non-JSON response when saving part', {
            status: response.status,
            redirected: response.redirected,
            bodySnippet: text.slice(0, 200)
          });
          alert('No se pudo guardar la pieza. Es probable que la sesión esté cerrada. Inicia sesión nuevamente y vuelve a intentar.');
          this.setState(ESTADOS.SHOWING_DATA);
          return;
        }
        
        if (response.ok) {
          const data = await response.json();
          bitacora('Part saved:', data);
          
          this.showStatusMessage('Guardado...', 'success');
          this.triggerCardPulse('confirm');
          
          await this.printBarcode(data);
          
          await this.startPhotoWorkflow(data);
        } else {
          let errorPayload = {};
          try {
            errorPayload = await response.json();
          } catch (_e) {
            const txt = await response.text();
            console.error('Non-JSON error response when saving part:', txt.slice(0, 200));
          }
          console.error('Error saving part:', errorPayload);
          alert('Error al guardar la pieza: ' + (errorPayload.error || JSON.stringify(errorPayload.errors || 'Error desconocido')));
          this.setState(ESTADOS.SHOWING_DATA);
        }
      } catch (error) {
        console.error('Error saving part:', error);
        alert('Error al guardar la pieza. Intenta de nuevo.');
        this.setState(ESTADOS.SHOWING_DATA);
      }
    }
    
    async printBarcode(partData) {
      bitacora('Attempting to print barcode for part:', partData.part_id);
      
      if (!partData.print_url) {
        bitacora('No print URL provided, skipping print');
        return;
      }

      if (!this.printerManager || typeof this.printerManager.printLabel !== 'function') {
        console.warn('printerManager no disponible, no se puede imprimir');
        return;
      }

      const isConnected = typeof this.printerManager.isConnected === 'function'
        ? this.printerManager.isConnected()
        : this.printerConnected;

      if (!isConnected) {
        bitacora('Printer not connected at print time');
        if (this.printerWasConnected && !this.printerAlertDismissed) {
          const decision = await this.promptPrinterReconnect('La impresora se desconectó. Conéctala para imprimir la etiqueta.');
          if (decision === 'connect') {
            return this.printBarcode(partData);
          }
        }
        return;
      }
      
      this.showStatusMessage('Imprimiendo...', 'info');
      
      try {
        await this.sendToPrinter(partData.print_url);
      } catch (error) {
        console.error('Error printing:', error);
        if (this.printerWasConnected && !this.printerAlertDismissed) {
          const retryDecision = await this.promptPrinterReconnect('Ocurrió un error al imprimir. Reconecta la impresora para intentarlo de nuevo.');
          if (retryDecision === 'connect') {
            return this.printBarcode(partData);
          }
        }
      }
    }
    
    async connectPrinter() {
      bitacora('Connecting to Bluetooth printer via printerManager...');
      if (!this.printerManager || typeof this.printerManager.connect !== 'function') {
        throw new Error('Administrador de impresora no disponible');
      }
      const result = await this.printerManager.connect();
      this.printerConnected = true;
      this.printerWasConnected = true;
      return result;
    }
    
    async sendToPrinter(printUrl) {
      bitacora('Sending to printer:', printUrl);
      if (!this.printerManager || typeof this.printerManager.printLabel !== 'function') {
        throw new Error('Administrador de impresora no disponible');
      }
      await this.printerManager.printLabel(printUrl);
      bitacora('Print completed successfully');
    }
    
    showStatusMessage(message, type = 'info') {
      // Actualizar el estado visual
      this.statusEl.textContent = message;
      this.statusEl.className = 'status-badge visually-hidden';
      
      if (type === 'success') {
        this.statusEl.classList.add('badge-success');
      } else if (type === 'info') {
        this.statusEl.classList.add('badge-info');
      } else {
        this.statusEl.classList.add('badge-secondary');
      }
    }
    
    sleep(ms) {
      return new Promise(resolve => setTimeout(resolve, ms));
    }

    async startPhotoWorkflow(partData) {
      if (!this.capturePhotosEnabled) {
        this.showStatusMessage('Listo', 'success');
        await this.sleep(800);
        this.returnToListening();
        return;
      }
      this.pendingPhotoPartId = partData?.part_id || null;
      this.pendingPhotoData = partData || null;
      if (!this.photoOverlay || !this.pendingPhotoPartId) {
        this.showStatusMessage('Listo', 'success');
        await this.sleep(800);
        this.returnToListening();
        return;
      }
      this.setState(ESTADOS.WAITING_PHOTOS);
      this.showStatusMessage('Esperando fotos', 'info');
      this.syncPhotoViewportUnit();
      document.body.classList.add('photo-overlay-open');
      this.photoOverlay.hidden = false;
      this.clearCapturedPhotos();
      this.renderCapturedPhotos();
      if (this.btnTakePhoto) {
        this.btnTakePhoto.disabled = true;
      }
      try {
        await this.ensurePhotoStream({ fromUserGesture: false, silent: true });
      } catch (error) {
        console.warn('No se pudo iniciar la cámara automáticamente', error);
        this.showStatusMessage('Pulsa “Activar cámara” y acepta el permiso para continuar.', 'info');
      }
    }

    async ensurePhotoStream(options = {}) {
      const { fromUserGesture = false, silent = false } = options;
      if (this.photoStream || !navigator.mediaDevices?.getUserMedia) {
        if (this.btnTakePhoto && this.photoStream) {
          this.btnTakePhoto.disabled = false;
        }
        return;
      }
      try {
        this.photoStream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' }
          },
          audio: false
        });
        if (this.photoVideo) {
          this.photoVideo.srcObject = this.photoStream;
          try {
            await this.photoVideo.play();
          } catch (_) {}
        }
        if (this.btnTakePhoto) {
          this.btnTakePhoto.disabled = false;
        }
      } catch (error) {
        if (error && (error.name === 'NotAllowedError' || error.name === 'SecurityError')) {
          if (fromUserGesture) {
            alert('No se pudo acceder a la cámara. Revisa los permisos del navegador e inténtalo nuevamente.');
          } else if (!silent) {
            this.showStatusMessage('No se pudo iniciar la cámara. Pulsa “Activar cámara”.', 'warning');
          }
        } else if (!silent) {
          alert('No se pudo acceder a la cámara. Puedes omitir las fotos.');
        }
        throw error;
      }
    }

    capturePhotoFrame() {
      if (this.state !== ESTADOS.WAITING_PHOTOS) return;
      if (!this.photoVideo || !this.photoCanvas) return;
      if (!this.photoVideo.videoWidth) {
        alert('La cámara aún se está iniciando, intenta de nuevo.');
        return;
      }
      const bw = this.photoVideo.videoWidth;
      const bh = this.photoVideo.videoHeight;
      const lado = Math.min(bw, bh);
      const sx = (bw - lado) / 2;
      const sy = (bh - lado) / 2;
      const canvasSize = 1080;
      this.photoCanvas.width = canvasSize;
      this.photoCanvas.height = canvasSize;
      const ctx = this.photoCanvas.getContext('2d');
      ctx.drawImage(this.photoVideo, sx, sy, lado, lado, 0, 0, canvasSize, canvasSize);
      this.photoCanvas.toBlob((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        this.capturedPhotos.push({ blob, url });
        this.renderCapturedPhotos();
      }, 'image/jpeg', 0.85);
    }

    renderCapturedPhotos() {
      if (!this.photoThumbs) return;
      if (!this.capturedPhotos.length) {
        this.photoThumbs.innerHTML = '<div class="photo-carousel-empty text-muted">Sin fotos capturadas.</div>';
      } else {
        const frag = document.createDocumentFragment();
        this.capturedPhotos.forEach((photo, index) => {
          const thumb = document.createElement('div');
          thumb.className = 'capture-thumb';
          thumb.style.backgroundImage = `url(${photo.url})`;
          const removeBtn = document.createElement('button');
          removeBtn.type = 'button';
          removeBtn.className = 'btn btn-sm btn-dark capture-thumb-remove';
          removeBtn.innerHTML = '<i class="fas fa-times"></i>';
          removeBtn.setAttribute('aria-label', 'Eliminar foto');
          removeBtn.addEventListener('click', () => this.removeCapturedPhoto(index));
          thumb.appendChild(removeBtn);
          frag.appendChild(thumb);
        });
        this.photoThumbs.innerHTML = '';
        this.photoThumbs.appendChild(frag);
      }
      if (this.photoCountLabel) {
        this.photoCountLabel.textContent = String(this.capturedPhotos.length);
      }
    }

    removeCapturedPhoto(index) {
      if (index < 0 || index >= this.capturedPhotos.length) return;
      const photo = this.capturedPhotos[index];
      if (photo?.url) {
        URL.revokeObjectURL(photo.url);
      }
      this.capturedPhotos.splice(index, 1);
      this.renderCapturedPhotos();
    }

    clearCapturedPhotos() {
      if (this.capturedPhotos.length) {
        this.capturedPhotos.forEach((photo) => {
          if (photo?.url) {
            URL.revokeObjectURL(photo.url);
          }
        });
      }
      this.capturedPhotos = [];
      if (this.photoThumbs) {
        this.photoThumbs.innerHTML = '<div class="photo-carousel-empty text-muted">Sin fotos capturadas.</div>';
      }
      if (this.photoCountLabel) {
        this.photoCountLabel.textContent = '0';
      }
    }

    skipPhotoWorkflow() {
      if (!this.photoOverlay || this.photoOverlay.hidden || this.photoUploadInProgress) {
        return;
      }
      if (confirm('¿Deseas omitir la carga de fotos para esta pieza?')) {
        this.finishPhotoWorkflow(false);
      }
    }

    async uploadCapturedPhotos() {
      if (!this.pendingPhotoPartId) {
        this.finishPhotoWorkflow(false);
        return;
      }
      if (this.photoUploadInProgress) {
        return;
      }
      if (!this.capturedPhotos.length) {
        alert('No hay fotos capturadas. Toma al menos una o elige Omitir.');
        return;
      }
      this.setPhotoUploadState(true);
      try {
        const formData = new FormData();
        this.capturedPhotos.forEach((photo, index) => {
          formData.append('photos', photo.blob, `foto_${index + 1}.jpg`);
        });
        formData.append('source', 'handsfree');
        const response = await fetch(`/parts/${this.pendingPhotoPartId}/photos/upload/`, {
          method: 'POST',
          body: formData,
          headers: this.buildAuthHeaders(),
          credentials: 'same-origin'
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.success) {
          throw new Error(payload?.error || 'No se pudieron subir las fotos');
        }
        document.dispatchEvent(new CustomEvent('parts:photos-updated', {
          detail: { partId: this.pendingPhotoPartId }
        }));
        this.showStatusMessage('Fotos registradas', 'success');
        await this.sleep(600);
        this.finishPhotoWorkflow(true);
      } catch (error) {
        console.error('Error subiendo fotos', error);
        alert(error?.message || 'No se pudieron subir las fotos. Inténtalo nuevamente.');
      } finally {
        this.setPhotoUploadState(false);
      }
    }

    setPhotoUploadState(isUploading) {
      this.photoUploadInProgress = isUploading;
      if (this.btnUploadPhotos) {
        this.btnUploadPhotos.disabled = isUploading;
        this.btnUploadPhotos.innerHTML = isUploading
          ? '<i class="fas fa-spinner fa-spin"></i> Subiendo...'
          : '<i class="fas fa-cloud-upload-alt"></i> Subir fotos';
      }
      if (this.btnSkipPhotos) {
        this.btnSkipPhotos.disabled = isUploading;
      }
      if (this.btnTakePhoto) {
        this.btnTakePhoto.disabled = isUploading;
      }
    }

    async finishPhotoWorkflow(didUpload) {
      this.closePhotoOverlay();
      this.pendingPhotoPartId = null;
      this.pendingPhotoData = null;
      this.clearCapturedPhotos();
      if (didUpload) {
        this.showStatusMessage('Listo', 'success');
      } else {
        this.showStatusMessage('Fotos omitidas', 'info');
      }
      await this.sleep(600);
      this.returnToListening();
    }

    closePhotoOverlay() {
      if (this.photoOverlay) {
        this.photoOverlay.hidden = true;
      }
      document.body.classList.remove('photo-overlay-open');
      if (this.photoVideo) {
        this.photoVideo.srcObject = null;
      }
      if (this.photoStream) {
        this.photoStream.getTracks().forEach(track => track.stop());
        this.photoStream = null;
      }
    }
    
    returnToListening() {
      bitacora('Returning to listening for new "Iniciar ingreso" command');
      if (this.puenteVoz) {
        this.puenteVoz.cancelCapture();
      }
      this.closePhotoOverlay();
      this.pendingPhotoPartId = null;
      this.pendingPhotoData = null;
      this.clearCapturedPhotos();
      this.cancelSpeechAnnouncement();
      this.dataPanel.style.display = 'none';
      this.btnConfirmData.style.display = 'none';
      this.capturedData = null;
      this.toggleReviewMode(false);
      this.setState(ESTADOS.LISTENING_INIT);
      this.showStatusMessage('Esperando comando: Diga "Iniciar"', 'info');
      this.resetCommandFeedback({ preserve: true });
      this.resetDataFeedback();
    }

    reset() {
      bitacora('Resetting system');
      if (this.puenteVoz) {
        this.puenteVoz.cancelCapture();
      }
      this.closePhotoOverlay();
      this.clearCapturedPhotos();
      this.pendingPhotoPartId = null;
      this.pendingPhotoData = null;
      this.cancelSpeechAnnouncement();
      this.capturedData = null;
      this.dataPanel.style.display = 'none';
      this.btnConfirmData.style.display = 'none';
      this.successAnimation.style.display = 'none';
      this.toggleReviewMode(false);
      this.setState(ESTADOS.INACTIVE);
      this.resetCommandFeedback({ preserve: false });
      this.resetDataFeedback();
    }

    setState(newState) {
      bitacora('State change:', this.state, '->', newState);
      this.state = newState;
      this.updateUI();
    }

    updateUI() {
      const btn = this.btnHandsFree;
      const statusTexts = {
        [ESTADOS.INACTIVE]: { status: 'Inactivo', commandLabel: 'INICIAR', btnText: 'Iniciar Manos Libres', btnIcon: 'fa-microphone' },
        [ESTADOS.LISTENING_INIT]: { status: 'Escuchando', commandLabel: 'INICIAR', btnText: 'Detener Manos Libres', btnIcon: 'fa-stop' },
        [ESTADOS.RECORDING]: { status: 'Grabando', commandLabel: 'DETENER', btnText: 'Detener Manos Libres', btnIcon: 'fa-stop' },
        [ESTADOS.PROCESSING]: { status: 'Procesando...', commandFallback: 'PROCESANDO', btnText: 'Procesando...', btnIcon: 'fa-spinner fa-spin' },
        [ESTADOS.SHOWING_DATA]: { status: 'Datos capturados', commandLabel: 'CONFIRMAR', btnText: 'Cancelar', btnIcon: 'fa-times' },
        [ESTADOS.CONFIRMING]: { status: 'Guardando...', commandFallback: 'GUARDANDO', btnText: 'Guardado...', btnIcon: 'fa-spinner fa-spin' },
        [ESTADOS.WAITING_PHOTOS]: { status: 'Esperando fotos', commandFallback: 'CÁMARA ACTIVA', btnText: 'Cámara activa', btnIcon: 'fa-camera' },
        [ESTADOS.SUCCESS]: { status: '¡Éxito!', commandFallback: 'GUARDADO', btnText: '¡Éxito!', btnIcon: 'fa-check' }
      };
      
      const config = statusTexts[this.state];
      
      // Actualizar estado y comando esperado
      if (this.statusEl) {
        this.statusEl.textContent = config.status;
      }
      if (this.commandEl) {
        if (config.commandLabel) {
          this.commandEl.textContent = `ESPERANDO COMANDO: "${config.commandLabel}"`;
        } else if (config.commandFallback) {
          this.commandEl.textContent = config.commandFallback;
        } else {
          this.commandEl.textContent = '-';
        }
      }
      
      // Actualizar clases de badge
      if (this.statusEl) {
        this.statusEl.className = 'status-badge visually-hidden';
      }
      if (this.commandEl) {
        this.commandEl.className = 'command-badge';
        if (config.commandLabel) {
          this.commandEl.classList.add('badge-info');
        } else {
          this.commandEl.classList.add('badge-secondary');
        }
      }
      
      // Actualizar botón principal según sesión activa
      btn.dataset.state = this.state;
      
      // Si la sesión está activa, el botón funciona como stop, pero muestra "Escuchando..." al esperar "Iniciar ingreso"
      if (this.sesionActiva && this.state !== ESTADOS.INACTIVE) {
        if (this.state === ESTADOS.LISTENING_INIT) {
          btn.innerHTML = `
            <i class="fas fa-microphone mb-2"></i>
            <div class="btn-text">
              Escuchando...
              <small class="d-block text-uppercase mt-1 hf-text-xxs">Tocar para detener</small>
            </div>`;
        } else {
          btn.innerHTML = `<i class="fas fa-stop mb-2"></i><div class="btn-text">Detener Manos Libres</div>`;
        }
        btn.disabled = false;
      } else {
        btn.innerHTML = `<i class="fas ${config.btnIcon} mb-2"></i><div class="btn-text">${config.btnText}</div>`;
        
        // Verificar si hay taller y auto seleccionados
        const autoSelect = document.getElementById('select-auto');
        const workshopSelect = document.getElementById('select-workshop');
        const hasVehicleSelected = autoSelect?.value && workshopSelect?.value;
        
        // Deshabilitar en estados de procesamiento O si no hay vehículo seleccionado
        btn.disabled = (
          this.state === ESTADOS.PROCESSING || 
          this.state === ESTADOS.CONFIRMING ||
          this.state === ESTADOS.WAITING_PHOTOS ||
          (this.state === ESTADOS.INACTIVE && !hasVehicleSelected)
        );
        
        // Actualizar texto si está deshabilitado por falta de selección
        if (this.state === ESTADOS.INACTIVE && !hasVehicleSelected) {
          this.statusEl.textContent = 'Seleccione Taller y Auto';
          this.commandEl.textContent = 'Completa la selección inicial para continuar';
        }
      }
      
      // Cambiar texto del botón cuando está escuchando en sesión activa
      if (this.sesionActiva && this.state === ESTADOS.LISTENING_INIT) {
        this.statusEl.textContent = 'Escuchando...';
        this.commandEl.textContent = 'Esperando comando: Diga "Iniciar"';
      }
    }

    updateTranscription(text) {
      if (!text) return;
      const timestamp = new Date().toLocaleTimeString();
      this.transcriptionText.innerHTML += `<div>[${timestamp}] ${text}</div>`;
      this.transcriptionLog.style.display = 'block';
    }

    getCSRFToken() {
      // Buscar token en múltiples lugares
      let token = document.querySelector('[name=csrfmiddlewaretoken]')?.value;
      if (!token) {
        token = document.querySelector('input[name="csrfmiddlewaretoken"]')?.value;
      }
      if (!token) {
        // Buscar en cookies
        const cookies = document.cookie.split(';');
        for (let cookie of cookies) {
          const [name, value] = cookie.trim().split('=');
          if (name === 'csrftoken') {
            token = value;
            break;
          }
        }
      }
      bitacora('CSRF Token:', token ? 'Found' : 'NOT FOUND');
      return token || '';
    }

    buildAuthHeaders(extraHeaders) {
      const headers = Object.assign(
        { 'X-Requested-With': 'XMLHttpRequest' },
        extraHeaders || {}
      );
      const token = this.getCSRFToken();
      if (token) {
        headers['X-CSRFToken'] = token;
      }
      return headers;
    }

    // Ingreso manual
    showManualEntry() {
      const modal = new bootstrap.Modal(document.getElementById('manualEntryModal'));
      modal.show();
    }

    // Selección de vehículo
    showVehicleSelect() {
      const modal = new bootstrap.Modal(document.getElementById('vehicleSelectModal'));
      modal.show();
    }

    confirmVehicleSelection() {
      const modalAutoSelect = document.getElementById('modal-auto-select');
      const modalWorkshopSelect = document.getElementById('modal-workshop-select');
      const autoSelect = document.getElementById('select-auto');
      const workshopSelect = document.getElementById('select-workshop');
      
      // Validar que ambos selectores tengan valor
      if (!modalWorkshopSelect.value) {
        alert('Por favor seleccione un Taller');
        modalWorkshopSelect.focus();
        return;
      }
      
      if (!modalAutoSelect.value) {
        alert('Por favor seleccione un Auto');
        modalAutoSelect.focus();
        return;
      }
      
      // Copiar valores a los selects principales
      autoSelect.value = modalAutoSelect.value;
      workshopSelect.value = modalWorkshopSelect.value;
      
      // NO guardar en localStorage para forzar selección en cada recarga
      
      // Cerrar modal
      const modalElement = document.getElementById('vehicleSelectModal');
      const modal = bootstrap.Modal.getInstance(modalElement);
      const activeElement = document.activeElement;
      if (modalElement && activeElement && modalElement.contains(activeElement)) {
        activeElement.blur();
      }
      if (modal) {
        modal.hide();
      }
      const focusTarget = this.btnHandsFree || document.querySelector('[data-focus-default]');
      if (focusTarget) {
        window.requestAnimationFrame(() => focusTarget.focus());
      }
      
      // Actualizar UI para habilitar el botón de manos libres
      const wantsPhotos = this.modalCapturePhotosSwitch ? this.modalCapturePhotosSwitch.checked : this.capturePhotosEnabled;
      this.updatePhotoPreference(wantsPhotos);
      this.updateContextSummary(false);
      this.setElementVisibility(this.commandBox, false);
      this.updateUI();
      
      bitacora('Taller y vehículo seleccionados. Listo para iniciar ingesta por voz.');
    }

    applyManualEntry() {
      const form = document.getElementById('manual-form');
      if (!form) return;
      const formData = new FormData(form);
      const name = (formData.get('name') || '').trim().toUpperCase();
      if (!name){
        alert('Ingresa el nombre de la pieza.');
        return;
      }
      const details = (formData.get('details') || '').trim();
      const maxValue = formData.get('max_value') || '';
      const minValue = formData.get('min_value') || '';
      const autoId = (formData.get('auto') || '').trim();
      const workshopId = (formData.get('workshop') || '').trim();
      if (!autoId || !workshopId){
        alert('Selecciona el auto y taller para continuar.');
        return;
      }
      const autoSelect = document.getElementById('select-auto');
      const workshopSelect = document.getElementById('select-workshop');
      if (autoSelect) autoSelect.value = autoId;
      if (workshopSelect) workshopSelect.value = workshopId;
      this.capturedData = {
        parte: name,
        catalog_name: name,
        position: '',
        detalles: details,
        valor: maxValue,
        min_value: minValue
      };
      const modal = bootstrap.Modal.getInstance(document.getElementById('manualEntryModal'));
      if (modal){
        modal.hide();
      }
      form.reset();
      this.updateContextSummary(false);
      this.showData();
    }
  }

  let activeInstance = null;
  let mountScheduled = false;

  function destroyActiveInstance() {
    if (activeInstance && typeof activeInstance.stopSession === 'function') {
      try {
        activeInstance.stopSession();
      } catch (err) {
        console.warn('[HandsFree] Error al detener sesión antes de desmontar', err);
      }
    }
    activeInstance = null;
  }

  function mountHandsFreeCard() {
    const card = document.getElementById('hands-free-card');
    if (!card) {
      destroyActiveInstance();
      return;
    }
    if (card.dataset.hfMounted === '1') {
      return;
    }
    card.dataset.hfMounted = '1';
    activeInstance = new HandsFreeSystem();
  }

  function ensureBootstrapAndMount() {
    mountScheduled = false;
    if (typeof bootstrap === 'undefined') {
      if (!mountScheduled) {
        mountScheduled = true;
        setTimeout(scheduleMount, 80);
      }
      return;
    }
    mountHandsFreeCard();
  }

  function scheduleMount() {
    if (mountScheduled) {
      return;
    }
    mountScheduled = true;
    requestAnimationFrame(ensureBootstrapAndMount);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scheduleMount);
  } else {
    scheduleMount();
  }

  document.addEventListener('page:ready', scheduleMount);
  document.addEventListener('turbo:frame-load', scheduleMount);
  window.addEventListener('pagehide', destroyActiveInstance);

})();
