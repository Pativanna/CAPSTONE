/**
 * Scanner Feedback Module
 * Maneja vibraciones, sonidos y animaciones para feedback de detección
 */

// Prevenir doble inicialización
if (typeof window.ScannerFeedback === 'undefined') {

class ScannerFeedback {
  constructor() {
    this.audioContext = null;
    this.initialized = false;
    this.init();
  }
  
  init() {
    // Inicializar Web Audio API para beeps
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (AudioContext) {
        this.audioContext = new AudioContext();
        this.initialized = true;
        console.log('[ScannerFeedback] Audio context initialized');
      }
    } catch (e) {
      console.warn('[ScannerFeedback] Audio not available:', e);
    }
  }
  
  /**
   * Vibrar el dispositivo
   * @param {number|number[]} pattern - Duración o patrón [vibrate, pause, vibrate, ...]
   */
  vibrate(pattern) {
    if (!navigator.vibrate) {
      console.warn('[ScannerFeedback] Vibration API not supported');
      return;
    }
    
    try {
      navigator.vibrate(pattern);
    } catch (e) {
      console.warn('[ScannerFeedback] Vibration error:', e);
    }
  }
  
  /**
   * Reproducir beep
   * @param {number} frequency - Frecuencia en Hz (ej: 800, 600)
   * @param {number} duration - Duración en ms
   */
  async playBeep(frequency = 800, duration = 100) {
    if (!this.audioContext) return;
    
    try {
      // Resume context si está suspendido (política de navegadores)
      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
      }
      
      const oscillator = this.audioContext.createOscillator();
      const gainNode = this.audioContext.createGain();
      
      oscillator.connect(gainNode);
      gainNode.connect(this.audioContext.destination);
      
      oscillator.frequency.value = frequency;
      oscillator.type = 'sine';
      
      // Envelope para evitar clicks
      const now = this.audioContext.currentTime;
      gainNode.gain.setValueAtTime(0, now);
      gainNode.gain.linearRampToValueAtTime(0.3, now + 0.01);
      gainNode.gain.exponentialRampToValueAtTime(0.01, now + duration / 1000);
      
      oscillator.start(now);
      oscillator.stop(now + duration / 1000);
      
    } catch (e) {
      console.warn('[ScannerFeedback] Beep error:', e);
    }
  }
  
  /**
   * Feedback para MISMATCH
   * - 1 vibración larga (300ms)
   * - 1 beep grave (600Hz)
   */
  async mismatch() {
    console.log('[ScannerFeedback] MISMATCH feedback');
    
    // Vibración: 1 larga
    this.vibrate(300);
    
    // Beep: 1 grave
    await this.playBeep(600, 200);
  }
  
  /**
   * Feedback para MATCH
   * - 2 vibraciones cortas (100ms, pausa 100ms, 100ms)
   * - 2 beeps agudos (800Hz)
   */
  async match() {
    console.log('[ScannerFeedback] MATCH feedback');
    
    // Vibraciones: 2 cortas
    // Patrón: [vibrate, pause, vibrate]
    this.vibrate([100, 100, 100]);
    
    // Beeps: 2 agudos
    await this.playBeep(800, 100);
    setTimeout(() => this.playBeep(900, 100), 150);
  }
  
  /**
   * Animación de bordes verdes para match exitoso
   */
  flashGreenBorders() {
    // Crear overlay temporal si no existe
    let overlay = document.getElementById('scanner-success-overlay');
    
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'scanner-success-overlay';
      overlay.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        pointer-events: none;
        z-index: 9999;
        border: 8px solid rgba(34, 197, 94, 0);
        box-shadow: inset 0 0 40px rgba(34, 197, 94, 0);
        transition: all 0.3s ease-out;
      `;
      document.body.appendChild(overlay);
    }
    
    // Trigger animación
    requestAnimationFrame(() => {
      overlay.style.borderColor = 'rgba(34, 197, 94, 0.9)';
      overlay.style.boxShadow = 'inset 0 0 40px rgba(34, 197, 94, 0.6)';
      
      // Fade out después de 500ms
      setTimeout(() => {
        overlay.style.borderColor = 'rgba(34, 197, 94, 0)';
        overlay.style.boxShadow = 'inset 0 0 40px rgba(34, 197, 94, 0)';
      }, 500);
    });
  }
  
  /**
   * Feedback completo para match: vibraciones + beeps + animación verde
   */
  async triggerMatch() {
    this.flashGreenBorders();
    await this.match();
  }
  
  /**
   * Feedback completo para mismatch: vibración + beep
   */
  async triggerMismatch() {
    await this.mismatch();
  }
}

// Crear instancia global
if (!window.scannerFeedback) {
  window.scannerFeedback = new ScannerFeedback();
}

} // Fin de prevención de doble inicialización

console.log('[ScannerFeedback] Module loaded');
