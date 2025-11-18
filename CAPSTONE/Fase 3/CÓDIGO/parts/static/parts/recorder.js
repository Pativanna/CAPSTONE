// static/recorder.js - Grabación MANUAL con botón (diferente a manos libres Vosk)
document.addEventListener("DOMContentLoaded", () => {
  let mediaRecorder;
  let chunks = [];
  let recordingStartTime = null;
  let grabando = false;         // Estado de grabación (idempotencia)
  let iniciando = false;        // Antirrebote/anti-reentrancia
  let timerInterval = null;     // Intervalo para contador de duración

  // Elementos UI (compat: botón antiguo #record y botón actual #record-voice-btn)
  const botonCircular = document.getElementById('record');
  const textoEstado = document.getElementById('status');
  const botonVoz = document.getElementById('record-voice-btn');
  const previewResultados = document.getElementById('results-preview');

  // Map your PartForm field names to JSON keys
  const fieldMap = {
    name: "parte",
    details: "detalles",
    max_value: "valor",
    min_value: "min_value",
  };

  // Escuchar eventos de inicio y detención desde form-handler.js
  document.addEventListener('startRecording', startRecording);
  document.addEventListener('stopRecording', stopRecording);
  document.addEventListener('cancelRecording', cancelRecording);

  // Botón circular (si existe en la página actual)
  if (botonCircular && !botonCircular.__bound) {
    botonCircular.addEventListener('click', async () => {
      if (iniciando) return; // antirrebote
      if (!grabando) {
        iniciando = true;
        setButtonUIStarting();
        try {
          await startRecording();
          grabando = true;
          setButtonUIRecording();
          setStatusText('Grabando...');
        } catch (e) {
          console.error('Error al iniciar grabación:', e);
          setStatusText('No se pudo iniciar la grabación');
          setButtonUIIdle();
        } finally {
          iniciando = false;
        }
      } else {
        // Detener
        stopRecording();
        grabando = false;
        setButtonUIProcessing();
        setStatusText('Procesando audio...');
      }
    });
    botonCircular.__bound = true;
  }

  // Asegurar atributos de accesibilidad en el botón de voz moderno
  if (botonVoz) {
    if (!botonVoz.hasAttribute('aria-pressed')) botonVoz.setAttribute('aria-pressed', 'false');
    if (!botonVoz.hasAttribute('aria-busy')) botonVoz.setAttribute('aria-busy', 'false');
  }

  async function startRecording() {
    console.log('🎙️ [GRABACIÓN MANUAL] Iniciando grabación con botón...');
    if (iniciando || grabando) {
      console.log('⏸️ Solicitud de inicio ignorada (ya iniciando/grabando)');
      return;
    }
    
    // Verificar si getUserMedia está disponible
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      const isSecure = window.location.protocol === 'https:' || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
      
      let errorMsg = '⚠️ El micrófono no está disponible.\n\n';
      if (!isSecure) {
        errorMsg += '🔒 HTTPS es requerido para acceder al micrófono.\n\n';
        errorMsg += '📝 Opciones:\n';
        errorMsg += '1. Configura HTTPS/SSL en el servidor\n';
        errorMsg += '2. Accede vía SSH tunnel: ssh -L 8080:localhost:80 usuario@servidor\n';
        errorMsg += '   Luego abre: http://localhost:8080\n\n';
        errorMsg += '3. Usa el formulario manual sin voz';
      } else {
        errorMsg += 'Tu navegador no soporta grabación de audio.';
      }
      
      alert(errorMsg);
      console.error('getUserMedia no disponible:', {
        secure: isSecure,
        protocol: window.location.protocol,
        hostname: window.location.hostname
      });
      
      resetButton();
      return;
    }
    
    try {
      // MEJORA: Solicitar audio con configuración óptima para Whisper
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
      
      // MEJORA: Usar formato WebM Opus (mejor para Whisper)
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') 
        ? 'audio/webm;codecs=opus' 
        : 'audio/webm';
      
      mediaRecorder = new MediaRecorder(stream, {
        mimeType: mimeType,
        audioBitsPerSecond: 128000
      });
      
      // Registrar recursos en el coordinador
      if (window.VoiceCoordinator) {
        window.VoiceCoordinator.registerResource('mediaRecorder', mediaRecorder);
        window.VoiceCoordinator.registerResource('mediaStream', stream);
      }
      
      chunks = [];
      recordingStartTime = Date.now();
      
      mediaRecorder.ondataavailable = e => {
        if (e.data.size > 0) {
          chunks.push(e.data);
          console.log(`📦 Chunk capturado: ${e.data.size} bytes`);
        }
      };
      
      mediaRecorder.onstop = sendAudio;
      
      mediaRecorder.onerror = (event) => {
        console.error('❌ Error en MediaRecorder:', event.error);
        alert('Error durante la grabación: ' + event.error);
        resetButton();
      };
      
      // Capturar datos cada 1 segundo para mejor calidad
      mediaRecorder.start(1000);
      
      console.log(`✅ [GRABACIÓN MANUAL] Iniciada con ${mimeType}`);
      console.log(`🎤 Grabando... (presiona de nuevo para detener)`);

      // Estado UI: grabando (botón moderno)
      setVoiceBtnRecording();
      startTimer();
      grabando = true;
      
    } catch (err) {
      console.error('❌ Error accediendo al micrófono:', err);
      let errorMsg = 'No se pudo acceder al micrófono.\n\n';
      
      if (err.name === 'NotAllowedError') {
        errorMsg += '❌ Permiso denegado. Por favor:\n';
        errorMsg += '1. Permite el acceso al micrófono en tu navegador\n';
        errorMsg += '2. Revisa la configuración de permisos del sitio';
      } else if (err.name === 'NotFoundError') {
        errorMsg += '🎤 No se detectó ningún micrófono conectado';
      } else {
        errorMsg += '⚠️ Error: ' + err.message;
      }
      
      alert(errorMsg);
      resetButton();
      setButtonUIIdle();
      setVoiceBtnIdle();
    }
  }

  function stopRecording() {
    if (!grabando && !(mediaRecorder && mediaRecorder.state === 'recording')) {
      // Idempotente
      return;
    }
    if (mediaRecorder && mediaRecorder.state === "recording") {
      const duration = ((Date.now() - recordingStartTime) / 1000).toFixed(1);
      console.log(`⏹️ [GRABACIÓN MANUAL] Deteniendo... (duración: ${duration}s)`);
      mediaRecorder.stop();
      
      // Detener todos los tracks del stream
      mediaRecorder.stream.getTracks().forEach(track => track.stop());
    }
    grabando = false;
    mediaRecorder = null; // Limpiar referencia
    stopTimer();
    // Estado UI: procesando
    setVoiceBtnProcessing();
  }

  function cancelRecording() {
    console.log('❌ [GRABACIÓN MANUAL] Cancelando...');
    if (mediaRecorder && mediaRecorder.state === "recording") {
      // Detener la grabación sin procesar
      mediaRecorder.stop();
      
      // Detener todos los tracks del stream para liberar el micrófono
      if (mediaRecorder.stream) {
        mediaRecorder.stream.getTracks().forEach(track => track.stop());
      }
      
      // Limpiar chunks para que no se procese el audio
      chunks = [];
      
      console.log('✅ Grabación cancelada');
    }
    resetButton();
    setButtonUIIdle();
    setVoiceBtnIdle();
    stopTimer();
  }
  
  function resetButton() {
    const recordVoiceBtn = document.getElementById('record-voice-btn');
    if (recordVoiceBtn) {
      recordVoiceBtn.classList.remove('recording', 'loading');
      recordVoiceBtn.querySelector('.btn-text').textContent = 'Grabar';
      recordVoiceBtn.querySelector('i').className = 'fas fa-microphone';
      recordVoiceBtn.disabled = false;
      recordVoiceBtn.style.display = 'flex';
      recordVoiceBtn.setAttribute('aria-pressed','false');
      recordVoiceBtn.setAttribute('aria-busy','false');
    }
    // Botón circular si existe
    setButtonUIIdle();
  }

  function sendAudio() {
    // Si no hay chunks (grabación cancelada), no hacer nada
    if (chunks.length === 0) {
      console.log('⚠️ [GRABACIÓN MANUAL] No hay audio para enviar (cancelada)');
      resetButton();
      setVoiceBtnIdle();
      return;
    }
    
    console.log(`📦 [GRABACIÓN MANUAL] Procesando ${chunks.length} chunks`);
    const duration = ((Date.now() - recordingStartTime) / 1000).toFixed(1);
    
    const blob = new Blob(chunks, { type: "audio/webm" });
    console.log(`📊 Audio: ${(blob.size / 1024).toFixed(2)} KB, duración: ${duration}s`);
    
    const formData = new FormData();
    formData.append("audio", blob, "recording.webm");
    
    // Get AI model preference from switch (Local vs Nube)
    let useCloud = false;
    try {
      if (typeof window.getUseCloudPreference === 'function') {
        useCloud = !!window.getUseCloudPreference();
      } else {
        const aiSwitch = document.getElementById('ai-model-switch');
        if (aiSwitch) useCloud = !!aiSwitch.checked; else useCloud = (localStorage.getItem('useCloud')||'false')==='true';
      }
    } catch(e){ useCloud = false; }
    formData.append("use_cloud", useCloud.toString());
    
    console.log(`🤖 [GRABACIÓN MANUAL] Enviando a ${useCloud ? 'OpenAI Whisper (Nube)' : 'Ollama (Local)'}...`);

    fetch("/parts/upload-audio/", { 
        method: "POST", 
        body: formData,
        headers: {
          'Accept': 'application/json, text/plain, */*',
          'Accept-Charset': 'utf-8'
        }
      })
      .then(r => r.json())
      .then(data => {
        console.log("Response:", data);
        
        const transcription = data.transcription || "(no se detectó texto)";
        const vehicleInfo = data.vehicle_info || {};
        
        // Llamar a la función global para mostrar resultados
        if (window.showRecordingResults) {
          window.showRecordingResults(transcription, vehicleInfo);
        }
        
        // También llenar el formulario en segundo plano
        fillForm(vehicleInfo);

        // Volver a estado inactivo en el botón circular
        setButtonUIIdle();
        setStatusText('Transcripción completa.');
        setVoiceBtnIdle();
      })
      .catch(e => {
        console.error('Error:', e);
        alert('Error al procesar el audio: ' + e.message);
        
  // Resetear interfaz en caso de error
        const recordVoiceBtn = document.getElementById('record-voice-btn');
        if (recordVoiceBtn) {
          recordVoiceBtn.classList.remove('loading', 'recording');
          recordVoiceBtn.querySelector('.btn-text').textContent = 'Grabar';
          recordVoiceBtn.querySelector('i').className = 'fas fa-microphone';
          recordVoiceBtn.disabled = false;
          recordVoiceBtn.style.display = 'flex';
          recordVoiceBtn.setAttribute('aria-pressed','false');
          recordVoiceBtn.setAttribute('aria-busy','false');
        }
        setButtonUIIdle();
        setStatusText('Error al procesar');
        setVoiceBtnError();
      });
  }

  function fillForm(info) {
    console.log("Filling form with info:", info);
    
    const form = document.getElementById('part-form');
    if (!form) return;
    
    for (const [djangoField, jsonKey] of Object.entries(fieldMap)) {
      if (!jsonKey) continue;
      
      let el = document.getElementById("id_" + djangoField) || 
               document.querySelector(`[name="${djangoField}"]`);
      
      if (el && info[jsonKey] !== undefined && info[jsonKey] !== null) {
        console.log(`Setting ${djangoField} to ${info[jsonKey]}`);
        el.value = info[jsonKey];
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
  }

  // -------------------- UI Helpers para botón circular --------------------
  function setStatusText(msg) {
    if (textoEstado) textoEstado.textContent = msg || '';
  }
  function setButtonUIIdle() {
    if (!botonCircular) return;
    botonCircular.disabled = false;
    botonCircular.classList.remove('btn-warning');
    botonCircular.classList.add('btn-danger');
    botonCircular.classList.remove('recording');
    botonCircular.setAttribute('aria-pressed', 'false');
    botonCircular.title = 'Iniciar grabación';
    botonCircular.innerText = '🎙️';
  }
  function setButtonUIStarting() {
    if (!botonCircular) return;
    botonCircular.disabled = true;
    botonCircular.classList.add('btn-warning');
    botonCircular.title = 'Preparando micrófono...';
  }
  function setButtonUIRecording() {
    if (!botonCircular) return;
    botonCircular.disabled = false;
    botonCircular.classList.remove('btn-danger');
    botonCircular.classList.add('btn-warning');
    botonCircular.classList.add('recording');
    botonCircular.setAttribute('aria-pressed', 'true');
    botonCircular.title = 'Detener grabación';
    botonCircular.innerText = '⏹️';
  }
  function setButtonUIProcessing() {
    if (!botonCircular) return;
    botonCircular.disabled = true;
    botonCircular.classList.add('btn-warning');
    botonCircular.title = 'Procesando audio...';
  }

  // -------------------- UI Helpers para botón #record-voice-btn --------------------
  function setVoiceBtnRecording(){
    if (!botonVoz) return;
    try{
      botonVoz.classList.add('recording');
      botonVoz.classList.remove('loading');
      const label = botonVoz.querySelector('.btn-text');
      if (label) label.textContent = 'Detener 00:00';
      const icon = botonVoz.querySelector('i');
      if (icon) icon.className = 'fas fa-stop';
      botonVoz.disabled = false;
      botonVoz.setAttribute('aria-pressed','true');
      botonVoz.setAttribute('aria-busy','false');
      botonVoz.title = 'Detener grabación';
    }catch(e){ console.warn('UI recording voz', e); }
  }
  function setVoiceBtnProcessing(){
    if (!botonVoz) return;
    try{
      botonVoz.classList.remove('recording');
      botonVoz.classList.add('loading');
      const label = botonVoz.querySelector('.btn-text');
      if (label) label.textContent = 'Procesando...';
      const icon = botonVoz.querySelector('i');
      if (icon) icon.className = 'fas fa-spinner fa-spin';
      botonVoz.disabled = true;
      botonVoz.setAttribute('aria-pressed','false');
      botonVoz.setAttribute('aria-busy','true');
      botonVoz.title = 'Procesando audio';
    }catch(e){ console.warn('UI processing voz', e); }
  }
  function setVoiceBtnIdle(){
    if (!botonVoz) return;
    try{
      botonVoz.classList.remove('recording','loading');
      const label = botonVoz.querySelector('.btn-text');
      if (label) label.textContent = 'Grabar';
      const icon = botonVoz.querySelector('i');
      if (icon) icon.className = 'fas fa-microphone';
      botonVoz.disabled = false;
      botonVoz.setAttribute('aria-pressed','false');
      botonVoz.setAttribute('aria-busy','false');
      botonVoz.title = 'Iniciar grabación';
    }catch(e){ console.warn('UI idle voz', e); }
  }
  function setVoiceBtnError(){
    if (!botonVoz) return;
    try{
      botonVoz.classList.remove('recording','loading');
      const label = botonVoz.querySelector('.btn-text');
      if (label) label.textContent = 'Error';
      const icon = botonVoz.querySelector('i');
      if (icon) icon.className = 'fas fa-exclamation-triangle';
      botonVoz.disabled = false;
      botonVoz.setAttribute('aria-pressed','false');
      botonVoz.setAttribute('aria-busy','false');
      botonVoz.title = 'Hubo un error. Volver a intentar';
      // Mostrar barra inferior para reintento si existe
      const bar = document.getElementById('bottom-control-bar');
      if (bar){ bar.style.display = 'block'; }
    }catch(e){ console.warn('UI error voz', e); }
  }

  function startTimer(){
    if (!botonVoz) return;
    stopTimer();
    timerInterval = setInterval(() => {
      if (!recordingStartTime) return;
      const secs = Math.max(0, Math.floor((Date.now() - recordingStartTime)/1000));
      const mm = String(Math.floor(secs/60)).padStart(2,'0');
      const ss = String(secs%60).padStart(2,'0');
      const label = botonVoz.querySelector('.btn-text');
      if (label && botonVoz.classList.contains('recording')){
        label.textContent = `Detener ${mm}:${ss}`;
      }
    }, 1000);
  }
  function stopTimer(){
    if (timerInterval){ clearInterval(timerInterval); timerInterval = null; }
  }
});
