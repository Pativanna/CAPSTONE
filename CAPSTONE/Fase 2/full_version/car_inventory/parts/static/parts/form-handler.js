// form-handler.js

// Función principal que se ejecuta cuando el DOM está listo
document.addEventListener('DOMContentLoaded', function() {
    const form = document.getElementById('part-form');
    const vehicleSelection = document.getElementById('vehicle-selection');
        const pageTitle = document.getElementById('page-title');
        const recordContainer = document.getElementById('record-container');
        const voiceTitle = document.getElementById('voice-title');
    const autoSelectorBox = document.getElementById('select-auto-box');
    const singleBox = document.getElementById('single-entry-box');
    const currentSelection = document.getElementById('current-selection');
    const selectedDisplay = document.getElementById('selected-display');
    
    // Selector persistente de ubicación
    const persistentWorkshopSelector = document.getElementById('persistent-workshop-selector');
    const workshopStatus = document.getElementById('workshop-status');
    
    // Barra de controles inferior
    const bottomControlBar = document.getElementById('bottom-control-bar');
    const bottomManualEntryBtn = document.getElementById('bottom-manual-entry-btn');
    
    // Overlay de éxito
    const successOverlay = document.getElementById('success-overlay');
    
    // Nuevos elementos de interfaz
    const voiceRecordingInterface = document.getElementById('voice-recording-interface');
    const recordVoiceBtn = document.getElementById('record-voice-btn');
    const loadingContainer = document.getElementById('loading-container');
    const resultsPreview = document.getElementById('results-preview');
    const confirmDataBtn = document.getElementById('confirm-data-btn');
    const modifyDataBtn = document.getElementById('modify-data-btn');
    
    let isRecording = false;

    // Ajustar padding inferior del contenedor de voz para que no tape el footer fijo
    function adjustRecordingLayout() {
        if (!voiceRecordingInterface) return;
        const barH = bottomControlBar && bottomControlBar.offsetHeight ? bottomControlBar.offsetHeight : 0;
        const extra = barH ? barH + 24 : 120; // 24px de respiro mínimo
        voiceRecordingInterface.style.paddingBottom = extra + 'px';
    }
    
    // ===== GESTIÓN DE UBICACIÓN PERSISTENTE =====
    function loadSavedWorkshop() {
        const savedWorkshop = localStorage.getItem('persistent_workshop_id');
        const savedWorkshopName = localStorage.getItem('persistent_workshop_name');
        
        if (persistentWorkshopSelector && savedWorkshop) {
            persistentWorkshopSelector.value = savedWorkshop;
            if (workshopStatus && savedWorkshopName) {
                workshopStatus.innerHTML = `<i class="fas fa-check-circle text-success"></i> Ubicación actual: <strong>${savedWorkshopName}</strong>`;
            }
        }
    }
    
    function saveWorkshopSelection() {
        if (!persistentWorkshopSelector) return;
        
        const selectedValue = persistentWorkshopSelector.value;
        const selectedText = persistentWorkshopSelector.options[persistentWorkshopSelector.selectedIndex]?.text;
        
        if (selectedValue) {
            localStorage.setItem('persistent_workshop_id', selectedValue);
            localStorage.setItem('persistent_workshop_name', selectedText);
            if (workshopStatus) {
                workshopStatus.innerHTML = `<i class="fas fa-check-circle text-success"></i> Ubicación guardada: <strong>${selectedText}</strong>`;
            }
        } else {
            localStorage.removeItem('persistent_workshop_id');
            localStorage.removeItem('persistent_workshop_name');
            if (workshopStatus) {
                workshopStatus.innerHTML = '<i class="fas fa-info-circle text-muted"></i> Seleccione su ubicación de trabajo';
            }
        }
    }
    
    // Cargar ubicación guardada al iniciar
    loadSavedWorkshop();
    
    // Escuchar cambios en el selector de ubicación
    if (persistentWorkshopSelector) {
        persistentWorkshopSelector.addEventListener('change', saveWorkshopSelection);
    }
    
    // Función para mostrar la interfaz de grabación de voz
    function showVoiceInterface() {
        vehicleSelection.style.display = 'none';
        voiceRecordingInterface.style.display = 'block';
        if (bottomControlBar) bottomControlBar.style.display = 'block';
        adjustRecordingLayout();
            // Ocultar títulos redundantes en modo voz
            if (pageTitle) pageTitle.style.display = 'none';
            if (voiceTitle) voiceTitle.style.display = 'none';
    }
    
    // Función para mostrar el formulario manual
    function showManualForm() {
        voiceRecordingInterface.style.display = 'none';
        if (bottomControlBar) bottomControlBar.style.display = 'none';
        form.style.display = 'block';
    }
    
    // Función para mostrar el formulario después de la selección
    function showFormAfterSelection() {
        // Set the hidden form's auto select if available
        const stored = localStorage.getItem('selected_auto_id');
        if (stored) {
            const sel = document.querySelector('select[name="auto"]');
            if (sel) {
                sel.value = stored;
            }
        }
        
        // Mostrar interfaz de voz en lugar del formulario directo
        showVoiceInterface();
    }
    
    // Si estamos en modo edición, ocultar el selector de vehículos y mostrar el formulario
    if (form && form.dataset.isEdit === 'true') {
        if (vehicleSelection) {
            vehicleSelection.style.display = 'none';
        }
        form.style.display = 'block';
        
        // Ocultar el campo de selección de auto en el formulario
        const autoField = form.querySelector('select[name="auto"]');
        if (autoField) {
            const wrapper = autoField.closest('p') || autoField.parentElement;
            if (wrapper) {
                wrapper.style.display = 'none';
            }
        }
    } else {
        // En modo creación, verificar si hay una selección previa
        const storedId = localStorage.getItem('selected_auto_id');
        const storedLabel = localStorage.getItem('selected_auto_label');
        
        if (storedId || storedLabel) {
            currentSelection.style.display = 'block';
            selectedDisplay.textContent = storedLabel;
            if (storedId) {
                const sel = form.querySelector('select[name="auto"]');
                if (sel) sel.value = storedId;
            }
            document.getElementById('use-previous').style.display = 'inline-block';
        }
    }

    // Event Listeners para los botones de modo
    const modeSelectAuto = document.getElementById('mode-select-auto');
    if (modeSelectAuto) {
        modeSelectAuto.addEventListener('click', function() {
            autoSelectorBox.style.display = 'block';
            singleBox.style.display = 'none';
        });
    }

    const modeSingle = document.getElementById('mode-single');
    if (modeSingle) {
        modeSingle.addEventListener('click', function() {
            singleBox.style.display = 'block';
            autoSelectorBox.style.display = 'none';
        });
    }

    // Botón de confirmar auto
    const confirmAuto = document.getElementById('confirm-auto');
    if (confirmAuto) {
        confirmAuto.addEventListener('click', function() {
            const sel = document.getElementById('auto-selector');
            const val = sel.value;
            const label = sel.options[sel.selectedIndex].text;
            if (!val) {
                window.showToast?.({ title: 'Vehículo', body: 'Seleccione un vehículo primero', variant: 'warning' });
                return;
            }
            localStorage.setItem('selected_auto_id', val);
            localStorage.setItem('selected_auto_label', label);
            currentSelection.style.display = 'block';
            selectedDisplay.textContent = label;
            document.getElementById('use-previous').style.display = 'none';
            showFormAfterSelection();
        });
    }

    // Botón de limpiar selección
    const clearSelection = document.getElementById('clear-selection');
    if (clearSelection) {
        clearSelection.addEventListener('click', function() {
            localStorage.removeItem('selected_auto_id');
            localStorage.removeItem('selected_auto_label');
            currentSelection.style.display = 'none';
            autoSelectorBox.style.display = 'none';
        });
    }

    // Botón de cambiar vehículo
    const changeVehicle = document.getElementById('change-vehicle');
    if (changeVehicle) {
        changeVehicle.addEventListener('click', function() {
            localStorage.removeItem('selected_auto_id');
            localStorage.removeItem('selected_auto_label');
            currentSelection.style.display = 'none';
            form.style.display = 'none';
            voiceRecordingInterface.style.display = 'none';
            manualEntryBtnContainer.style.display = 'none';
            vehicleSelection.style.display = '';
        });
    }

    // Botón de usar selección previa
    const usePrevious = document.getElementById('use-previous');
    if (usePrevious) {
        usePrevious.addEventListener('click', function() {
            const stored = localStorage.getItem('selected_auto_id');
            if (stored) {
                const sel = form.querySelector('select[name="auto"]');
                if (sel) sel.value = stored;
            }
            this.style.display = 'none';
            showFormAfterSelection();
        });
    }

    // Botón de usar entrada única
    const useSingle = document.getElementById('use-single');
    if (useSingle) {
        useSingle.addEventListener('click', function() {
            const modelInput = document.getElementById('single-model');
            const yearInput = document.getElementById('single-year');
            const model = modelInput.value.trim();
            const year = yearInput.value.trim();
            if (!model) {
                window.showToast?.({ title: 'Modelo', body: 'Ingrese modelo', variant: 'warning' });
                return;
            }
            const label = model + (year ? (' ('+year+')') : '');
            localStorage.setItem('selected_auto_id', '');
            localStorage.setItem('selected_auto_label', label);
            currentSelection.style.display = 'block';
            selectedDisplay.textContent = label;
            showFormAfterSelection();
        });
    }
    
    // Botón de ingreso manual (barra inferior)
    if (bottomManualEntryBtn) {
        bottomManualEntryBtn.addEventListener('click', function() {
            showManualForm();
        });
    }
    
    // Botón de grabación de voz
    if (recordVoiceBtn) {
        recordVoiceBtn.addEventListener('click', function() {
            if (!isRecording) {
                // Iniciar grabación
                isRecording = true;
                recordVoiceBtn.classList.add('recording');
                recordVoiceBtn.querySelector('.btn-text').textContent = 'Detener';
                recordVoiceBtn.querySelector('i').className = 'fas fa-stop';
                
                // Disparar evento de grabación (se manejará en recorder.js)
                const recordEvent = new Event('startRecording');
                document.dispatchEvent(recordEvent);
            } else {
                // Detener grabación y mostrar estado de cargando
                isRecording = false;
                recordVoiceBtn.classList.remove('recording');
                recordVoiceBtn.classList.add('loading');
                recordVoiceBtn.querySelector('.btn-text').textContent = 'Cargando';
                recordVoiceBtn.querySelector('i').className = 'fas fa-spinner';
                recordVoiceBtn.disabled = true;
                
                // Disparar evento de detener (se manejará en recorder.js)
                const stopEvent = new Event('stopRecording');
                document.dispatchEvent(stopEvent);
            }
        });
    }
    
    // Botón de confirmar datos
    if (confirmDataBtn) {
        confirmDataBtn.addEventListener('click', function() {
            // Validar que haya vehículo seleccionado
            const autoField = form.querySelector('select[name="auto"]');
            if (!autoField || !autoField.value) {
                window.showToast?.({ title: 'Datos incompletos', body: 'Seleccione un vehículo antes de confirmar.', variant: 'warning' });
                return;
            }

            // Usar la ubicación persistente guardada en localStorage
            const persistentWorkshopId = localStorage.getItem('persistent_workshop_id');
            if (!persistentWorkshopId) {
                window.showToast?.({ title: 'Ubicación', body: 'Seleccione su ubicación de trabajo antes de confirmar.', variant: 'warning' });
                return;
            }

            // Asignar el taller al formulario oculto
            const workshopField = form.querySelector('select[name="workshop"]');
            if (workshopField) {
                workshopField.value = persistentWorkshopId;
            }

            // Asegurar valores numéricos por defecto si están vacíos
            const maxValueField = form.querySelector('input[name="max_value"]');
            const minValueField = form.querySelector('input[name="min_value"]');
            if (maxValueField && !maxValueField.value) maxValueField.value = 0;
            if (minValueField && !minValueField.value) minValueField.value = 0;

            // Deshabilitar botón
            confirmDataBtn.disabled = true;
            confirmDataBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Guardando...';
            
            // Enviar vía AJAX
            const formData = new FormData(form);
            
            fetch(form.action, {
                method: 'POST',
                body: formData,
                headers: {
                    'X-Requested-With': 'XMLHttpRequest'
                }
            })
            .then(response => response.json())
            .then(data => {
                if (data.success) {
                    // Mostrar animación de éxito
                    showSuccessAnimation();
                } else {
                    window.showToast?.({ title: 'Error', body: 'Error al guardar la pieza', variant: 'danger' });
                    confirmDataBtn.disabled = false;
                    confirmDataBtn.innerHTML = '<i class="fas fa-check"></i> Confirmar';
                }
            })
            .catch(error => {
                console.error('Error:', error);
                window.showToast?.({ title: 'Error', body: 'Error de conexión al guardar', variant: 'danger' });
                confirmDataBtn.disabled = false;
                confirmDataBtn.innerHTML = '<i class="fas fa-check"></i> Confirmar';
            });
        });
    }
    
    // Función para mostrar animación de éxito
    function showSuccessAnimation() {
        if (!successOverlay) return;
        
        // Mostrar overlay inmediatamente (bloquea la vista para evitar flicker)
        successOverlay.style.display = 'block';
        
        // Fade in en el siguiente frame
        requestAnimationFrame(() => {
            successOverlay.style.opacity = '1';
        });
        
        // Mientras el overlay está opaco, resetear la UI para la siguiente pieza (evita parpadeo)
        setTimeout(() => {
            resetForNextEntry();
        }, 100);
        
        // Mantener el overlay visible y luego desvanecer para total ~1.6s
        setTimeout(() => {
            successOverlay.style.opacity = '0';
        }, 1300);
        
        // Al terminar el fade out, ocultar overlay
        setTimeout(() => {
            successOverlay.style.display = 'none';
        }, 1600);
    }
    
    // Función para resetear la interfaz después de guardar exitosamente
    function resetForNextEntry() {
        // Ocultar resultados
        if (resultsPreview) resultsPreview.style.display = 'none';
        
        // Resetear y mostrar botón de grabación
        if (recordVoiceBtn) {
            recordVoiceBtn.style.display = 'flex';
            recordVoiceBtn.classList.remove('recording', 'loading');
            recordVoiceBtn.querySelector('.btn-text').textContent = 'Grabar';
            recordVoiceBtn.querySelector('i').className = 'fas fa-microphone';
            recordVoiceBtn.disabled = false;
        }
        
        // Resetear estado de grabación
        isRecording = false;
        
        // Limpiar formulario pero mantener auto y workshop
        const nameField = form.querySelector('input[name="name"]');
        const detailsField = form.querySelector('textarea[name="details"], input[name="details"]');
        const maxValueField = form.querySelector('input[name="max_value"]');
        const minValueField = form.querySelector('input[name="min_value"]');
        
        if (nameField) nameField.value = '';
        if (detailsField) detailsField.value = '';
        if (maxValueField) maxValueField.value = 0;
        if (minValueField) minValueField.value = 0;
        
        // Resetear botón de confirmar
        if (confirmDataBtn) {
            confirmDataBtn.disabled = false;
            confirmDataBtn.innerHTML = '<i class="fas fa-check"></i> Confirmar';
        }
        
        // Mostrar interfaz de voz
        if (voiceRecordingInterface) voiceRecordingInterface.style.display = 'block';
    }
    
    // Botón de modificar datos
    if (modifyDataBtn) {
        modifyDataBtn.addEventListener('click', function() {
            // Mostrar el formulario para edición manual
            showManualForm();
        });
    }
    
    // Función global para mostrar resultados (llamada desde recorder.js)
    window.showRecordingResults = function(transcription, extractedData) {
        // Ocultar el botón de grabación
        recordVoiceBtn.style.display = 'none';
        
        // Mostrar resultados
        resultsPreview.style.display = 'block';
            // Ocultar el contenedor del botón para eliminar espacio vacío
            if (recordContainer) {
                recordContainer.style.display = 'none';
                recordContainer.style.minHeight = '0px';
            }
        
        // Ajustar layout y asegurar que la tarjeta quede visible y no tapada por la barra inferior
        adjustRecordingLayout();
        setTimeout(() => {
            try {
                resultsPreview.scrollIntoView({ behavior: 'smooth', block: 'start' });
            } catch (e) {
                // no-op
            }
        }, 50);
        
        // Limpiar la transcripción de marcadores de tiempo y tags especiales
        let cleanTranscription = transcription
            .replace(/\[[\d:.\->]+\]/g, '')  // Eliminar marcadores de tiempo [00:00:00.000 --> 00:00:14.800]
            .replace(/\[_BEG_\]/g, '')        // Eliminar tag [_BEG_]
            .replace(/\[_TT_\d+\]/g, '')      // Eliminar tags [_TT_740], [_TT_38], etc.
            .replace(/\s+/g, ' ')              // Normalizar espacios múltiples
            .trim();                           // Eliminar espacios al inicio y final
        
        // Mostrar transcripción limpia
        document.getElementById('transcription-text').textContent = cleanTranscription;
        
        // Mostrar datos extraídos
        const extractedDataContainer = document.getElementById('extracted-data');
        extractedDataContainer.innerHTML = '';
        
        if (extractedData.parte) {
            extractedDataContainer.innerHTML += `<p><strong>Pieza:</strong> ${extractedData.parte}</p>`;
        }
        if (extractedData.detalles) {
            extractedDataContainer.innerHTML += `<p><strong>Detalles:</strong> ${extractedData.detalles}</p>`;
        }
        if (extractedData.valor) {
            extractedDataContainer.innerHTML += `<p><strong>Valor:</strong> $${extractedData.valor}</p>`;
        }
        
        // Actualizar campos del formulario
        if (extractedData.parte) {
            const nameField = form.querySelector('input[name="name"]');
            if (nameField) nameField.value = extractedData.parte;
        }
        if (extractedData.detalles) {
            const detailsField = form.querySelector('textarea[name="details"], input[name="details"]');
            if (detailsField) detailsField.value = extractedData.detalles;
        }
        if (extractedData.valor) {
            const maxValueField = form.querySelector('input[name="max_value"]');
            const minValueField = form.querySelector('input[name="min_value"]');
            if (maxValueField) maxValueField.value = extractedData.valor;
            if (minValueField) minValueField.value = extractedData.valor;
        }
    };
});