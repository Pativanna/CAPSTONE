// voice_ingesta.js - Orquestador de ingesta por voz (Fases 1 y 2)
// Reconstituido desde cero para conectar backend existente con nueva UI.
// Todas las variables y comentarios en español (regla del proyecto).

(function(){
  'use strict';

  const BITACORA = (...args) => console.log('[IngestaVoz]', ...args);
  const AVISO = (...args) => console.warn('[IngestaVoz]', ...args);
  const ERROR = (...args) => console.error('[IngestaVoz]', ...args);
  const selFaseSeleccion = document.getElementById('fase-seleccion');
  const btnContinuarFaseVoz = document.getElementById('continuar-a-fase-voz');
  const interfazVoz = document.getElementById('voice-recording-interface');
  const estadoVoz = document.getElementById('estado-voz');
  const estadoVozLive = document.getElementById('voice-status-live');
  const sessionHidden = document.getElementById('session-id-voz');

  // Controles Fase 1: selección de vehículo
  const btnModeSelectAuto = document.getElementById('mode-select-auto');
  const btnModeSingle = document.getElementById('mode-single');
  const boxSelectAuto = document.getElementById('select-auto-box');
  const boxSingle = document.getElementById('single-entry-box');
  const selectorAuto = document.getElementById('auto-selector');
  const btnConfirmAuto = document.getElementById('confirm-auto');
  const btnClearSelection = document.getElementById('clear-selection');
  const currentSelection = document.getElementById('current-selection');
  const selectedDisplay = document.getElementById('selected-display');
  const btnChangeVehicle = document.getElementById('change-vehicle');
  const btnUsePrevious = document.getElementById('use-previous');
  const inputSingleModel = document.getElementById('single-model');
  const inputSingleColor = document.getElementById('single-color');
  const btnUseSingle = document.getElementById('use-single');
  const btnCancelSingle = document.getElementById('cancel-single');

  // Botones de control del ingreso por voz
  const btnIniciarSesion = document.getElementById('btn-iniciar-sesion');
  const btnIniciarProceso = document.getElementById('btn-iniciar-proceso');
  const btnFinalizarProceso = document.getElementById('btn-finalizar-proceso');
  const btnConfirmarDatos = document.getElementById('btn-confirmar-datos');
  const btnRepetirProceso = document.getElementById('btn-repetir-proceso');
  const btnCancelarProceso = document.getElementById('btn-cancelar-proceso');
  const cardDatosExtraidos = document.getElementById('extracted-data-card');
  const campoParteExtraida = document.getElementById('extracted-parte');
  const campoPosicionExtraida = document.getElementById('extracted-posicion');
  const campoValorExtraido = document.getElementById('extracted-valor');
  const campoMinExtraido = document.getElementById('extracted-min-value');
  const campoDetallesExtraidos = document.getElementById('extracted-detalles');
  const estadoDatosExtraidos = document.getElementById('extracted-data-status');

  const divParciales = document.getElementById('transcripciones-parciales');
  const txtFinal = document.getElementById('transcripcion-final');
  const formulario = document.getElementById('part-form');
  const commandFeedbackCard = document.getElementById('voice-command-feedback');
  const commandFeedbackText = document.getElementById('voice-command-feedback-text');
  const commandFeedbackDetail = document.getElementById('voice-command-feedback-detail');
  const commandFeedbackConfidence = document.getElementById('voice-command-confidence');
  const audioQualityHint = document.getElementById('audio-quality-hint');

  // Estado interno
  let idSesion = '';
  let procesoActivo = false; // Entre iniciar_proceso y finalizar_proceso
  let acumuladoCaptura = ''; // Texto acumulado dentro de ventana activa
  let ultimaActualizacionFinal = 0;
  const MAX_LENGTH_FINAL = 12000; // cortar para evitar excesos
  let seleccionVehiculo = null; // { tipo: 'auto'|'manual', id?: string|number, label: string }
  function resolveCsrfToken(){
    try {
      if (typeof window !== 'undefined' && typeof window.getCsrfToken === 'function'){
        const token = window.getCsrfToken();
        if (token) return token;
      }
    } catch(_err) {}
    const match = document.cookie.match(/csrftoken=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : '';
  }

  function secureFetch(url, options){
    const opts = Object.assign({ credentials: 'same-origin' }, options || {});
    const headers = Object.assign({ 'X-Requested-With': 'XMLHttpRequest' }, opts.headers || {});
    if (!headers['X-CSRFToken']){
      const token = resolveCsrfToken();
      if (token){
        headers['X-CSRFToken'] = token;
      }
    }
    opts.headers = headers;
    return fetch(url, opts);
  }

  function actualizarEstadoVoz(texto){
    if (estadoVoz){
      estadoVoz.textContent = texto;
    }
    if (estadoVozLive){
      estadoVozLive.textContent = texto;
    }
  }

  // Utilidades Fase 1
  function mostrar(el){
    if (!el) return;
    el.hidden = false;
    el.classList.remove('d-none');
  }
  function ocultar(el){
    if (!el) return;
    el.hidden = true;
    el.classList.add('d-none');
  }

  function formatearCLP(valor){
    if (valor === null || valor === undefined || valor === ''){
      return '--';
    }
    const numero = Number(valor);
    if (!Number.isFinite(numero)){
      return String(valor);
    }
    try {
      return new Intl.NumberFormat('es-CL', {
        style: 'currency',
        currency: 'CLP',
        minimumFractionDigits: 0,
        maximumFractionDigits: 0
      }).format(numero);
    } catch(_err){
      return numero.toLocaleString('es-CL');
    }
  }

  function actualizarEstadoDatosExtraidos(mensaje = '', variante = 'info') {
    if (!estadoDatosExtraidos) {
      return;
    }
    estadoDatosExtraidos.classList.remove('alert-info', 'alert-success', 'alert-warning', 'alert-danger', 'd-none');
    if (!mensaje) {
      estadoDatosExtraidos.classList.add('d-none');
      estadoDatosExtraidos.textContent = '';
      return;
    }
    estadoDatosExtraidos.classList.add(`alert-${variante}`);
    estadoDatosExtraidos.textContent = mensaje;
  }

  function mostrarPanelDatos() {
    if (!cardDatosExtraidos) return;
    cardDatosExtraidos.hidden = false;
    cardDatosExtraidos.classList.remove('d-none');
  }

  function limpiarDatosExtraidos(){
    if (!cardDatosExtraidos) return;
    [campoParteExtraida, campoPosicionExtraida, campoValorExtraido, campoMinExtraido, campoDetallesExtraidos].forEach((el) => {
      if (el){
        el.textContent = '--';
      }
    });
    cardDatosExtraidos.hidden = true;
    cardDatosExtraidos.classList.add('d-none');
    actualizarEstadoDatosExtraidos('');
  }

  function mostrarDatosExtraidos(campos = {}, transcript = ''){
    if (!cardDatosExtraidos) return;
    mostrarPanelDatos();
    const posicion = campos.posicion || campos.posicion_normalizada || campos.ubicacion || '';
    const detalles = campos.detalles || transcript || '';
    if (campoParteExtraida){
      const parte = (campos.parte || '--').toString();
      campoParteExtraida.textContent = parte ? parte.toUpperCase() : '--';
    }
    if (campoPosicionExtraida){
      campoPosicionExtraida.textContent = posicion || '--';
    }
    if (campoValorExtraido){
      campoValorExtraido.textContent = formatearCLP(campos.valor);
    }
    if (campoMinExtraido){
      const min = campos.min_value ?? campos.valor;
      campoMinExtraido.textContent = formatearCLP(min);
    }
    if (campoDetallesExtraidos){
      campoDetallesExtraidos.textContent = detalles || '--';
    }
    actualizarEstadoDatosExtraidos('Datos listos para confirmar.', 'success');
  }

  function mostrarErrorExtraccion(mensaje){
    if (!cardDatosExtraidos) return;
    mostrarPanelDatos();
    actualizarEstadoDatosExtraidos(mensaje || 'No se pudieron extraer datos del audio.', 'danger');
  }
  function setSeleccionActual(obj){
    seleccionVehiculo = obj;
    if (selectedDisplay){ selectedDisplay.textContent = obj?.label || ''; }
    mostrar(currentSelection);
    ocultar(boxSelectAuto);
    ocultar(boxSingle);
    try {
      localStorage.setItem('last_auto_selection', JSON.stringify(obj));
    } catch(_e) {}
  }
  function cargarSeleccionPrevia(){
    try {
      const raw = localStorage.getItem('last_auto_selection');
      if (raw){
        const obj = JSON.parse(raw);
        if (obj && btnUsePrevious){
          btnUsePrevious.classList.remove('d-none');
          btnUsePrevious.onclick = function(){
            setSeleccionActual(obj);
            ocultar(selFaseSeleccion);
            mostrar(interfazVoz);
          };
        }
      }
    } catch(_e) {}
  }

  // Listeners Fase 1
  function inicializarListenersFase1(){
    BITACORA('Inicializando listeners Fase 1');
    if (btnModeSelectAuto){
      btnModeSelectAuto.addEventListener('click', function(){
        BITACORA('Click en Seleccionar Auto');
        mostrar(boxSelectAuto);
        ocultar(boxSingle);
      }, { once: false });
    } else { AVISO('Botón mode-select-auto no encontrado'); }
    if (btnModeSingle){
      btnModeSingle.addEventListener('click', function(){
        BITACORA('Click en Ingreso Unitario');
        mostrar(boxSingle);
        ocultar(boxSelectAuto);
        if (inputSingleModel) inputSingleModel.focus();
      }, { once: false });
    }
    if (btnConfirmAuto){
      btnConfirmAuto.addEventListener('click', function(){
        if (!selectorAuto || !selectorAuto.value){
          alert('Seleccione un auto de la lista');
          return;
        }
        const opt = selectorAuto.options[selectorAuto.selectedIndex];
        setSeleccionActual({ tipo: 'auto', id: selectorAuto.value, label: opt.textContent.trim() });
        // Avanzar inmediatamente a la Fase 2 (interfaz de voz)
        ocultar(selFaseSeleccion);
        mostrar(interfazVoz);
      }, { once: false });
    }
    if (btnClearSelection){
      btnClearSelection.addEventListener('click', function(){
        if (selectorAuto) selectorAuto.value = '';
        ocultar(boxSelectAuto);
      }, { once: false });
    }
    if (btnUseSingle){
      btnUseSingle.addEventListener('click', function(){
        const modelo = (inputSingleModel?.value || '').trim();
        const color = (inputSingleColor?.value || '').trim();
        if (!modelo){ alert('Ingrese un modelo'); return; }
        const label = color ? (modelo + ' - ' + color) : modelo;
        setSeleccionActual({ tipo: 'manual', id: 'manual', label });
        ocultar(selFaseSeleccion);
        mostrar(interfazVoz);
      }, { once: false });
    }
    if (btnCancelSingle){
      btnCancelSingle.addEventListener('click', function(){
        if (inputSingleModel) inputSingleModel.value = '';
        if (inputSingleColor) inputSingleColor.value = '';
        ocultar(boxSingle);
      }, { once: false });
    }
    if (btnChangeVehicle){
      btnChangeVehicle.addEventListener('click', function(){
        ocultar(currentSelection);
        seleccionVehiculo = null;
        mostrar(boxSelectAuto);
      }, { once: false });
    }
  }

  // --- FASE 1 ---
  if (btnContinuarFaseVoz){
    btnContinuarFaseVoz.addEventListener('click', function(){
      // Validar que exista selección de taller (opcional estricta)
      const tallerSel = document.getElementById('persistent-workshop-selector');
      if (tallerSel && !tallerSel.value){
        alert('Seleccione un taller antes de continuar.');
        return;
      }
      // Opcional: advertir si no hay vehículo seleccionado
      if (!seleccionVehiculo){
        if (!confirm('No ha seleccionado un vehículo específico. ¿Desea continuar igualmente?')){
          return;
        }
      }
      ocultar(selFaseSeleccion);
      mostrar(interfazVoz);
    });
  }

  // Inicialización Fase 1: mostrar botón "usar selección anterior" si existe y bind dinámico
  function initFase1(){
    cargarSeleccionPrevia();
    inicializarListenersFase1();
  }
  if (document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', initFase1);
  } else {
    initFase1();
  }
  // Compatibilidad con Turbo / navegación dinámica
  document.addEventListener('turbo:load', initFase1);

  // --- SESIÓN DE VOZ ---
  async function iniciarSesionVoz(){
    try {
      const r = await secureFetch('/parts/voice/start-session/', { method:'POST' });
      const j = await r.json();
      if (!j.success){ throw new Error(j.error||'No se pudo iniciar sesión'); }
      idSesion = j.session_id;
      sessionHidden.value = idSesion;
      actualizarEstadoVoz('Sesión iniciada: ' + idSesion);
      btnIniciarProceso.disabled = false;
      btnIniciarSesion.disabled = true;
    BITACORA('Sesión de voz iniciada', idSesion);
      // Iniciar captura WebRTC/Vosk automáticamente
      try {
        if (window.VoiceCoordinator && typeof window.VoiceCoordinator.startWebRTC === 'function') {
          await window.VoiceCoordinator.startWebRTC();
          BITACORA('Modo WebRTC híbrido iniciado');
        } else if (typeof window.initializeVoskAudio === 'function') {
          await window.initializeVoskAudio();
          BITACORA('Modo Vosk continuo iniciado');
        }
      } catch(e){ AVISO('No se pudo iniciar modo de captura automática', e); }
    } catch(e){
      alert('Error iniciando sesión de voz: '+e.message);
    }
  }

  if (btnIniciarSesion){ btnIniciarSesion.addEventListener('click', iniciarSesionVoz); }

  // --- COMANDOS MANUALES (Botones) ---
  function enviarComando(command){
    if (!idSesion){ alert('Inicie sesión de voz primero'); return; }
    secureFetch('/parts/voice/log-command/', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({command: command, text: command})
    }).catch(()=>{});
  }

  if (btnIniciarProceso){
    btnIniciarProceso.addEventListener('click', function(){
      if (!idSesion) { alert('Inicie sesión primero'); return; }
      procesoActivo = true;
      enviarComando('iniciar_proceso');
      actualizarEstadoVoz('Ingreso activo: capture la descripción hablada.');
      btnIniciarProceso.disabled = true;
      btnFinalizarProceso.disabled = false;
      btnCancelarProceso.disabled = false;
      btnRepetirProceso.disabled = false;
      limpiarDatosExtraidos();
    });
  }

  if (btnFinalizarProceso){
    btnFinalizarProceso.addEventListener('click', function(){
      if (!procesoActivo) return;
      procesoActivo = false;
      enviarComando('finalizar_proceso');
      actualizarEstadoVoz('Procesando extracción...');
      btnFinalizarProceso.disabled = true;
      procesarSesion();
    });
  }

  if (btnRepetirProceso){
    btnRepetirProceso.addEventListener('click', function(){
      if (!idSesion){ alert('Inicie sesión primero'); return; }
      // Reset ventana
      procesoActivo = false;
      acumuladoCaptura = '';
      txtFinal.value = '';
      divParciales.innerHTML = '';
      actualizarEstadoVoz('Ventana reiniciada. Use “Iniciar ingreso”.');
      btnIniciarProceso.disabled = false;
      btnFinalizarProceso.disabled = true;
      btnConfirmarDatos.disabled = true;
      limpiarDatosExtraidos();
    });
  }

  if (btnCancelarProceso){
    btnCancelarProceso.addEventListener('click', function(){
      procesoActivo = false;
      actualizarEstadoVoz('Ingreso cancelado. Puede repetir o iniciar nuevamente.');
      btnIniciarProceso.disabled = false;
      btnFinalizarProceso.disabled = true;
      btnConfirmarDatos.disabled = true;
      limpiarDatosExtraidos();
    });
  }

  if (btnConfirmarDatos){
    btnConfirmarDatos.addEventListener('click', function(){
      // Mostrar formulario para ajuste manual
      mostrar(formulario);
      ocultar(interfazVoz);
    });
  }

  // --- RECEPCIÓN DE MENSAJES DE RECONOCIMIENTO ---
  // Esta función será llamada por voice-vosk.js y/o voice-webrtc-hybrid.js
  window.handleVoskMessage = function(evt){
    try {
      if (!evt) return;
      if (evt.type === 'diag'){
        actualizarIndicadorAudio(evt);
        return;
      }
      if (evt.type === 'command_feedback'){
        actualizarFeedbackComando(evt);
        return;
      }
      if (!idSesion) return;
      if (evt.type === 'partial' && evt.text){
        if (procesoActivo){ acumuladoCaptura += ' '+evt.text; }
        agregarParcial(evt.text);
        enviarTranscripcion(evt.text, 'partial');
      } else if (evt.type === 'final' && evt.text){
        if (procesoActivo){ acumuladoCaptura += ' '+evt.text; }
        actualizarFinal(acumuladoCaptura); // mostrar acumulado
        enviarTranscripcion(evt.text, 'final');
      } else if (evt.type === 'command' && evt.command){
        actualizarFeedbackComando({
          status: 'accepted',
          command: evt.command,
          raw_text: evt.text,
          confidence: evt.confidence
        });
        // Reflejar comandos automáticos
        procesarComandoDetectado(evt.command, evt.text||'');
      }
    } catch(e){ AVISO('Error handleVoskMessage', e); }
  };

  function procesarComandoDetectado(comando, texto){
    BITACORA('Comando detectado:', comando, texto);
    if (comando === 'iniciar_proceso' && !procesoActivo){
      procesoActivo = true;
      actualizarEstadoVoz('Ingreso activo: capture la descripción hablada.');
      btnIniciarProceso.disabled = true;
      btnFinalizarProceso.disabled = false;
      btnCancelarProceso.disabled = false;
      btnRepetirProceso.disabled = false;
      enviarComando('iniciar_proceso');
      limpiarDatosExtraidos();
    } else if (comando === 'finalizar_proceso' && procesoActivo){
      procesoActivo = false;
      actualizarEstadoVoz('Procesando extracción...');
      btnFinalizarProceso.disabled = true;
      enviarComando('finalizar_proceso');
      procesarSesion();
    } else if (comando === 'confirmar_datos') {
      btnConfirmarDatos.disabled = false;
      actualizarEstadoVoz('Datos listos. Pulse confirmar datos para ver formulario.');
      enviarComando('confirmar_datos');
    } else if (comando === 'repetir_proceso') {
      btnRepetirProceso.click();
      enviarComando('repetir_proceso');
    } else if (comando === 'cancelar_proceso') {
      btnCancelarProceso.click();
      enviarComando('cancelar_proceso');
    }
  }

  function actualizarIndicadorAudio(evt){
    if (!audioQualityHint) return;
    const quality = evt?.audio_quality || 'unknown';
    const hint = evt?.audio_hint || hintPorDefecto(quality);
    audioQualityHint.textContent = hint || '';
    audioQualityHint.classList.remove('text-warning', 'text-danger');
    if (quality === 'too_low'){
      audioQualityHint.classList.add('text-warning');
    } else if (quality === 'too_high'){
      audioQualityHint.classList.add('text-danger');
    }
  }

  function hintPorDefecto(quality){
    switch (quality){
      case 'too_low':
        return 'Micrófono con señal muy baja';
      case 'too_high':
        return 'Demasiado ruido / micrófono saturado';
      case 'ok':
        return 'Nivel de audio estable';
      default:
        return '';
    }
  }

  function agregarParcial(texto){
    if (!divParciales) return;
    const linea = document.createElement('div');
    linea.textContent = texto;
    linea.className = 'small text-muted';
    divParciales.appendChild(linea);
    divParciales.scrollTop = divParciales.scrollHeight;
  }

  function humanizeCommandLabel(cmd){
    if (!cmd) return 'Comando desconocido';
    return cmd.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function extractConfidenceValue(source){
    if (source === null || source === undefined) return null;
    if (typeof source === 'number') return Math.round(source * 100);
    if (typeof source === 'object' && typeof source.vosk_conf_avg === 'number'){
      return Math.round(source.vosk_conf_avg * 100);
    }
    return null;
  }

  function actualizarFeedbackComando(evt){
    if (!commandFeedbackCard) return;
    const status = evt?.status || (evt?.type === 'command' ? 'accepted' : 'info');
    const cmdLabel = humanizeCommandLabel(evt?.command) || evt?.raw_text || 'Comando';
    const confidencePercent = extractConfidenceValue(evt?.confidence);
    const thresholdPercent = typeof evt?.threshold === 'number' ? Math.round(evt.threshold * 100) : null;
    const reason = evt?.reason || null;

    mostrar(commandFeedbackCard);

    let badgeClass = 'text-bg-secondary';
    let badgeText = '--';
    let detailText = '';
    let headline = '';

    if (status === 'accepted'){
      badgeClass = 'text-bg-success';
      if (confidencePercent !== null){
        badgeText = `${confidencePercent}%`;
      } else if (reason === 'confidence_pending'){
        badgeText = '...';
      } else {
        badgeText = 'OK';
      }
      headline = `Comando detectado: ${cmdLabel}`;
      if (confidencePercent !== null){
        detailText = `Confianza ${confidencePercent}%`;
      } else if (reason === 'confidence_pending'){
        detailText = 'Esperando evaluación de confianza...';
      } else {
        detailText = 'Confianza no disponible';
      }
      commandFeedbackCard.classList.remove('feedback-rejected');
      commandFeedbackCard.classList.add('feedback-accepted');
    } else if (status === 'rejected'){
      badgeClass = 'text-bg-warning';
      badgeText = confidencePercent !== null ? `${confidencePercent}%` : 'N/D';
      headline = `Ignorado: ${cmdLabel}`;
      if (evt?.reason === 'low_confidence' && thresholdPercent !== null && confidencePercent !== null){
        detailText = `Confianza ${confidencePercent}% (mínimo ${thresholdPercent}%)`;
      } else if (evt?.reason === 'low_confidence' && thresholdPercent !== null){
        detailText = `Confianza bajo el mínimo (${thresholdPercent}%)`;
      } else {
        detailText = 'No alcanzó los criterios requeridos';
      }
      commandFeedbackCard.classList.remove('feedback-accepted');
      commandFeedbackCard.classList.add('feedback-rejected');
    } else {
      badgeClass = 'text-bg-secondary';
      badgeText = '--';
      headline = cmdLabel;
      detailText = 'Esperando comandos válidos';
      commandFeedbackCard.classList.remove('feedback-accepted', 'feedback-rejected');
    }

    if (commandFeedbackText){
      commandFeedbackText.textContent = headline;
    }
    if (commandFeedbackDetail){
      commandFeedbackDetail.textContent = detailText;
    }
    if (commandFeedbackConfidence){
      commandFeedbackConfidence.textContent = badgeText;
      commandFeedbackConfidence.className = `badge ${badgeClass} text-uppercase`;
    }
  }

  function actualizarFinal(texto){
    if (!txtFinal) return;
    let limpio = texto.replace(/\s+/g,' ').trim();
    if (limpio.length > MAX_LENGTH_FINAL){ limpio = limpio.slice(0, MAX_LENGTH_FINAL)+'...'; }
    txtFinal.value = limpio;
    ultimaActualizacionFinal = Date.now();
  }

  function enviarTranscripcion(texto, tipo){
    secureFetch('/parts/voice/log-transcription/', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ text: texto, type: tipo, session_id: idSesion })
    }).catch(()=>{});
  }

  async function procesarSesion(){
    if (!idSesion){ return; }
    try {
      mostrarPanelDatos();
      actualizarEstadoDatosExtraidos('Procesando audio y extrayendo datos...', 'info');
      const cuerpo = {
        session_id: idSesion,
        use_accumulated: true,
        accumulated_text: acumuladoCaptura.trim()
      };
      const r = await secureFetch('/parts/voice/process-session/', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify(cuerpo)
      });
      const j = await r.json();
      if (!j.success){ throw new Error(j.error||'Error procesando sesión'); }
      actualizarEstadoVoz('Extracción completada. Puede confirmar datos.');
      btnConfirmarDatos.disabled = false;
      const campos = j.fields || {};
      const transcript = j.transcript || '';
      rellenarFormulario(campos, transcript);
      mostrarDatosExtraidos(campos, transcript);
      const tieneDatos = Object.values(campos).some((valor) => {
        if (valor === null || valor === undefined) return false;
        return String(valor).trim().length > 0;
      });
      if (!tieneDatos) {
        actualizarEstadoDatosExtraidos('No se detectaron campos relevantes. Verifica el audio o dicta nuevamente.', 'warning');
      }
    } catch(e){
      actualizarEstadoVoz('Error en extracción: ' + e.message);
      ERROR(e);
      mostrarErrorExtraccion(e.message || 'No se pudieron extraer datos.');
    }
  }

  function rellenarFormulario(campos, transcript){
    if (!formulario) return;
    try {
      const mapa = {
        name: campos.parte,
        details: campos.detalles || transcript,
        max_value: campos.valor,
        min_value: campos.min_value ?? campos.valor
      };
      Object.entries(mapa).forEach(([djangoField, valor]) => {
        if (valor === undefined || valor === null) return;
        const el = formulario.querySelector('[name="'+djangoField+'"]');
        if (el){ el.value = valor; el.dispatchEvent(new Event('change',{bubbles:true})); }
      });
    } catch(e){ AVISO('Error rellenando formulario', e); }
  }

  // Cierre de sesión al enviar formulario
  if (formulario){
    formulario.addEventListener('submit', function(){
      // Intentar cierre de sesión para auditoría
      if (idSesion){
        secureFetch('/parts/voice/close-session/', {
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body: JSON.stringify({reason:'part_saved', session_id: idSesion})
        }).catch(()=>{});
      }
    });
  }

})();
