/**
 * Voice Coordinator - Gestión centralizada de recursos de audio
 * 
 * PROBLEMA ORIGINAL:
 * - Múltiples botones (manual, vosk, webrtc) sin coordinación
 * - No se detienen mutuamente → doble captura simultánea
 * - Recursos (AudioContext, MediaStream, WebSocket) no se liberan
 * - UI desincronizada entre botones
 * 
 * SOLUCIÓN:
 * - Único punto de verdad para el estado de captura
 * - Detención automática del modo previo antes de activar otro
 * - Liberación garantizada de TODOS los recursos
 * - Sincronización de UI para todos los botones
 */

(function(){
    'use strict';
    
    const LOG_PREFIJO = '[CoordinadorVoz]';
    
    // Estado global único
    const estadoGlobal = {
        mode: 'IDLE',  // IDLE | MANUAL | VOSK | WEBRTC
        capturing: false,
        resources: {
            audioContext: null,
            mediaStream: null,
            webSocket: null,
            intervals: [],
            timeouts: [],
            mediaRecorder: null,
            workletNode: null,
            scriptProcessor: null,
            peerConnection: null,
            dataChannel: null
        }
    };
    
    /**
     * Detiene COMPLETAMENTE el modo activo y libera todos los recursos
     */
    async function detenerModoActual(motivo = 'switching_mode') {
        console.log(LOG_PREFIJO, `Deteniendo modo ${estadoGlobal.mode}`, {motivo});

        const modoAnterior = estadoGlobal.mode;
        
        // 1. Detener captura según el modo activo
        try {
            switch(modoAnterior) {
                case 'MANUAL':
                    await detenerModoManual();
                    break;
                case 'VOSK':
                    await detenerModoVosk();
                    break;
                case 'WEBRTC':
                    await detenerModoWebRTC();
                    break;
            }
        } catch(e) {
            console.error(LOG_PREFIJO, 'Error deteniendo modo específico:', e);
        }
        
        // 2. Liberación AGRESIVA de todos los recursos (independiente del modo)
        await liberarRecursos();
        
        // 3. Actualizar estado
        estadoGlobal.mode = 'IDLE';
        estadoGlobal.capturing = false;
        
        // 4. Actualizar UI de todos los botones
        actualizarBotones();

        console.log(LOG_PREFIJO, 'Modo detenido y recursos liberados');
    }
    
    /**
     * Libera TODOS los recursos de audio/red sin excepciones
     */
    async function liberarRecursos() {
        console.log(LOG_PREFIJO, 'Liberando todos los recursos...');

        const r = estadoGlobal.resources;
        
        // Detener MediaRecorder
        if (r.mediaRecorder) {
            try {
                if (r.mediaRecorder.estadoGlobal === 'recording') {
                    r.mediaRecorder.stop();
                }
                if (r.mediaRecorder.stream) {
                    r.mediaRecorder.stream.getTracks().forEach(track => track.stop());
                }
            } catch(e) { console.warn(LOG_PREFIJO, 'Error deteniendo MediaRecorder:', e); }
            r.mediaRecorder = null;
        }
        
        // Cerrar WebSocket
        if (r.webSocket) {
            try {
                if (r.webSocket.readyState === WebSocket.OPEN || r.webSocket.readyState === WebSocket.CONNECTING) {
                    r.webSocket.close();
                }
            } catch(e) { console.warn(LOG_PREFIJO, 'Error cerrando WebSocket:', e); }
            r.webSocket = null;
        }
        
        // Desconectar nodos de audio
        if (r.workletNode) {
            try { r.workletNode.disconnect(); } catch(e) {}
            r.workletNode = null;
        }
        
        if (r.scriptProcessor) {
            try { r.scriptProcessor.disconnect(); } catch(e) {}
            r.scriptProcessor = null;
        }
        
        // Cerrar PeerConnection (WebRTC)
        if (r.dataChannel) {
            try { r.dataChannel.close(); } catch(e) {}
            r.dataChannel = null;
        }
        
        if (r.peerConnection) {
            try { r.peerConnection.close(); } catch(e) {}
            r.peerConnection = null;
        }
        
        // Cerrar AudioContext
        if (r.audioContext) {
            try {
                if (r.audioContext.estadoGlobal !== 'closed') {
                    await r.audioContext.close();
                }
            } catch(e) { console.warn(LOG_PREFIJO, 'Error cerrando AudioContext:', e); }
            r.audioContext = null;
        }
        
        // Detener MediaStream
        if (r.mediaStream) {
            try {
                r.mediaStream.getTracks().forEach(track => {
                    track.stop();
                    console.log(LOG_PREFIJO, 'Track detenido:', track.kind, track.label);
                });
            } catch(e) { console.warn(LOG_PREFIJO, 'Error deteniendo MediaStream:', e); }
            r.mediaStream = null;
        }
        
        // Limpiar intervalos
        r.intervals.forEach(id => {
            try { clearInterval(id); } catch(e) {}
        });
        r.intervals = [];
        
        // Limpiar timeouts
        r.timeouts.forEach(id => {
            try { clearTimeout(id); } catch(e) {}
        });
        r.timeouts = [];
        
        console.log(LOG_PREFIJO, ' Todos los recursos liberados');
    }
    
    /**
     * Detiene modo manual (recorder.js)
     */
    async function detenerModoManual() {
        // Disparar evento para que recorder.js maneje su cierre
        document.dispatchEvent(new CustomEvent('stopRecording'));
        
        // Forzar detención del MediaRecorder si lo hay
        if (estadoGlobal.resources.mediaRecorder) {
            try {
                if (estadoGlobal.resources.mediaRecorder.estadoGlobal === 'recording') {
                    estadoGlobal.resources.mediaRecorder.stop();
                }
            } catch(e) {}
        }
    }
    
    /**
     * Detiene modo Vosk (voice-vosk.js)
     */
    async function detenerModoVosk() {
        console.log(LOG_PREFIJO, 'Deteniendo modo VOSK...');
        
        // Resetear variable global ANTES de invocar stop
        if (typeof window.isActive !== 'undefined') {
            window.isActive = false;
        }
        
        // Si el archivo voice-vosk.js expuso su función de stop
        if (typeof window.stopVoskAudio === 'function') {
            try {
                window.stopVoskAudio();
            } catch(e) {
                console.warn(LOG_PREFIJO, 'Error invocando stopVoskAudio:', e);
            }
        }
        
        // Forzar cierre de WebSocket si está registrado
        if (estadoGlobal.resources.webSocket) {
            try {
                if (estadoGlobal.resources.webSocket.readyState === WebSocket.OPEN || 
                    estadoGlobal.resources.webSocket.readyState === WebSocket.CONNECTING) {
                    estadoGlobal.resources.webSocket.close();
                }
            } catch(e) {}
        }
        
        // Resetear variables globales de voice-vosk.js si existen
        if (typeof window.isCapturingDescription !== 'undefined') {
            window.isCapturingDescription = false;
        }
        
        console.log(LOG_PREFIJO, ' Modo VOSK detenido');
    }
    
    /**
     * Detiene modo WebRTC
     */
    async function detenerModoWebRTC() {
        console.log(LOG_PREFIJO, 'Deteniendo modo WEBRTC...');
        
        // Intentar detener WebRTCHybrid primero
        if (window.WebRTCHybrid && typeof window.WebRTCHybrid.detener === 'function') {
            try {
                await window.WebRTCHybrid.detener();
            } catch(e) {
                console.warn(LOG_PREFIJO, 'Error invocando WebRTCHybrid.detener():', e);
            }
        }
        // Fallback a WebRTCEnhanced
        else if (window.WebRTCEnhanced && typeof window.WebRTCEnhanced.detener === 'function') {
            try {
                await window.WebRTCEnhanced.detener();
            } catch(e) {
                console.warn(LOG_PREFIJO, 'Error invocando WebRTCEnhanced.detener():', e);
            }
        }
        
        // Restaurar botón circular de grabación y tarjeta de manos libres
        const circularButtonContainer = document.getElementById('voice-circular-button-container');
        const handsFreeCard = document.getElementById('hands-free-card');
        
        if (circularButtonContainer) {
            circularButtonContainer.style.display = 'block';
        }
        if (handsFreeCard) {
            handsFreeCard.style.display = 'block';
        }
        
        // Forzar cierre de PeerConnection si está registrado
        if (estadoGlobal.resources.peerConnection) {
            try {
                estadoGlobal.resources.peerConnection.close();
            } catch(e) {}
        }
        
        // Detener monitor de voz si estaba activo
        if (typeof window.stopVozAuto === 'function') {
            try {
                window.stopVozAuto();
            } catch(e) {}
        }
        
        console.log(LOG_PREFIJO, ' Modo WEBRTC detenido');
    }
    
    /**
     * Inicia modo manual
     */
    async function activarModoManual() {
        await detenerModoActual('manual_start');
        
        console.log(LOG_PREFIJO, 'Iniciando modo MANUAL');
        estadoGlobal.mode = 'MANUAL';
        estadoGlobal.capturing = true;
        
        // Disparar evento para que recorder.js maneje el inicio
        document.dispatchEvent(new CustomEvent('startRecording'));
        
        actualizarBotones();
    }
    
    /**
     * Inicia modo Vosk
     */
    async function activarModoVosk() {
        await detenerModoActual('vosk_start');
        
        console.log(LOG_PREFIJO, 'Iniciando modo VOSK');
        estadoGlobal.mode = 'VOSK';
        
        // Invocar initializeVoskAudio directamente en lugar de toggleHandsFreeMode
        if (typeof window.initializeVoskAudio === 'function') {
            try {
                // Marcar como activo ANTES de iniciar
                if (typeof window.isActive !== 'undefined') {
                    window.isActive = true;
                }
                
                await window.initializeVoskAudio();
                estadoGlobal.capturing = true;
                
                // Actualizar UI manualmente ya que no usamos toggle
                const button = document.getElementById('hands-free-btn');
                const indicator = document.getElementById('hands-free-indicator');
                
                if (button) {
                    button.innerHTML = '<i class="fas fa-stop me-2"></i><span class="btn-text">Desactivar Manos Libres</span>';
                    button.classList.remove('btn-primary');
                    button.classList.add('btn-danger');
                    button.setAttribute('aria-pressed', 'true');
                }
                
                if (indicator) {
                    indicator.style.display = 'block';
                }
                
                if (typeof window.updateIndicator === 'function') {
                    window.updateIndicator('active', 'ESCUCHANDO', 'Modo manos libres activo');
                }
                
            } catch(e) {
                console.error(LOG_PREFIJO, 'Error iniciando Vosk:', e);
                estadoGlobal.mode = 'IDLE';
                if (typeof window.isActive !== 'undefined') {
                    window.isActive = false;
                }
            }
        } else {
            console.error(LOG_PREFIJO, 'initializeVoskAudio no disponible');
            estadoGlobal.mode = 'IDLE';
        }
        
        actualizarBotones();
    }
    
    /**
     * Inicia modo WebRTC Enhanced (Estilo DJ + Métricas reales)
     */
    async function activarModoWebRTC() {
        await detenerModoActual('webrtc_start');
        
        console.log(LOG_PREFIJO, 'Iniciando modo WEBRTC');
        estadoGlobal.mode = 'WEBRTC';
        
        // Ocultar botón circular de grabación y tarjeta de manos libres cuando se activa WebRTC
        const circularButtonContainer = document.getElementById('voice-circular-button-container');
        const handsFreeCard = document.getElementById('hands-free-card');
        
        if (circularButtonContainer) {
            circularButtonContainer.style.display = 'none';
        }
        if (handsFreeCard) {
            handsFreeCard.style.display = 'none';
        }
        
        // Intentar WebRTCHybrid primero (más nuevo)
        if (window.WebRTCHybrid && typeof window.WebRTCHybrid.iniciar === 'function') {
            try {
                await window.WebRTCHybrid.iniciar();
                estadoGlobal.capturing = true;
                console.log(LOG_PREFIJO, ' Modo WEBRTC Hybrid iniciado');
            } catch(e) {
                console.error(LOG_PREFIJO, 'Error iniciando WebRTC Hybrid:', e);
                estadoGlobal.mode = 'IDLE';
                // Restaurar elementos si falla
                if (circularButtonContainer) {
                    circularButtonContainer.style.display = 'block';
                }
                if (handsFreeCard) {
                    handsFreeCard.style.display = 'block';
                }
            }
        }
        // Fallback a WebRTCEnhanced si Hybrid no está disponible
        else if (window.WebRTCEnhanced && typeof window.WebRTCEnhanced.iniciar === 'function') {
            try {
                await window.WebRTCEnhanced.iniciar();
                estadoGlobal.capturing = true;
                console.log(LOG_PREFIJO, ' Modo WEBRTC Enhanced iniciado (VU meter + comandos)');
            } catch(e) {
                console.error(LOG_PREFIJO, 'Error iniciando WebRTC Enhanced:', e);
                estadoGlobal.mode = 'IDLE';
                // Restaurar elementos si falla
                if (circularButtonContainer) {
                    circularButtonContainer.style.display = 'block';
                }
                if (handsFreeCard) {
                    handsFreeCard.style.display = 'block';
                }
            }
        } else {
            console.error(LOG_PREFIJO, 'WebRTC no disponible - verifica que voice-webrtc-hybrid.js o voice-webrtc-enhanced.js estén cargados');
            estadoGlobal.mode = 'IDLE';
            // Restaurar elementos si no hay WebRTC
            if (circularButtonContainer) {
                circularButtonContainer.style.display = 'block';
            }
            if (handsFreeCard) {
                handsFreeCard.style.display = 'block';
            }
        }
        
        actualizarBotones();
    }
    /**
     * Actualiza UI de TODOS los botones para reflejar estado actual
     */
    function actualizarBotones() {
        updateManualButton();
        updateVoskButton();
        updateWebRTCButton();
        updateWebRTCToggleButton(); // Nuevo: actualizar botón de tarjeta
    }
    
    function updateWebRTCToggleButton() {
        const btn = document.getElementById('webrtc-toggle-btn');
        if (!btn) return;
        
        const icon = btn.querySelector('i');
        const label = btn.querySelector('span');
        
        if (estadoGlobal.mode === 'WEBRTC') {
            btn.classList.remove('btn-primary');
            btn.classList.add('btn-danger');
            if (icon) icon.className = 'fas fa-stop me-2';
            if (label) label.textContent = 'Detener WebRTC';
            btn.setAttribute('aria-pressed', 'true');
            btn.disabled = false;
        } else {
            btn.classList.remove('btn-danger');
            btn.classList.add('btn-primary');
            if (icon) icon.className = 'fas fa-headset me-2';
            if (label) label.textContent = 'Iniciar WebRTC';
            btn.setAttribute('aria-pressed', 'false');
            btn.disabled = (estadoGlobal.mode !== 'IDLE');
        }
    }
    
    function updateManualButton() {
        const btn = document.getElementById('record-voice-btn');
        if (!btn) return;
        
        const icon = btn.querySelector('i');
        const label = btn.querySelector('.btn-text');
        
        if (estadoGlobal.mode === 'MANUAL' && estadoGlobal.capturing) {
            btn.classList.add('recording');
            btn.classList.remove('loading');
            if (icon) icon.className = 'fas fa-stop';
            if (label) label.textContent = 'Detener';
            btn.disabled = false;
            btn.setAttribute('aria-pressed', 'true');
        } else {
            btn.classList.remove('recording', 'loading');
            if (icon) icon.className = 'fas fa-microphone';
            if (label) label.textContent = 'Grabar';
            btn.disabled = (estadoGlobal.mode !== 'IDLE');
            btn.setAttribute('aria-pressed', 'false');
        }
    }
    
    function updateVoskButton() {
        const btn = document.getElementById('hands-free-btn');
        if (!btn) return;
        
        if (estadoGlobal.mode === 'VOSK') {
            btn.innerHTML = '<i class="fas fa-stop me-2"></i><span class="btn-text">Desactivar Manos Libres</span>';
            btn.classList.remove('btn-primary');
            btn.classList.add('btn-danger');
            btn.setAttribute('aria-pressed', 'true');
            btn.disabled = false;
        } else {
            btn.innerHTML = '<i class="fas fa-microphone me-2"></i><span class="btn-text">Activar Manos Libres</span>';
            btn.classList.remove('btn-danger');
            btn.classList.add('btn-primary');
            btn.setAttribute('aria-pressed', 'false');
            btn.disabled = (estadoGlobal.mode !== 'IDLE');
        }
    }
    
    function updateWebRTCButton() {
        const btn = document.getElementById('hands-free-webrtc-btn');
        if (!btn) return;
        
        const icon = btn.querySelector('i');
        const label = btn.querySelector('span');
        
        if (estadoGlobal.mode === 'WEBRTC') {
            btn.classList.remove('btn-outline-success', 'btn-warning');
            btn.classList.add('btn-danger');
            if (icon) icon.className = 'fas fa-stop me-2';
            if (label) label.textContent = 'Detener WebRTC';
            btn.setAttribute('aria-pressed', 'true');
            btn.disabled = false;
        } else {
            btn.classList.remove('btn-danger', 'btn-warning');
            btn.classList.add('btn-outline-success');
            if (icon) icon.className = 'fas fa-headset me-2';
            if (label) label.textContent = 'Usar WebRTC (calidad)';
            btn.setAttribute('aria-pressed', 'false');
            btn.disabled = (estadoGlobal.mode !== 'IDLE');
        }
    }
    
    /**
     * Intercepta clicks en botones y coordina arranque/parada
     */
    function setupButtonHandlers() {
        // Botón manual
        const manualBtn = document.getElementById('record-voice-btn');
        if (manualBtn && !manualBtn.__coordinated) {
            manualBtn.addEventListener('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                
                if (estadoGlobal.mode === 'MANUAL') {
                    await detenerModoActual('manual_stop');
                } else if (estadoGlobal.mode === 'IDLE') {
                    await activarModoManual();
                }
            });
            manualBtn.__coordinated = true;
        }
        
        // Botón Vosk
        const voskBtn = document.getElementById('hands-free-btn');
        if (voskBtn && !voskBtn.__coordinated) {
            voskBtn.addEventListener('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                
                if (estadoGlobal.mode === 'VOSK') {
                    await detenerModoActual('vosk_stop');
                } else if (estadoGlobal.mode === 'IDLE') {
                    await activarModoVosk();
                }
            });
            voskBtn.__coordinated = true;
        }
        
        // Botón WebRTC (dentro de Manos Libres)
        const webrtcBtn = document.getElementById('hands-free-webrtc-btn');
        if (webrtcBtn && !webrtcBtn.__coordinated) {
            webrtcBtn.addEventListener('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                
                // DECISIÓN BASADA EN MODO DE TRANSCRIPCIÓN
                // AMBOS MODOS usan WebRTC Híbrido (comandos Vosk + visualización)
                // Diferencia: LOCAL = Vosk transcribe, NUBE = OpenAI Whisper transcribe (DualAudioRecorder)
                const transcriptionMode = window.getTranscriptionMode ? window.getTranscriptionMode() : 'local';
                console.log(LOG_PREFIJO, `Botón WebRTC presionado, modo transcripción: ${transcriptionMode}`);
                
                if (estadoGlobal.mode !== 'IDLE') {
                    // Ya hay algo activo, detener
                    await detenerModoActual('webrtc_stop');
                } else {
                    // Ambos modos usan WebRTC, la diferencia está en voice-vosk.js
                    console.log(LOG_PREFIJO, `Iniciando WebRTC Híbrido con transcripción: ${transcriptionMode}`);
                    await activarModoWebRTC();
                }
            });
            webrtcBtn.__coordinated = true;
        }
        
        // Botón WebRTC Toggle (tarjeta independiente)
        const webrtcToggleBtn = document.getElementById('webrtc-toggle-btn');
        if (webrtcToggleBtn && !webrtcToggleBtn.__coordinated) {
            webrtcToggleBtn.addEventListener('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                
                if (estadoGlobal.mode === 'WEBRTC') {
                    await detenerModoActual('webrtc_stop');
                } else if (estadoGlobal.mode === 'IDLE') {
                    await activarModoWebRTC();
                }
            });
            webrtcToggleBtn.__coordinated = true;
        }
    }
    
    /**
     * API pública
     */
    window.VoiceCoordinator = {
        getState: () => ({ ...estadoGlobal }),
        stopAll: () => detenerModoActual('user_requested'),
        startManual: activarModoManual,
        startVosk: activarModoVosk,
        startWebRTC: activarModoWebRTC,
        
        // Registrar recursos externos para que el coordinator los rastree
        registerResource(type, resource) {
            switch(type) {
                case 'audioContext':
                    estadoGlobal.resources.audioContext = resource;
                    break;
                case 'mediaStream':
                    estadoGlobal.resources.mediaStream = resource;
                    break;
                case 'webSocket':
                    estadoGlobal.resources.webSocket = resource;
                    break;
                case 'mediaRecorder':
                    estadoGlobal.resources.mediaRecorder = resource;
                    break;
                case 'workletNode':
                    estadoGlobal.resources.workletNode = resource;
                    break;
                case 'scriptProcessor':
                    estadoGlobal.resources.scriptProcessor = resource;
                    break;
                case 'peerConnection':
                    estadoGlobal.resources.peerConnection = resource;
                    break;
                case 'dataChannel':
                    estadoGlobal.resources.dataChannel = resource;
                    break;
                case 'interval':
                    estadoGlobal.resources.intervals.push(resource);
                    break;
                case 'timeout':
                    estadoGlobal.resources.timeouts.push(resource);
                    break;
            }
        }
    };
    
    // Inicializar en evento page:ready
    document.addEventListener('page:ready', setupButtonHandlers);
    if (document.readyState !== 'loading') {
        setupButtonHandlers();
    }
    
    // Limpieza al cerrar la página
    window.addEventListener('beforeunload', () => {
        liberarRecursos();
    });
    
    console.log(LOG_PREFIJO, 'Coordinador inicializado');
})();
