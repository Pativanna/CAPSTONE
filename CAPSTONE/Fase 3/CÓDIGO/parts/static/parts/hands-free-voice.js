/**
 * Sistema de Manos Libres con 3 Fases
 * Fase 1: Escucha comando "iniciar"
 * Fase 2: Grabación hasta comando "detener"
 * Fase 3: Confirmación con comando "confirmar"
 */

(function() {
  'use strict';

  const MODO_DEBUG = true;
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
    SUCCESS: 'success'
  };

  // Comandos esperados por fase
  // Configuración
  const AJUSTES = {
    voiceEndpoint: '/parts/upload/',
    saveEndpoint: '/parts/add/'
  };

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
      if (data.type === 'command' && typeof this.options.onCommand === 'function') {
        bitacora('WS command recibido:', data);
        this.options.onCommand(data.command, data);
        return;
      }
      if (data.type === 'diag' && typeof data.rms === 'number') {
        this.emitLevel(data.rms);
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
      this.updateUI();
      this.updateAudioLevel(0);
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
      this.btnSaveManual = document.getElementById('btn-save-manual');
      this.btnConfirmVehicle = document.getElementById('btn-confirm-vehicle');
      
      this.statusEl = document.getElementById('current-status');
      this.commandEl = document.getElementById('expected-command');
      this.commandBox = document.getElementById('command-box');
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

      if (this.confirmHint) {
        this.confirmHint.dataset.defaultDisplay = 'flex';
      }
      if (this.contextSummary) {
        this.contextSummary.dataset.defaultDisplay = 'block';
      }
      if (this.commandBox) {
        this.commandBox.dataset.defaultDisplay = 'block';
      }
      
      this.dataFields = {
        parte: document.getElementById('data-parte'),
        valor: document.getElementById('data-valor'),
        min_value: document.getElementById('data-min-value'),
        detalles: document.getElementById('data-detalles')
      };

      [this.audioMeterWrapper, this.mainButtonContainer, this.btnSelectVehicle, this.btnManualEntry, this.confirmHint, this.contextSummary, this.commandBox].forEach(el => this.rememberDefaultDisplay(el));

      if (this.inlineCancelBtn && !this.inlineCancelBtn.__HFBound) {
        this.inlineCancelBtn.__HFBound = true;
        this.inlineCancelBtn.addEventListener('click', () => this.cancelVoiceCapture());
      }

      if (this.btnSelectVehicle) {
        this.btnSelectVehicle.disabled = true;
        this.btnSelectVehicle.title = 'Para cambiar el vehículo recarga la página';
      }
    }

    initEventListeners() {
      this.btnHandsFree.addEventListener('click', () => this.handleMainButton());
      this.btnManualEntry.addEventListener('click', () => this.showManualEntry());
      this.btnSelectVehicle.addEventListener('click', () => this.showVehicleSelect());
      this.btnConfirmVehicle.addEventListener('click', () => this.confirmVehicleSelection());
      this.btnConfirmData.addEventListener('click', () => this.confirmData());
      this.btnSaveManual.addEventListener('click', () => this.saveManualEntry());

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

    updateContextSummary(showInPanel) {
      if (!this.contextSummary) return;
      const autoSelect = document.getElementById('select-auto');
      const workshopSelect = document.getElementById('select-workshop');
      const autoLabel = autoSelect && autoSelect.value ? autoSelect.selectedOptions[0]?.text?.trim() : '';
      const workshopLabel = workshopSelect && workshopSelect.value ? workshopSelect.selectedOptions[0]?.text?.trim() : '';
      if (this.summaryAuto) this.summaryAuto.textContent = autoLabel || 'Sin seleccionar';
      if (this.summaryTaller) this.summaryTaller.textContent = workshopLabel || 'Sin seleccionar';
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
        onCommand: (command, payload) => this.handleVoiceCommand(command, payload),
        onLevel: (level) => this.updateAudioLevel(level),
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
                  <div id="printer-modal-error" class="text-danger small" style="min-height:1rem;"></div>
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

    beginVoiceCapture() {
      if (!this.puenteVoz || !this.sesionActiva || this.state === ESTADOS.RECORDING) {
        return;
      }
      this.puenteVoz.startCapture();
      this.setState(ESTADOS.RECORDING);
      this.showStatusMessage('Grabando', 'info');
    }

    async finalizeVoiceCapture(payload) {
      if (!this.puenteVoz || this.state !== ESTADOS.RECORDING) {
        return;
      }
      this.setState(ESTADOS.PROCESSING);
      this.showStatusMessage('Procesando...', 'info');
      try {
        const audioBlob = await this.puenteVoz.stopCapture(true);
        await this.processAudio(audioBlob);
      } catch (error) {
        console.error('Error finalizando captura:', error);
        alert('No se pudo procesar el audio. Intenta nuevamente.');
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
          headers: {
            'X-CSRFToken': this.getCSRFToken()
          }
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
          headers: {
            'X-CSRFToken': this.getCSRFToken()
          }
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
          
          // Mostrar "Guardado..." por 1 segundo
          this.showStatusMessage('Guardado...', 'success');
          this.triggerCardPulse('confirm');
          await this.sleep(1000);
          
          // Intentar imprimir
          await this.printBarcode(data);
          
          // Mostrar "Listo" por 1 segundo
          this.showStatusMessage('Listo', 'success');
          await this.sleep(1000);
          
          // Volver al ciclo
          this.returnToListening();
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
    
    returnToListening() {
      bitacora('Returning to listening for new "iniciar" command');
      if (this.puenteVoz) {
        this.puenteVoz.cancelCapture();
      }
      this.cancelSpeechAnnouncement();
      this.dataPanel.style.display = 'none';
      this.btnConfirmData.style.display = 'none';
      this.capturedData = null;
      this.toggleReviewMode(false);
      this.setState(ESTADOS.LISTENING_INIT);
      this.showStatusMessage('Esperando comando: Diga "Iniciar"', 'info');
    }

    reset() {
      bitacora('Resetting system');
      if (this.puenteVoz) {
        this.puenteVoz.cancelCapture();
      }
      this.cancelSpeechAnnouncement();
      this.capturedData = null;
      this.dataPanel.style.display = 'none';
      this.btnConfirmData.style.display = 'none';
      this.successAnimation.style.display = 'none';
      this.toggleReviewMode(false);
      this.setState(ESTADOS.INACTIVE);
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
      
      // Si la sesión está activa, el botón funciona como stop, pero muestra "Escuchando..." al esperar "iniciar"
      if (this.sesionActiva && this.state !== ESTADOS.INACTIVE) {
        if (this.state === ESTADOS.LISTENING_INIT) {
          btn.innerHTML = `
            <i class="fas fa-microphone mb-2"></i>
            <div class="btn-text">
              Escuchando...
              <small class="d-block text-uppercase mt-1" style="font-size:0.65rem;">Tocar para detener</small>
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
      const modal = bootstrap.Modal.getInstance(document.getElementById('vehicleSelectModal'));
      if (modal) {
        modal.hide();
      }
      
      // Actualizar UI para habilitar el botón de manos libres
      this.updateContextSummary(false);
      this.setElementVisibility(this.commandBox, false);
      this.updateUI();
      
      bitacora('Taller y vehículo seleccionados. Listo para iniciar ingesta por voz.');
    }

    async saveManualEntry() {
      const form = document.getElementById('manual-form');
      const formData = new FormData(form);
      formData.append('ajax', 'true');
      
      try {
        const response = await fetch(AJUSTES.saveEndpoint, {
          method: 'POST',
          body: formData
        });
        
        const contentType = response.headers.get('content-type') || '';

        if (response.redirected || (response.ok && !contentType.includes('application/json'))) {
          const text = await response.text();
          console.error('Unexpected non-JSON response when saving manual entry', {
            status: response.status,
            redirected: response.redirected,
            bodySnippet: text.slice(0, 200)
          });
          alert('No se pudo guardar la pieza (modo manual). Es probable que la sesión esté cerrada. Inicia sesión nuevamente y vuelve a intentar.');
          return;
        }
        
        if (response.ok) {
          const data = await response.json();
          console.log('Manual part saved:', data);
          alert('Pieza guardada exitosamente');
          bootstrap.Modal.getInstance(document.getElementById('manualEntryModal')).hide();
          form.reset();
        } else {
          let errorPayload = {};
          try {
            errorPayload = await response.json();
          } catch (_e) {
            const txt = await response.text();
            console.error('Non-JSON error response when saving manual part:', txt.slice(0, 200));
          }
          alert('Error: ' + (errorPayload.error || 'Error desconocido'));
        }
      } catch (error) {
        console.error('Error saving manual entry:', error);
        alert('Error al guardar la pieza');
      }
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
