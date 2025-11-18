/**
 * WebRTC Híbrido: Captura con WebRTC (AEC/NS/AGC) + Transporte por WebSocket
 * 
 * Ventajas:
 * -  Cancelación de eco (echoCancellation)
 * -  Supresión de ruido (noiseSuppression)
 * -  Control automático de ganancia (autoGainControl)
 * -  Sin problemas de ICE/NAT (usa WebSocket)
 * -  Funciona detrás de cualquier proxy
 */

(function() {
  'use strict';

  const LOG_PREFIJO = 'WebRTC-Hybrid';
  const PROTO_WS = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const WS_URL = `${PROTO_WS}//${window.location.host}/ws/webrtc-audio/`;
  
  // Sistema de logging inteligente (usa Logger si está disponible, sino console nativo)
  const log = (...args) => window.Logger ? window.Logger.log(LOG_PREFIJO, ...args) : console.log(`[${LOG_PREFIJO}]`, ...args);
  const warn = (...args) => window.Logger ? window.Logger.warn(LOG_PREFIJO, ...args) : console.warn(`[${LOG_PREFIJO}]`, ...args);
  const error = (...args) => window.Logger ? window.Logger.error(LOG_PREFIJO, ...args) : console.error(`[${LOG_PREFIJO}]`, ...args);
  
  let socketAudio = null;
  let flujoMedios = null;
  let contextoAudio = null;
  let nodoFuente = null;
  let nodoWorklet = null;
  let activo = false;
  let pingInterval = null;  // Heartbeat para mantener conexión viva
  
  // MÉTRICAS (para actualización en vivo)
  let flushCount = 0;
  let totalBytesSent = 0;
  let silenceCount = 0;
  let lastAudioTime = Date.now();

  // UI elements
  const ui = {
    btn: document.getElementById('webrtc-toggle-btn'),
    finalBtn: document.getElementById('webrtc-final-btn'),
    card: document.getElementById('webrtc-card'),
    estado: document.getElementById('webrtc-estado'),
    detalle: document.getElementById('webrtc-detalle'),
    transcript: document.getElementById('webrtc-transcript'),
    currentPartialDiv: null  // Para manejar transcripciones parciales
  };

  function setEstado(txt) { if (ui.estado) ui.estado.textContent = txt; }
  function setDetalle(txt) { if (ui.detalle) ui.detalle.textContent = txt; }
  function showCard() { if (ui.card) ui.card.style.display = 'block'; }
  function hideCard() { if (ui.card) ui.card.style.display = 'none'; }
  
  // Variable global para mantener el contexto de comandos
  let contextoComandosActual = 'inicial';
  
  function actualizarComandosDisponibles(contexto) {
    const comandosDiv = document.getElementById('webrtc-comandos-disponibles');
    const comandosLista = document.getElementById('webrtc-comandos-lista');
    const estadoTexto = document.getElementById('webrtc-estado');
    
    if (!comandosDiv || !comandosLista) return;
    
    // Guardar el contexto actual
    contextoComandosActual = contexto;
    log('Actualizando a contexto:', contexto);
    
    let comandosHTML = '';
    let estadoMensaje = '';
    
    switch(contexto) {
      case 'inicial':
        // Solo mostrar "iniciar" al inicio
        comandosHTML = '<span class="badge bg-primary">iniciar</span>';
        estadoMensaje = 'Esperando siguiente comando';
        break;
      case 'proceso_activo':
        // Durante la grabación: mostrar detener
        comandosHTML = '<span class="badge bg-danger">detener</span>';
        estadoMensaje = 'Grabando - di los datos de la pieza';
        break;
      case 'esperando_confirmacion':
        // Después de finalizar: mostrar confirmar/cancelar/repetir
        comandosHTML = `
          <span class="badge bg-success">confirmar</span>
          <span class="badge bg-warning">cancelar</span>
          <span class="badge bg-info">repetir</span>
        `;
        estadoMensaje = 'Datos extraídos - confirma o corrige';
        break;
      case 'inactivo':
      default:
        comandosHTML = '';
        estadoMensaje = 'Sistema inactivo';
        break;
    }
    
    comandosLista.innerHTML = comandosHTML;
    comandosDiv.style.display = comandosHTML ? 'block' : 'none';
    
    // Actualizar estado si existe el elemento
    if (estadoTexto && estadoMensaje) {
      estadoTexto.textContent = estadoMensaje;
    }
  }
  
  function ocultarComandosDisponibles() {
    const comandosDiv = document.getElementById('webrtc-comandos-disponibles');
    if (comandosDiv) comandosDiv.style.display = 'none';
  }
  
  function hideCircularButton() {
    const circularBtn = document.getElementById('voice-circular-button-container');
    if (circularBtn) circularBtn.style.display = 'none';
  }
  
  function showCircularButton() {
    const circularBtn = document.getElementById('voice-circular-button-container');
    if (circularBtn) circularBtn.style.display = 'block';
  }
  
  function hideHandsFreeCard() {
    const handsFreeCard = document.getElementById('hands-free-card');
    if (handsFreeCard) handsFreeCard.style.display = 'none';
  }
  
  function showHandsFreeCard() {
    const handsFreeCard = document.getElementById('hands-free-card');
    if (handsFreeCard) handsFreeCard.style.display = 'block';
  }
  
  function mostrarResultados(transcripcion, jsonData) {
    // Ocultar sección de transcripción en vivo y métricas
    const transcriptSection = document.getElementById('webrtc-transcript-section');
    const metricsRows = document.querySelectorAll('#webrtc-card .row.g-2.mb-3, #webrtc-card .row.g-3.mb-3');
    
    if (transcriptSection) transcriptSection.style.display = 'none';
    metricsRows.forEach(row => row.style.display = 'none');
    
    // Mostrar sección de resultados
    const resultsSection = document.getElementById('webrtc-results-section');
    const finalTranscript = document.getElementById('webrtc-final-transcript');
    const jsonResult = document.getElementById('webrtc-json-result');
    
    if (resultsSection) resultsSection.style.display = 'block';
    if (finalTranscript) finalTranscript.textContent = transcripcion || 'Sin transcripción';
    if (jsonResult) jsonResult.textContent = JSON.stringify(jsonData, null, 2);
  }
  
  function ocultarResultados() {
    log( ' Ocultando resultados y restaurando vista de métricas...');
    
    // Mostrar sección de transcripción en vivo y métricas
    const transcriptSection = document.getElementById('webrtc-transcript-section');
    const metricsRows = document.querySelectorAll('#webrtc-card .row.g-2.mb-3, #webrtc-card .row.g-3.mb-3');
    
    if (transcriptSection) {
      transcriptSection.style.display = 'block';
      log( ' Sección de transcripción visible');
    }
    metricsRows.forEach(row => row.style.display = 'flex');
    log( ` ${metricsRows.length} filas de métricas visibles`);
    
    // Ocultar sección de resultados
    const resultsSection = document.getElementById('webrtc-results-section');
    if (resultsSection) {
      resultsSection.style.display = 'none';
      log( ' Sección de resultados oculta');
    }
    
    // Limpiar contenido de resultados para evitar que persistan
    const finalTranscript = document.getElementById('webrtc-final-transcript');
    const jsonResult = document.getElementById('webrtc-json-result');
    if (finalTranscript) {
      finalTranscript.textContent = '';
      log( ' Contenido de transcripción final limpiado');
    }
    if (jsonResult) {
      jsonResult.textContent = '';
      log( ' Contenido JSON limpiado');
    }
  }

  async function iniciar() {
    if (activo) {
      warn( 'Ya está activo, ignorando');
      return;
    }
    
    // RESETEAR MÉTRICAS
    flushCount = 0;
    totalBytesSent = 0;
    silenceCount = 0;
    lastAudioTime = Date.now();
    
    activo = true;

    try {
      log( ' Iniciando WebRTC Híbrido...');
      setEstado('INICIANDO...');
      setDetalle('Solicitando micrófono');
      showCard();
      hideCircularButton(); // Ocultar botón circular
      hideHandsFreeCard(); // Ocultar tarjeta de manos libres
      ocultarResultados(); // Asegurar que resultados estén ocultos

      // 1. Capturar audio con WebRTC (AEC/NS/AGC habilitado)
      log( ' Solicitando getUserMedia con AEC/NS/AGC...');
      flujoMedios = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 48000,
          echoCancellation: true,       //  Cancelación de eco
          noiseSuppression: true,        //  Supresión de ruido
          autoGainControl: true,         //  Control automático de ganancia
          latency: 0.01                  // Baja latencia
        },
        video: false
      });

      log( ' MediaStream obtenido con AEC/NS/AGC');
      
      // Registrar en coordinador
      if (window.VoiceCoordinator) {
        window.VoiceCoordinator.registerResource('flujoMedios', flujoMedios);
      }

      // Inicializar DualAudioRecorder si está en modo NUBE (híbrido)
      if (window.isHybridMode && window.isHybridMode() && window.DualAudioRecorder) {
        log( ' [NUBE] Inicializando DualAudioRecorder para transcripción OpenAI...');
        window.dualRecorder = new window.DualAudioRecorder();
        await window.dualRecorder.initialize(flujoMedios, true); // true = modo híbrido (NUBE)
        log( ' [NUBE] DualAudioRecorder listo para capturar audio');
      } else {
        log( 'ℹ [LOCAL] Modo transcripción local - usando solo Vosk');
      }

      setDetalle('Conectando a servidor...');

      // 2. Conectar WebSocket
      log( ' Conectando WebSocket a', WS_URL);
      socketAudio = new WebSocket(WS_URL);
      
      socketAudio.onopen = () => {
        log( ' WebSocket conectado');
        setEstado('Esperando siguiente comando');
        setDetalle('Procesando audio con AEC/NS/AGC');
        actualizarComandosDisponibles('inicial'); // Mostrar solo "iniciar"
        
        // Mostrar botón de finalizar
        if (ui.finalBtn) {
          ui.finalBtn.style.display = 'inline-block';
        }
        
        // Enviar mensaje de inicio
        socketAudio.send(JSON.stringify({
          type: 'start',
          usuario_id: document.getElementById('hands-free-card')?.getAttribute('data-user-id') || ''
        }));
        
        // Iniciar heartbeat ping cada 30 segundos
        if (pingInterval) clearInterval(pingInterval);
        pingInterval = setInterval(() => {
          if (socketAudio && socketAudio.readyState === WebSocket.OPEN) {
            log( ' Enviando ping heartbeat...');
            socketAudio.send(JSON.stringify({ type: 'ping' }));
          }
        }, 30000); // Cada 30 segundos
        
        // Iniciar procesamiento de audio
        log( ' Iniciando procesamiento de audio...');
        iniciarProcesamientoAudio();
      };

      socketAudio.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          
          // Manejar pong (respuesta a ping)
          if (data.type === 'pong') {
            log( ' Pong recibido - conexión viva');
            return;
          }
          
          log( ' Mensaje recibido:', data);
          
          // NUEVO: Log detallado para comandos
          if (data.type === 'command') {
            log( ' ===== COMANDO DETECTADO =====');
            log( '   Tipo:', data.type);
            log( '   Comando:', data.command);
            log( '   Texto:', data.text);
            log( ' =============================');
          }
          
          // Mostrar transcripciones (mejor manejo de parciales vs finales)
          if (ui.transcript) {
            if (data.partial !== undefined) {
              // Transcripción parcial: actualizar línea actual
              if (data.partial.trim()) {
                if (!ui.currentPartialDiv) {
                  ui.currentPartialDiv = document.createElement('div');
                  ui.currentPartialDiv.style.opacity = '0.6';
                  ui.currentPartialDiv.style.fontStyle = 'italic';
                  ui.currentPartialDiv.style.color = '#666';
                  ui.transcript.appendChild(ui.currentPartialDiv);
                }
                ui.currentPartialDiv.textContent = ' ' + data.partial;
                ui.transcript.scrollTop = ui.transcript.scrollHeight;
              }
            } else if (data.text !== undefined || (data.type === 'result' && data.text)) {
              // Transcripción final: crear nueva línea permanente
              const texto = data.text || '';
              if (texto.trim()) {
                // Eliminar línea parcial si existe
                if (ui.currentPartialDiv) {
                  ui.currentPartialDiv.remove();
                  ui.currentPartialDiv = null;
                }
                
                const linea = document.createElement('div');
                linea.textContent = ' ' + texto;
                linea.style.opacity = '1.0';
                linea.style.fontWeight = '500';
                linea.style.color = '#2c5f2d';
                linea.style.marginBottom = '4px';
                linea.style.padding = '4px';
                linea.style.backgroundColor = '#e8f5e9';
                linea.style.borderRadius = '4px';
                ui.transcript.appendChild(linea);
                ui.transcript.scrollTop = ui.transcript.scrollHeight;
              }
            }
          }
          
          // Procesar comandos
          if (typeof window.handleVoskMessage === 'function') {
            let normalized = data;
            
            // CRÍTICO: Preservar data.type === 'command' tal cual
            if (data.type === 'command') {
              log( ' Comando detectado, pasando a handleVoskMessage:', data.command);
              normalized = data; // Pasar tal cual
            } else if (data.partial !== undefined) {
              normalized = { type: 'partial', text: data.partial };
            } else if (data.text !== undefined && !data.type) {
              normalized = { type: 'final', text: data.text };
            }
            
            // INTERCEPTAR COMANDOS PARA DUALRECORDER (modo NUBE)
            if (data.type === 'command' && window.isHybridMode && window.isHybridMode()) {
              log( ' [NUBE] Procesando comando:', data.command);
              
              if (data.command === 'iniciar_proceso' && window.dualRecorder) {
                log( ' [NUBE] Iniciando grabación de audio para OpenAI...');
                window.dualRecorder.startBufferRecording();
                actualizarComandosDisponibles('proceso_activo'); // Actualizar comandos disponibles
                // Dejar que handleVoskMessage procese el comando "iniciar_proceso" normalmente
              } else if (data.command === 'finalizar_proceso' && window.dualRecorder) {
                // Evitar doble finalización si llega dos veces el comando (WebRTC y Vosk)
                if (window.__finalizarEnCurso) {
                  warn(' Finalizar en curso, ignorando duplicado (WEBRTC)');
                  return; 
                }
                window.__finalizarEnCurso = true;
                log( ' [NUBE] Deteniendo grabación y enviando a OpenAI...');
                
                // Marcar que estamos procesando para evitar doble ejecución desde voice-vosk.js
                window.__procesandoHibrido = true;
                
                // Procesar con OpenAI de forma asíncrona
                procesarAudioHibrido().then(exitoso => {
                  window.__procesandoHibrido = false;
                  if (!exitoso) {
                    warn( ' [NUBE] OpenAI falló, activando fallback a transcripción Vosk');
                    // Ejecutar fallback: forzar procesamiento del comando con Vosk
                    window.handleVoskMessage({
                      type: 'command',
                      command: 'finalizar_proceso',
              text: 'detener'
                    });
                  } else {
                    log( ' [NUBE] Procesamiento completado exitosamente, omitiendo Vosk');
                  }
                }).catch(err => {
                  window.__procesandoHibrido = false;
                  error( ' [NUBE] Error procesando audio:', err);
                  // En caso de error, activar fallback a Vosk
                  window.handleVoskMessage({
                    type: 'command',
                    command: 'finalizar_proceso',
                    text: 'detener'
                  });
                });
                
                // NO ejecutar handleVoskMessage aquí para evitar doble procesamiento
                // El comando se procesará solo si OpenAI falla (en el fallback arriba)
                return;
              } else if (data.command === 'confirmar_datos' || data.command === 'confirmar') {
                log( ' [NUBE] Comando CONFIRMAR recibido, procesando...');
                // Este comando se debe procesar SIEMPRE, no tiene lógica especial de NUBE
                // Dejar que pase a handleVoskMessage normalmente
              } else if (data.command === 'cancelar_proceso' || data.command === 'cancelar') {
                log( ' [NUBE] Comando CANCELAR recibido');
                actualizarComandosDisponibles('inicial'); // Volver al estado inicial
              } else if (data.command === 'repetir_proceso' || data.command === 'repetir') {
                log( ' [NUBE] Comando REPETIR recibido');
                // Mantener en proceso_activo
              }
            }
            
            window.handleVoskMessage(normalized);
          }
        } catch (e) {
          warn( 'Error procesando mensaje:', e);
        }
      };

      socketAudio.onerror = (err) => {
        error( ' Error WebSocket:', err);
        setEstado('ERROR WS');
        setDetalle('Error de conexión WebSocket');
        detener();
      };

      socketAudio.onclose = () => {
        log( ' WebSocket cerrado');
        
        // Detener ping interval
        if (pingInterval) {
          clearInterval(pingInterval);
          pingInterval = null;
        }
        
        if (activo) {
          setEstado('DESCONECTADO');
          detener();
        }
      };

    } catch (error) {
      error( ' Error iniciando:', error);
      
      if (error.name === 'NotAllowedError') {
        setEstado('PERMISO DENEGADO');
        setDetalle('Debes permitir el acceso al micrófono');
      } else if (error.name === 'NotFoundError') {
        setEstado('NO HAY MICRÓFONO');
        setDetalle('No se detectó ningún micrófono');
      } else {
        setEstado('ERROR');
        setDetalle(error.message || 'Error desconocido');
      }
      
      activo = false;
      
      // Limpiar recursos parciales
      if (flujoMedios) {
        flujoMedios.getTracks().forEach(t => t.stop());
        flujoMedios = null;
      }
      if (socketAudio) {
        socketAudio.close();
        socketAudio = null;
      }
    }
  }

  async function iniciarProcesamientoAudio() {
    try {
      log( ' Creando AudioContext...');
      
      // Crear AudioContext
      contextoAudio = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: 48000,
        latencyHint: 'interactive'
      });

      log( ` AudioContext creado: sampleRate=${contextoAudio.sampleRate}, state=${contextoAudio.state}`);

      nodoFuente = contextoAudio.createMediaStreamSource(flujoMedios);
      log( ' MediaStreamSource creado');

      // Usar AudioWorklet si está disponible, sino ScriptProcessor
      if (contextoAudio.audioWorklet) {
        log( ' AudioWorklet disponible, intentando usar...');
        try {
          // Crear worklet processor inline
          const workletCode = `
            class PCMProcessor extends AudioWorkletProcessor {
              constructor() {
                super();
                this.bufferSize = 4096;
                this.buffer = new Float32Array(this.bufferSize);
                this.bufferIndex = 0;
                this.chunksSent = 0;
                
                // Factor de downsample: 48000Hz -> 16000Hz = 3:1
                this.downsampleFactor = 3;
                this.downsampleBuffer = [];
                
                console.log('[PCMProcessor] Worklet inicializado (48kHz->16kHz)');
              }

              process(inputs, outputs, parameters) {
                const input = inputs[0];
                if (!input || !input[0]) {
                  return true;
                }

                const samples = input[0]; // Canal mono a 48kHz
                
                // Downsample simple: tomar 1 de cada 3 muestras
                for (let i = 0; i < samples.length; i++) {
                  this.downsampleBuffer.push(samples[i]);
                  
                  if (this.downsampleBuffer.length >= this.downsampleFactor) {
                    // Promediar las muestras para evitar aliasing
                    const avg = this.downsampleBuffer.reduce((a, b) => a + b, 0) / this.downsampleBuffer.length;
                    this.buffer[this.bufferIndex++] = avg;
                    this.downsampleBuffer = [];
                    
                    if (this.bufferIndex >= this.bufferSize) {
                      // Convertir Float32 a Int16 PCM
                      const pcm = new Int16Array(this.bufferSize);
                      for (let j = 0; j < this.bufferSize; j++) {
                        const s = Math.max(-1, Math.min(1, this.buffer[j]));
                        pcm[j] = s < 0 ? s * 0x8000 : s * 0x7FFF;
                      }
                      
                      this.chunksSent++;
                      if (this.chunksSent % 10 === 0) {
                        console.log('[PCMProcessor] Chunks @16kHz enviados:', this.chunksSent);
                      }
                      
                      // Enviar al main thread
                      this.port.postMessage(pcm.buffer, [pcm.buffer]);
                      
                      this.buffer = new Float32Array(this.bufferSize);
                      this.bufferIndex = 0;
                    }
                  }
                }
                
                return true;
              }
            }

            registerProcessor('pcm-processor', PCMProcessor);
          `;

          const blob = new Blob([workletCode], { type: 'application/javascript' });
          const workletUrl = URL.createObjectURL(blob);
          
          log( ' Cargando módulo AudioWorklet...');
          await contextoAudio.audioWorklet.addModule(workletUrl);
          
          log( ' Módulo cargado, creando nodo...');
          nodoWorklet = new AudioWorkletNode(contextoAudio, 'pcm-processor');
          
          let chunksReceived = 0;
          nodoWorklet.port.onmessage = (event) => {
            chunksReceived++;
            if (chunksReceived % 10 === 0) {
              log( ` Chunks recibidos del worklet: ${chunksReceived}`);
            }
            
            if (socketAudio && socketAudio.readyState === WebSocket.OPEN) {
              socketAudio.send(event.data); // Enviar PCM por WebSocket
              
              // ACTUALIZAR METRICAS
              flushCount++;
              totalBytesSent += event.data.byteLength;
              lastAudioTime = Date.now();
              
              if (chunksReceived % 10 === 0) {
                log( ` Enviado al WebSocket: ${event.data.byteLength} bytes (total: ${(totalBytesSent/1024).toFixed(1)}KB)`);
              }
            } else {
              if (chunksReceived === 1) {
                warn( ' WebSocket no está abierto, no se puede enviar audio');
              }
            }
          };

          // Conectar la fuente de audio correcta al worklet
          // Corrección: usar nodoFuente (definido arriba) en lugar de variable inexistente
          nodoFuente.connect(nodoWorklet);
          // NO conectar a destination para evitar feedback
          // nodoWorklet.connect(contextoAudio.destination);
          
          log( ' AudioWorklet conectado y funcionando');
          
          // INICIAR VISUALIZACION TEMPRANO (nodoFuente puede tener múltiples conexiones)
          setTimeout(() => {
            if (activo && nodoFuente && contextoAudio) {
              log( ' Iniciando visualización desde AudioWorklet setup...');
              iniciarVisualizacion();
            }
          }, 200);
          
        } catch (e) {
          error( ' Error con AudioWorklet:', e);
          log( ' Fallback a ScriptProcessor...');
          usarScriptProcessor();
        }
      } else {
        log( ' AudioWorklet NO disponible, usando ScriptProcessor');
        usarScriptProcessor();
      }

      log( ' Procesamiento de audio iniciado con AEC/NS/AGC activo');
      setDetalle('Audio procesándose (AEC/NS/AGC activo)');
      
    } catch (error) {
      error( ' Error en procesamiento de audio:', error);
      setEstado('ERROR AUDIO');
    }
  }

  function usarScriptProcessor() {
    log( ' Creando ScriptProcessor con downsample 48kHz->16kHz...');
    const bufferSize = 4096;
    const processor = contextoAudio.createScriptProcessor(bufferSize, 1, 1);
    
    let chunksSent = 0;
    let downsampleBuffer = [];
    const downsampleFactor = 3; // 48000/16000 = 3
    
    processor.onaudioprocess = (e) => {
      chunksSent++;
      
      if (chunksSent % 10 === 0) {
        log( ` ScriptProcessor chunks: ${chunksSent}`);
      }
      
      if (socketAudio && socketAudio.readyState === WebSocket.OPEN) {
        const inputData = e.inputBuffer.getChannelData(0); // 48kHz
        
        // Downsample a 16kHz (tomar 1 de cada 3 con promedio)
        const outputSize = Math.floor(inputData.length / downsampleFactor);
        const downsampled = new Float32Array(outputSize);
        
        for (let i = 0; i < outputSize; i++) {
          const start = i * downsampleFactor;
          const avg = (inputData[start] + inputData[start + 1] + inputData[start + 2]) / 3;
          downsampled[i] = avg;
        }
        
        // Convertir Float32 a Int16 PCM
        const pcm = new Int16Array(outputSize);
        for (let i = 0; i < outputSize; i++) {
          const s = Math.max(-1, Math.min(1, downsampled[i]));
          pcm[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        
        socketAudio.send(pcm.buffer);
        
        // ACTUALIZAR MÉTRICAS
        flushCount++;
        totalBytesSent += pcm.buffer.byteLength;
        lastAudioTime = Date.now();
        
        if (chunksSent % 10 === 0) {
          log( ` Enviado ${pcm.buffer.byteLength} bytes @16kHz (total: ${(totalBytesSent/1024).toFixed(1)}KB)`);
        }
      } else {
        if (chunksSent === 1) {
          warn( ' WebSocket no está abierto en ScriptProcessor');
        }
      }
    };

    nodoFuente.connect(processor);
    processor.connect(contextoAudio.destination);
    
    log( ' ScriptProcessor conectado y funcionando con downsample');
  }

  async function detener() {
    if (!activo) return;
    activo = false;

    log( 'Deteniendo...');
    
    // Cancelar grabación del DualAudioRecorder si está activa
    if (window.dualRecorder && window.dualRecorder.isRecordingBuffer) {
      log( ' Cancelando grabación activa de DualAudioRecorder...');
      try {
        window.dualRecorder.cancelBufferRecording();
      } catch (err) {
        warn( 'Error cancelando grabación:', err);
      }
    }
    
    // Ocultar botón de finalizar
    if (ui.finalBtn) {
      ui.finalBtn.style.display = 'none';
    }
    
    // Detener ping interval
    if (pingInterval) {
      clearInterval(pingInterval);
      pingInterval = null;
    }

    // Detener worklet/processor
    if (nodoWorklet) {
      nodoWorklet.disconnect();
      nodoWorklet = null;
    }

    if (nodoFuente) {
      nodoFuente.disconnect();
      nodoFuente = null;
    }

    if (contextoAudio) {
      await contextoAudio.close();
      contextoAudio = null;
    }

    // Cerrar WebSocket
    if (socketAudio) {
      socketAudio.close();
      socketAudio = null;
    }

    // Detener MediaStream
    if (flujoMedios) {
      flujoMedios.getTracks().forEach(t => t.stop());
      flujoMedios = null;
    }

  setEstado('INACTIVO');
  setDetalle('Detenido');
  ocultarComandosDisponibles();
  contextoComandosActual = 'inactivo'; // Resetear contexto de comandos
  // Mantener visible la tarjeta para feedback; no ocultarla automáticamente
  showCard();
  showCircularButton(); // Restaurar botón circular
  showHandsFreeCard(); // Restaurar tarjeta de manos libres
    
    log( 'Detenido');
  }

  function getCookie(name) {
    const value = `; ${document.cookie}`;
    const parts = value.split(`; ${name}=`);
    if (parts.length === 2) return parts.pop().split(';').shift();
  }
  
  function solicitarResultadoFinal() {
    if (socketAudio && socketAudio.readyState === WebSocket.OPEN) {
      log( ' Solicitando resultado final a Vosk...');
      socketAudio.send(JSON.stringify({ type: 'request_final' }));
      
      // Feedback visual
      if (ui.finalBtn) {
        const originalText = ui.finalBtn.innerHTML;
        ui.finalBtn.innerHTML = '<i class="fas fa-spinner fa-spin me-1"></i>Finalizando...';
        ui.finalBtn.disabled = true;
        
        setTimeout(() => {
          ui.finalBtn.innerHTML = originalText;
          ui.finalBtn.disabled = false;
        }, 2000);
      }
    } else {
      warn( 'WebSocket no está conectado');
    }
  }

  // NO configurar listener del botón aquí - lo maneja VoiceCoordinator
  // El botón webrtc-toggle-btn está coordinado centralmente
  
  // Configurar listener del botón de finalizar
  if (ui.finalBtn) {
    ui.finalBtn.addEventListener('click', solicitarResultadoFinal);
  }
  
  // Configurar listener del botón "Nuevo Proceso"
  const nuevoProcesoBtn = document.getElementById('webrtc-nuevo-proceso');
  if (nuevoProcesoBtn) {
    nuevoProcesoBtn.addEventListener('click', () => {
      log( ' Botón "Nuevo Proceso" clickeado - Reiniciando estado...');
      
      // Ocultar resultados y mostrar métricas (esto también limpia contenido)
      ocultarResultados();
      
      // Limpiar transcripción en vivo
      if (ui.transcript) {
        ui.transcript.innerHTML = '<div class="text-muted fst-italic small">Esperando transcripción...</div>';
        log( ' Transcripción en vivo limpiada');
      }
      
      // Reiniciar comandos al estado inicial
      actualizarComandosDisponibles('inicial');
      setEstado('Esperando siguiente comando');
      log( ' Estado reiniciado a inicial');
      
      // Si voice-vosk tiene función de reinicio, llamarla
      if (typeof window.startCapture === 'function') {
        log( 'Reiniciando captura de voz automáticamente');
        setTimeout(() => {
          // Simular comando "iniciar"
          if (window.handleVoskMessage) {
            window.handleVoskMessage({
              type: 'command',
              command: 'iniciar_proceso',
              text: 'iniciar'
            });
          }
        }, 300);
      }
    });
  }

  // ========== FUNCIÓN AUXILIAR PARA MODO NUBE ==========
  
  async function procesarAudioHibrido() {
    try {
      log( ' [NUBE] Procesando audio capturado...');
      // Verificar que exista una grabación activa antes de detener
      if (!window.dualRecorder || (
          typeof window.dualRecorder.isRecording === 'function' ?
            !window.dualRecorder.isRecording() : !window.dualRecorder.isRecordingBuffer)) {
        warn(' [NUBE] No hay grabación activa para detener');
        return false;
      }
      const audioData = await window.dualRecorder.stopBufferRecording();
      
      if (!audioData || !audioData.blob || !window.sendAudioToHybridEndpoint) {
        warn( ' [NUBE] No hay audioBlob o función sendAudioToHybridEndpoint');
        return false;
      }
      
      log( ` [NUBE] Audio capturado: ${(audioData.blob.size / 1024).toFixed(2)} KB, duración: ${(audioData.duration/1000).toFixed(2)}s`);
      setEstado(' PROCESANDO CON OPENAI');
      setDetalle('⏳ Transcribiendo con Whisper...');
      
      const result = await window.sendAudioToHybridEndpoint(audioData);
      log( ' [NUBE] Resultado de OpenAI:', result);
      
      if (result && result.success && result.extracted_data) {
        // Llenar formulario con datos extraídos
        log( 'Llenando formulario con datos extraídos...');
        
        const form = document.getElementById('part-form');
        if (!form) {
          error( 'Formulario no encontrado');
          return false;
        }
        
        const data = result.extracted_data;
        
        // Mapeo backend → formulario Django
        const campos = {
          name: data.pieza || data.parte || '',
          brand: data.marca || '',
          car_model: data.modelo || '',
          year: data.año || '',
          color: data.color || '',
          location: data.ubicacion || '',
          max_value: data.precio || data.valor || '',
          details: data.observaciones || data.detalles || ''
        };
        
        let camposLlenados = 0;
        
        for (const [fieldName, value] of Object.entries(campos)) {
          if (value) {
            let input = form.querySelector(`[name="${fieldName}"]`) ||
                        form.querySelector(`#id_${fieldName}`) ||
                        document.getElementById(`id_${fieldName}`);
            
            if (input) {
              input.value = value;
              camposLlenados++;
            } else {
              warn( `Campo ${fieldName} no encontrado`);
            }
          }
        }
        
        log( `Total campos llenados: ${camposLlenados}/8`);
        
        setEstado('COMPLETADO');
        setDetalle(`${camposLlenados} campos llenados`);
        
        // Mostrar resultados en la tarjeta
        mostrarResultados(result.transcription || '', data);
        
        // ACTUALIZAR COMANDOS DISPONIBLES A ESPERANDO_CONFIRMACION
        log( ' [NUBE] Datos extraídos exitosamente, actualizando a estado esperando_confirmacion');
        actualizarComandosDisponibles('esperando_confirmacion');
        
        if (typeof window.playBeep === 'function') {
          window.playBeep('success');
        }
        
        return true;
      } else {
        warn( 'Respuesta sin datos extraídos');
        setEstado('SIN DATOS');
        setDetalle('OpenAI no pudo extraer información');
        
        // Volver a estado inicial y mostrar error
        actualizarComandosDisponibles('inicial');
        
        return false;
      }
    } catch (error) {
      error( 'Error procesando audio:', error);
      setEstado('ERROR');
      setDetalle('Procesamiento falló');
      
      // Volver a estado inicial en caso de error
      actualizarComandosDisponibles('inicial');
      
      return false;
    }
  }

  // Exportar funciones
  window.WebRTCHybrid = {
    iniciar,
    detener,
    estaActivo: () => activo,
    actualizarComandosDisponibles,  // Exportar para uso global
    mostrarResultados,               // Nueva función para mostrar resultados
    ocultarResultados,               // Nueva función para ocultar resultados
    solicitarResultadoFinal          // Exportar para capturar últimas palabras
  };

  // ========================================
  // VISUALIZACIÓN Y MÉTRICAS UI (ACTUALIZACIÓN PROFESIONAL)
  // ========================================
  
  let analyserNode = null;
  let visualizationFrameId = null;
  let lastTranscriptUpdate = Date.now();
  let lastSilenceDetection = 0;
  let wasSilent = false;
  
  function iniciarVisualizacion() {
    if (!contextoAudio || !nodoFuente) {
      warn( 'No se puede iniciar visualización: falta contexto de audio');
      warn( '  contextoAudio:', !!contextoAudio, '  nodoFuente:', !!nodoFuente);
      return;
    }
    
    try {
      log( ' Iniciando visualización de audio...');
      
      analyserNode = contextoAudio.createAnalyser();
      analyserNode.fftSize = 2048;
      analyserNode.smoothingTimeConstant = 0.3;
      nodoFuente.connect(analyserNode);
      
      log( ' AnalyserNode conectado');
      
      const dataArray = new Uint8Array(analyserNode.frequencyBinCount);
      
      const visualizar = () => {
        if (!activo || !analyserNode) {
          detenerVisualizacion();
          return;
        }
        
        try {
          analyserNode.getByteTimeDomainData(dataArray);
          
          let sum = 0;
          for (let i = 0; i < dataArray.length; i++) {
            const normalized = (dataArray[i] - 128) / 128;
            sum += normalized * normalized;
          }
          const rms = Math.sqrt(sum / dataArray.length);
          
          // Actualizar barra visual
          const rmsBar = document.getElementById('webrtc-rms-bar');
          if (rmsBar) {
            const percentage = Math.min(100, rms * 200);
            rmsBar.style.width = `${percentage}%`;
            
            if (percentage > 85) {
              rmsBar.style.background = '#dc3545'; // Rojo
            } else if (percentage > 50) {
              rmsBar.style.background = '#ffc107'; // Amarillo
            } else if (percentage > 10) {
              rmsBar.style.background = '#198754'; // Verde
            } else {
              rmsBar.style.background = '#0d6efd'; // Azul
            }
          }
          
          // Actualizar texto RMS con badge
          const rmsText = document.getElementById('webrtc-rms-text');
          if (rmsText) {
            let estadoTexto = 'Silencio';
            let badgeClass = 'bg-secondary';
            
            if (rms > 0.15) {
              estadoTexto = 'Fuerte';
              badgeClass = 'bg-danger';
            } else if (rms > 0.05) {
              estadoTexto = 'Normal';
              badgeClass = 'bg-success';
            }
            
            rmsText.textContent = `${estadoTexto}: ${rms.toFixed(3)}`;
            rmsText.className = `badge ${badgeClass} small`;
          }
          
          // DETECTAR SILENCIOS (periodos de RMS < 0.01 que duren >2 segundos)
          const ahoraMs = Date.now();
          if (rms < 0.01) {
            if (!wasSilent) {
              wasSilent = true;
              lastSilenceDetection = ahoraMs;
            } else if ((ahoraMs - lastSilenceDetection) > 2000) {
              // Silencio continuo por más de 2 segundos
              silenceCount++;
              lastSilenceDetection = ahoraMs; // Reset para no contar múltiples veces
            }
          } else {
            wasSilent = false;
          }
          
          visualizationFrameId = requestAnimationFrame(visualizar);
        } catch (e) {
          warn( 'Error en loop de visualización:', e);
          detenerVisualizacion();
        }
      };
      
      visualizar();
      log( 'Visualización iniciada');
    } catch (e) {
      error( 'Error al iniciar visualización:', e);
    }
  }
  
  function detenerVisualizacion() {
    if (visualizationFrameId) {
      cancelAnimationFrame(visualizationFrameId);
      visualizationFrameId = null;
    }
    
    if (analyserNode) {
      try {
        analyserNode.disconnect();
      } catch (e) {}
      analyserNode = null;
    }
    
    // Resetear UI
    const rmsBar = document.getElementById('webrtc-rms-bar');
    if (rmsBar) {
      rmsBar.style.width = '0%';
      rmsBar.style.background = '#0d6efd';
    }
    
    const rmsText = document.getElementById('webrtc-rms-text');
    if (rmsText) {
      rmsText.textContent = 'RMS: 0.000';
      rmsText.className = 'badge bg-secondary small';
    }
  }
  
  function actualizarMetricas() {
    const flushesEl = document.getElementById('webrtc-flushes');
    if (flushesEl) flushesEl.textContent = flushCount;
    
    const bytesEl = document.getElementById('webrtc-bytes');
    if (bytesEl) bytesEl.textContent = (totalBytesSent / 1024).toFixed(1);
    
    const silenciosEl = document.getElementById('webrtc-silencios');
    if (silenciosEl) silenciosEl.textContent = silenceCount;
  }
  
  function actualizarEstadoUI(nuevoEstado) {
    const estadoEl = document.getElementById('webrtc-estado');
    const detalleEl = document.getElementById('webrtc-detalle');
    
    if (estadoEl) {
      let html = '';
      let clase = '';
      
      switch(nuevoEstado) {
        case 'ACTIVO':
          html = '<i class="fas fa-circle text-success"></i> Esperando siguiente comando';
          clase = 'text-success fw-bold';
          // NO sobrescribir comandos - mantener el contexto actual
          // Solo actualizar a 'inicial' si el contexto actual es 'inactivo'
          if (contextoComandosActual === 'inactivo' || contextoComandosActual === '') {
            actualizarComandosDisponibles('inicial');
          }
          break;
        case 'CONECTANDO':
          html = '<i class="fas fa-circle-notch fa-spin text-primary"></i> CONECTANDO';
          clase = 'text-primary fw-bold';
          ocultarComandosDisponibles();
          break;
        case 'ERROR':
          html = '<i class="fas fa-exclamation-triangle text-danger"></i> ERROR';
          clase = 'text-danger fw-bold';
          ocultarComandosDisponibles();
          break;
        default:
          html = '<i class="fas fa-circle text-secondary"></i> INACTIVO';
          clase = 'text-secondary fw-bold';
          ocultarComandosDisponibles();
      }
      
      estadoEl.innerHTML = html;
      estadoEl.className = `fs-6 ${clase}`;
    }
    
    if (detalleEl) {
      switch(nuevoEstado) {
        case 'ACTIVO':
          detalleEl.textContent = 'Capturando audio con AEC/NS/AGC activo';
          break;
        case 'CONECTANDO':
          detalleEl.textContent = 'Estableciendo conexión WebSocket...';
          break;
        case 'ERROR':
          detalleEl.textContent = 'Error de conexión - Revisar logs';
          break;
        default:
          detalleEl.textContent = 'Sistema de captura con AEC/NS/AGC';
      }
    }
  }
  
  function actualizarTranscripcion(texto, tipo = 'partial') {
    const transcriptEl = document.getElementById('webrtc-transcript');
    if (!transcriptEl) return;
    
    const ahora = Date.now();
    
    // Throttle: actualizar máximo cada 150ms para parciales
    if (tipo === 'partial' && (ahora - lastTranscriptUpdate) < 150) {
      return;
    }
    lastTranscriptUpdate = ahora;
    
    if (texto && texto.trim()) {
      const marcaTiempo = new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const claseTipo = tipo === 'final' ? 'fw-bold' : '';
      
      // REEMPLAZAR contenido completo (no agregar infinitamente)
      transcriptEl.innerHTML = `
        <div class="text-muted small mb-1">
          <i class="fas fa-clock"></i> ${marcaTiempo} 
          ${tipo === 'final' ? '<span class="badge bg-success ms-2">FINAL</span>' : '<span class="badge bg-secondary ms-2">EN VIVO</span>'}
        </div>
        <div class="${claseTipo}">${texto}</div>
      `;
      
      // Auto-scroll si está cerca del final
      if (transcriptEl.scrollHeight - transcriptEl.scrollTop <= transcriptEl.clientHeight + 50) {
        transcriptEl.scrollTop = transcriptEl.scrollHeight;
      }
    } else {
      transcriptEl.innerHTML = '<div class="text-muted fst-italic small">Esperando transcripción...</div>';
    }
  }
  
  function limpiarTranscripcion() {
    const transcriptEl = document.getElementById('webrtc-transcript');
    if (transcriptEl) {
      transcriptEl.innerHTML = '<div class="text-muted fst-italic small">Transcripción limpiada</div>';
      setTimeout(() => {
        if (!activo) {
          transcriptEl.innerHTML = '<div class="text-muted fst-italic small">Esperando transcripción...</div>';
        }
      }, 2000);
    }
  }
  
  // ========================================
  // FUNCTION WRAPPING (NO MODIFICA ORIGINALES)
  // ========================================
  
  const iniciarOriginal = iniciar;
  iniciar = async function() {
    actualizarEstadoUI('CONECTANDO');
    await iniciarOriginal();
    
    if (activo) {
      actualizarEstadoUI('ACTIVO');
      
      setTimeout(() => {
        if (activo) iniciarVisualizacion();
      }, 500);
      
      // Actualizar métricas cada segundo
      if (window.webrtcMetricsInterval) {
        clearInterval(window.webrtcMetricsInterval);
      }
      window.webrtcMetricsInterval = setInterval(() => {
        if (activo) {
          actualizarMetricas();
          actualizarEstadoUI('ACTIVO'); // Actualizar conexión
        } else {
          clearInterval(window.webrtcMetricsInterval);
        }
      }, 1000);
    } else {
      actualizarEstadoUI('ERROR');
    }
  };
  
  const detenerOriginal = detener;
  detener = async function() {
    detenerVisualizacion();
    
    if (window.webrtcMetricsInterval) {
      clearInterval(window.webrtcMetricsInterval);
    }
    
    await detenerOriginal();
    
    actualizarEstadoUI('INACTIVO');
    actualizarMetricas(); // Última actualización
  };
  
  // Event listener para botón limpiar
  document.addEventListener('page:ready', () => {
    const clearBtn = document.getElementById('webrtc-clear-transcript');
    if (clearBtn) {
      clearBtn.addEventListener('click', limpiarTranscripcion);
    }
    
    // Inicializar estado de comandos al cargar página
    actualizarComandosDisponibles('inicial');
    log( ' Estado de comandos inicializado al cargar página');
  });
  if (document.readyState !== 'loading') {
    const clearBtn = document.getElementById('webrtc-clear-transcript');
    if (clearBtn) {
      clearBtn.addEventListener('click', limpiarTranscripcion);
    }
    actualizarComandosDisponibles('inicial');
  }
  
  // Actualizar exports
  window.WebRTCHybrid.iniciar = iniciar;
  window.WebRTCHybrid.detener = detener;
  window.WebRTCHybrid.actualizarTranscripcion = actualizarTranscripcion;
  window.WebRTCHybrid.limpiarTranscripcion = limpiarTranscripcion;
  window.WebRTCHybrid.actualizarMetricas = actualizarMetricas;
  // ========================================
  // FIN VISUALIZACIÓN Y MÉTRICAS
  // ========================================

  log( 'Módulo cargado - WebRTC con AEC/NS/AGC + visualización profesional');
})();
