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

  // Botones de control de proceso
  const btnIniciarSesion = document.getElementById('btn-iniciar-sesion');
  const btnIniciarProceso = document.getElementById('btn-iniciar-proceso');
  const btnFinalizarProceso = document.getElementById('btn-finalizar-proceso');
  const btnConfirmarDatos = document.getElementById('btn-confirmar-datos');
  const btnRepetirProceso = document.getElementById('btn-repetir-proceso');
  const btnCancelarProceso = document.getElementById('btn-cancelar-proceso');

  const divParciales = document.getElementById('transcripciones-parciales');
  const txtFinal = document.getElementById('transcripcion-final');
  const formulario = document.getElementById('part-form');

  // Estado interno
  let idSesion = '';
  let procesoActivo = false; // Entre iniciar_proceso y finalizar_proceso
  let acumuladoCaptura = ''; // Texto acumulado dentro de ventana activa
  let ultimaActualizacionFinal = 0;
  const MAX_LENGTH_FINAL = 12000; // cortar para evitar excesos
  let seleccionVehiculo = null; // { tipo: 'auto'|'manual', id?: string|number, label: string }

  // Utilidades Fase 1
  function mostrar(el){ if (el) el.style.display = 'block'; }
  function ocultar(el){ if (el) el.style.display = 'none'; }
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
          btnUsePrevious.style.display = 'inline-block';
          btnUsePrevious.onclick = function(){
            setSeleccionActual(obj);
            if (selFaseSeleccion) selFaseSeleccion.style.display = 'none';
            if (interfazVoz) interfazVoz.style.display = 'block';
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
        if (selFaseSeleccion) selFaseSeleccion.style.display = 'none';
        if (interfazVoz) interfazVoz.style.display = 'block';
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
        if (selFaseSeleccion) selFaseSeleccion.style.display = 'none';
        if (interfazVoz) interfazVoz.style.display = 'block';
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
      if (selFaseSeleccion) selFaseSeleccion.style.display='none';
      if (interfazVoz) interfazVoz.style.display='block';
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
      const r = await fetch('/parts/voice/start-session/', {method:'POST'});
      const j = await r.json();
      if (!j.success){ throw new Error(j.error||'No se pudo iniciar sesión'); }
      idSesion = j.session_id;
      sessionHidden.value = idSesion;
      estadoVoz.textContent = 'Sesión iniciada: '+idSesion;
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
    fetch('/parts/voice/log-command/', {
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
      estadoVoz.textContent = 'Proceso activo: capture la descripción hablada.';
      btnIniciarProceso.disabled = true;
      btnFinalizarProceso.disabled = false;
      btnCancelarProceso.disabled = false;
      btnRepetirProceso.disabled = false;
    });
  }

  if (btnFinalizarProceso){
    btnFinalizarProceso.addEventListener('click', function(){
      if (!procesoActivo) return;
      procesoActivo = false;
      enviarComando('finalizar_proceso');
      estadoVoz.textContent = 'Procesando extracción...';
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
      estadoVoz.textContent = 'Ventana reiniciada. Pulse iniciar proceso.';
      btnIniciarProceso.disabled = false;
      btnFinalizarProceso.disabled = true;
      btnConfirmarDatos.disabled = true;
    });
  }

  if (btnCancelarProceso){
    btnCancelarProceso.addEventListener('click', function(){
      procesoActivo = false;
      estadoVoz.textContent = 'Proceso cancelado. Puede reiniciar.';
      btnIniciarProceso.disabled = false;
      btnFinalizarProceso.disabled = true;
      btnConfirmarDatos.disabled = true;
    });
  }

  if (btnConfirmarDatos){
    btnConfirmarDatos.addEventListener('click', function(){
      // Mostrar formulario para ajuste manual
      formulario.style.display='block';
      interfazVoz.style.display='none';
    });
  }

  // --- RECEPCIÓN DE MENSAJES DE RECONOCIMIENTO ---
  // Esta función será llamada por voice-vosk.js y/o voice-webrtc-hybrid.js
  window.handleVoskMessage = function(evt){
    try {
      if (!evt || !idSesion) return;
      if (evt.type === 'partial' && evt.text){
        if (procesoActivo){ acumuladoCaptura += ' '+evt.text; }
        agregarParcial(evt.text);
        enviarTranscripcion(evt.text, 'partial');
      } else if (evt.type === 'final' && evt.text){
        if (procesoActivo){ acumuladoCaptura += ' '+evt.text; }
        actualizarFinal(acumuladoCaptura); // mostrar acumulado
        enviarTranscripcion(evt.text, 'final');
      } else if (evt.type === 'command' && evt.command){
        // Reflejar comandos automáticos
        procesarComandoDetectado(evt.command, evt.text||'');
      }
    } catch(e){ AVISO('Error handleVoskMessage', e); }
  };

  function procesarComandoDetectado(comando, texto){
    BITACORA('Comando detectado:', comando, texto);
    if (comando === 'iniciar_proceso' && !procesoActivo){
      procesoActivo = true;
      estadoVoz.textContent = 'Proceso activo: capture la descripción hablada.';
      btnIniciarProceso.disabled = true;
      btnFinalizarProceso.disabled = false;
      btnCancelarProceso.disabled = false;
      btnRepetirProceso.disabled = false;
      enviarComando('iniciar_proceso');
    } else if (comando === 'finalizar_proceso' && procesoActivo){
      procesoActivo = false;
      estadoVoz.textContent = 'Procesando extracción...';
      btnFinalizarProceso.disabled = true;
      enviarComando('finalizar_proceso');
      procesarSesion();
    } else if (comando === 'confirmar_datos') {
      btnConfirmarDatos.disabled = false;
      estadoVoz.textContent = 'Datos listos. Pulse confirmar datos para ver formulario.';
      enviarComando('confirmar_datos');
    } else if (comando === 'repetir_proceso') {
      btnRepetirProceso.click();
      enviarComando('repetir_proceso');
    } else if (comando === 'cancelar_proceso') {
      btnCancelarProceso.click();
      enviarComando('cancelar_proceso');
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

  function actualizarFinal(texto){
    if (!txtFinal) return;
    let limpio = texto.replace(/\s+/g,' ').trim();
    if (limpio.length > MAX_LENGTH_FINAL){ limpio = limpio.slice(0, MAX_LENGTH_FINAL)+'...'; }
    txtFinal.value = limpio;
    ultimaActualizacionFinal = Date.now();
  }

  function enviarTranscripcion(texto, tipo){
    fetch('/parts/voice/log-transcription/', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ text: texto, type: tipo, session_id: idSesion })
    }).catch(()=>{});
  }

  async function procesarSesion(){
    if (!idSesion){ return; }
    try {
      const cuerpo = {
        session_id: idSesion,
        use_accumulated: true,
        accumulated_text: acumuladoCaptura.trim()
      };
      const r = await fetch('/parts/voice/process-session/', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify(cuerpo)
      });
      const j = await r.json();
      if (!j.success){ throw new Error(j.error||'Error procesando sesión'); }
      estadoVoz.textContent = 'Extracción completada. Puede confirmar datos.';
      btnConfirmarDatos.disabled = false;
      rellenarFormulario(j.fields||{}, j.transcript||'');
    } catch(e){
      estadoVoz.textContent = 'Error en extracción: '+e.message;
      ERROR(e);
    }
  }

  function rellenarFormulario(campos, transcript){
    if (!formulario) return;
    try {
      const mapa = {
        name: campos.parte,
        details: campos.detalles || transcript,
        max_value: campos.valor,
        min_value: campos.valor
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
        fetch('/parts/voice/close-session/', {
          method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({reason:'part_saved'})
        }).catch(()=>{});
      }
    });
  }

})();
