/**
 * app-loading-init.js
 * 
 * Inicialización temprana del overlay de carga.
 * Este script debe cargarse en el <head> para mostrar el overlay
 * lo más rápido posible mientras se cargan los estilos.
 * 
 * IMPORTANTE: Este archivo reemplaza un script inline para
 * compatibilidad con CSP + Turbo SPA navigation.
 * 
 * @see Calidad/PRACTICAS_DESARROLLO.txt - Sección CSP + Turbo
 */
(function() {
  'use strict';
  
  // Marcar que la app está cargando
  document.documentElement.classList.add('app-loading');
  
  // Función global para actualizar la barra de progreso
  window.__setAppLoadingProgress = function(value) {
    var bar = document.querySelector('.app-loading-progress__bar');
    if (!bar) return;
    bar.style.width = Math.max(0, Math.min(100, value)) + '%';
  };
  
  // Progreso inicial
  window.__setAppLoadingProgress(5);
})();
