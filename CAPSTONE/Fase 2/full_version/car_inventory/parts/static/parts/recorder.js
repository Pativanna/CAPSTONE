// static/recorder.js
document.addEventListener("DOMContentLoaded", () => {
  let mediaRecorder;
  let chunks = [];

  const recordBtn = document.getElementById("record");
  const stopBtn = document.getElementById("stop");
  const output = document.getElementById("output");
  const vehicle = document.getElementById("vehicle");

  // Map your PartForm field names to JSON keys
  const fieldMap = {
    name: "parte",
    car_model: "modelo",
    value: "valor",
    color: "color", // optional, if you later add color field
  };

  recordBtn.addEventListener("click", async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorder = new MediaRecorder(stream);
      chunks = [];
      mediaRecorder.ondataavailable = e => chunks.push(e.data);
      mediaRecorder.onstop = sendAudio;
      mediaRecorder.start();
      recordBtn.disabled = true;
      stopBtn.disabled = false;
      output.textContent = "🎙️ Recording...";
      vehicle.textContent = "";
    } catch (err) {
      output.textContent = "Mic access denied: " + err;
    }
  });

  stopBtn.addEventListener("click", () => {
    if (mediaRecorder && mediaRecorder.state === "recording") {
      mediaRecorder.stop();
      recordBtn.disabled = false;
      stopBtn.disabled = true;
      output.textContent = "⏹️ Uploading...";
    }
  });

  function sendAudio() {
    const blob = new Blob(chunks, { type: "audio/webm" });
    const formData = new FormData();
    formData.append("audio", blob, "recording.webm");

    fetch("/upload/", { method: "POST", body: formData })
      .then(r => r.json())
      .then(data => {
        console.log("Response:", data);
        output.textContent = data.transcription || "(no text)";
        if (data.vehicle_info) {
          const info = data.vehicle_info;
          vehicle.textContent = JSON.stringify(info, null, 2);
          fillForm(info);
        } else {
          vehicle.textContent = "⚙️ No structured data detected.";
        }
      })
      .catch(e => output.textContent = "❌ Error: " + e);
  }

  function fillForm(info) {
    for (const [djangoField, jsonKey] of Object.entries(fieldMap)) {
      if (!jsonKey) continue;
      const el = document.getElementById("id_" + djangoField);
      if (el && info[jsonKey]) el.value = info[jsonKey];
    }
  }
});
