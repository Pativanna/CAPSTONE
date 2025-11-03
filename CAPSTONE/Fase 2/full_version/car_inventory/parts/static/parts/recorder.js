// static/recorder.js
document.addEventListener("DOMContentLoaded", () => {
  let mediaRecorder;
  let chunks = [];

  // Map your PartForm field names to JSON keys
  const fieldMap = {
    name: "parte",
    details: "detalles",
    car_model: "modelo",
    max_value: "valor",
    min_value: "valor",
    color: "color",
  };

  // Escuchar eventos de inicio y detención desde form-handler.js
  document.addEventListener('startRecording', startRecording);
  document.addEventListener('stopRecording', stopRecording);

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorder = new MediaRecorder(stream);
      chunks = [];
      mediaRecorder.ondataavailable = e => chunks.push(e.data);
      mediaRecorder.onstop = sendAudio;
      mediaRecorder.start();
      console.log('Recording started...');
    } catch (err) {
      console.error('Mic access denied:', err);
      alert('No se pudo acceder al micrófono: ' + err.message);
      // Resetear el botón
      const recordVoiceBtn = document.getElementById('record-voice-btn');
      if (recordVoiceBtn) {
        recordVoiceBtn.classList.remove('recording', 'loading');
        recordVoiceBtn.querySelector('.btn-text').textContent = 'Grabar';
        recordVoiceBtn.querySelector('i').className = 'fas fa-microphone';
        recordVoiceBtn.disabled = false;
        recordVoiceBtn.style.display = 'flex';
      }
    }
  }

  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state === "recording") {
      mediaRecorder.stop();
      console.log('Recording stopped, processing...');
    }
  }

  function sendAudio() {
    const blob = new Blob(chunks, { type: "audio/webm" });
    const formData = new FormData();
    formData.append("audio", blob, "recording.webm");

    fetch("/upload/", { 
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
        }
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
});
