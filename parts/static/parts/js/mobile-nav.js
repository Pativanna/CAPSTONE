/**
 * Mobile Navigation System - JavaScript
 * Mega Menu con animaciones slide + Bottom Nav active state
 * 
 * ISO 9241-171: Accesibilidad
 * Patrón Turbo compatible (ver PRACTICAS_DESARROLLO.txt)
 */
(function() {
  'use strict';

  let initialized = false;

  function onReady(callback) {
    const fire = () => {
      if (!document.getElementById('mega-menu')) return;
      callback();
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fire, { once: true });
    } else {
      fire();
    }
    document.addEventListener('page:ready', fire);
    document.addEventListener('turbo:load', fire);
    document.addEventListener('turbo:render', fire);
  }

  function init() {
    if (initialized) return;
    initialized = true;

    const megaMenu = document.getElementById('mega-menu');
    const megaOverlay = document.getElementById('mega-menu-overlay');
    const megaTrigger = document.getElementById('mega-menu-trigger');
    const megaClose = document.getElementById('mega-menu-close');
    const bottomNav = document.querySelector('.bottom-nav');

    if (!megaMenu || !megaTrigger) return;

    // ==========================================================================
    // MEGA MENU - Abrir/Cerrar
    // ==========================================================================
    
    function openMegaMenu() {
      megaMenu.classList.add('active');
      megaMenu.setAttribute('aria-hidden', 'false');
      if (megaOverlay) {
        megaOverlay.classList.add('active');
        megaOverlay.setAttribute('aria-hidden', 'false');
      }
      megaTrigger.setAttribute('aria-expanded', 'true');
      document.body.style.overflow = 'hidden';
      
      // Focus trap - enfocar el primer elemento
      setTimeout(() => {
        const firstFocusable = megaMenu.querySelector('button, a');
        if (firstFocusable) firstFocusable.focus();
      }, 100);
    }

    function closeMegaMenu() {
      megaMenu.classList.remove('active');
      megaMenu.setAttribute('aria-hidden', 'true');
      if (megaOverlay) {
        megaOverlay.classList.remove('active');
        megaOverlay.setAttribute('aria-hidden', 'true');
      }
      megaTrigger.setAttribute('aria-expanded', 'false');
      document.body.style.overflow = '';
      
      // Resetear al panel principal
      resetToMainPanel();
    }

    function toggleMegaMenu() {
      if (megaMenu.classList.contains('active')) {
        closeMegaMenu();
      } else {
        openMegaMenu();
      }
    }

    // Event listeners para abrir/cerrar
    megaTrigger.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleMegaMenu();
    });

    if (megaClose) {
      megaClose.addEventListener('click', closeMegaMenu);
    }

    if (megaOverlay) {
      megaOverlay.addEventListener('click', closeMegaMenu);
    }

    // Escape cierra el menu
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && megaMenu.classList.contains('active')) {
        closeMegaMenu();
      }
    });

    // ==========================================================================
    // MEGA MENU - Navegación entre paneles (slide animation)
    // ==========================================================================
    
    const mainPanel = document.getElementById('mega-panel-main');
    const subPanels = megaMenu.querySelectorAll('.mega-menu__panel--sub');
    let currentSubPanel = null;

    function showSubPanel(panelId) {
      const targetPanel = document.getElementById(panelId);
      if (!targetPanel || !mainPanel) return;

      // Ocultar panel principal
      mainPanel.classList.add('hidden');

      // Ocultar otros sub-paneles
      subPanels.forEach(panel => {
        if (panel.id !== panelId) {
          panel.classList.remove('active');
        }
      });

      // Mostrar el panel objetivo
      targetPanel.classList.add('active');
      currentSubPanel = targetPanel;

      // Focus en el botón de volver
      setTimeout(() => {
        const backBtn = targetPanel.querySelector('.mega-menu__back');
        if (backBtn) backBtn.focus();
      }, 100);
    }

    function resetToMainPanel() {
      if (mainPanel) {
        mainPanel.classList.remove('hidden');
      }
      subPanels.forEach(panel => {
        panel.classList.remove('active');
      });
      currentSubPanel = null;
    }

    // Click en categorías para navegar a sub-paneles
    const categoryButtons = megaMenu.querySelectorAll('.mega-menu__category[data-target]');
    categoryButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        const targetId = btn.getAttribute('data-target');
        if (targetId) {
          showSubPanel(targetId);
        }
      });
    });

    // Click en botones "Atrás" para volver al panel principal
    const backButtons = megaMenu.querySelectorAll('.mega-menu__back[data-back]');
    backButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        resetToMainPanel();
        // Focus en la categoría que abrió este panel
        setTimeout(() => {
          const firstCategory = mainPanel.querySelector('.mega-menu__category');
          if (firstCategory) firstCategory.focus();
        }, 100);
      });
    });

    // Cerrar mega menu al hacer click en un enlace
    const megaLinks = megaMenu.querySelectorAll('a[href]');
    megaLinks.forEach(link => {
      link.addEventListener('click', () => {
        closeMegaMenu();
      });
    });

    // ==========================================================================
    // MEGA MENU - Toggles de preferencias
    // ==========================================================================
    
    function syncPreferenceToggles() {
      // Sincronizar tema
      const megaThemeToggle = document.getElementById('mega-theme-toggle');
      if (megaThemeToggle) {
        const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        megaThemeToggle.setAttribute('aria-pressed', isDark ? 'true' : 'false');
        
        megaThemeToggle.addEventListener('click', () => {
          const currentlyDark = document.documentElement.getAttribute('data-theme') === 'dark';
          const newTheme = currentlyDark ? 'light' : 'dark';
          document.documentElement.setAttribute('data-theme', newTheme);
          try { localStorage.setItem('theme', newTheme); } catch(e) {}
          megaThemeToggle.setAttribute('aria-pressed', !currentlyDark ? 'true' : 'false');
          
          // Sincronizar con el toggle del navbar desktop
          const desktopToggle = document.getElementById('theme-toggle');
          if (desktopToggle) {
            desktopToggle.setAttribute('aria-pressed', !currentlyDark ? 'true' : 'false');
          }
        });
      }

      // Sincronizar beep toggle
      const megaBeepToggle = document.getElementById('mega-beep-toggle');
      if (megaBeepToggle) {
        let beepEnabled = false;
        try { beepEnabled = localStorage.getItem('beepEnabled') === 'true'; } catch(e) {}
        megaBeepToggle.setAttribute('aria-pressed', beepEnabled ? 'true' : 'false');
        
        megaBeepToggle.addEventListener('click', () => {
          const current = megaBeepToggle.getAttribute('aria-pressed') === 'true';
          const newVal = !current;
          megaBeepToggle.setAttribute('aria-pressed', newVal ? 'true' : 'false');
          try { localStorage.setItem('beepEnabled', newVal ? 'true' : 'false'); } catch(e) {}
          
          // Disparar evento para que otros componentes se enteren
          document.dispatchEvent(new CustomEvent('beep:toggle', { detail: { enabled: newVal } }));
        });
      }

      // Sincronizar transcription toggle
      const megaTranscriptionToggle = document.getElementById('mega-transcription-toggle');
      if (megaTranscriptionToggle) {
        let cloudEnabled = true;
        try { cloudEnabled = localStorage.getItem('transcriptionMode') !== 'local'; } catch(e) {}
        megaTranscriptionToggle.setAttribute('aria-pressed', cloudEnabled ? 'true' : 'false');
        
        megaTranscriptionToggle.addEventListener('click', () => {
          const current = megaTranscriptionToggle.getAttribute('aria-pressed') === 'true';
          const newMode = current ? 'local' : 'cloud';
          megaTranscriptionToggle.setAttribute('aria-pressed', !current ? 'true' : 'false');
          try { localStorage.setItem('transcriptionMode', newMode); } catch(e) {}
          
          // Disparar evento
          document.dispatchEvent(new CustomEvent('transcription:mode', { detail: { mode: newMode } }));
        });
      }
    }

    syncPreferenceToggles();

    // ==========================================================================
    // BOTTOM NAV - Estado activo
    // ==========================================================================
    
    function updateBottomNavActive() {
      if (!bottomNav) return;

      const currentPath = window.location.pathname;
      const currentSearch = window.location.search;
      const navItems = bottomNav.querySelectorAll('.bottom-nav__item');

      // Primero, remover active de todos
      navItems.forEach(item => {
        item.classList.remove('active');
        item.removeAttribute('aria-current');
      });

      // Determinar qué item debe estar activo basado en data-nav-id
      let activeNavId = null;

      // Mapeo de paths a nav-ids (ordenado de más específico a menos específico)
      const pathMappings = [
        // Voz: /parts/ con ?voice=1
        { navId: 'voz', test: () => currentPath === '/parts/' && currentSearch.includes('voice=1') },
        // Agregar: /parts/add/ exacto
        { navId: 'agregar', test: () => currentPath === '/parts/add/' },
        // Lector/Verificador: cualquier path que empiece con /verificador/
        { navId: 'lector', test: () => currentPath.startsWith('/verificador') },
        // Repuestos: /parts/ exacto SIN voice param, o cualquier /parts/* excepto /parts/add/
        { navId: 'repuestos', test: () => {
          if (currentPath === '/parts/' && !currentSearch.includes('voice=1')) return true;
          if (currentPath.startsWith('/parts/') && currentPath !== '/parts/add/') return true;
          return false;
        }},
        // Inicio/Dashboard: /dashboard/ o raíz /
        { navId: 'inicio', test: () => currentPath === '/dashboard/' || currentPath === '/' },
      ];

      // Encontrar el primer match
      for (const mapping of pathMappings) {
        if (mapping.test()) {
          activeNavId = mapping.navId;
          break;
        }
      }

      // Aplicar clase active al item correspondiente
      if (activeNavId) {
        const activeItem = bottomNav.querySelector(`[data-nav-id="${activeNavId}"]`);
        if (activeItem) {
          activeItem.classList.add('active');
          activeItem.setAttribute('aria-current', 'page');
        }
      }
    }

    updateBottomNavActive();

    // Actualizar al navegar con Turbo
    document.addEventListener('turbo:load', updateBottomNavActive);
    document.addEventListener('turbo:render', updateBottomNavActive);

    // ==========================================================================
    // TURBO INTEGRATION - Cerrar mega menu al navegar
    // ==========================================================================
    
    document.addEventListener('turbo:before-visit', () => {
      if (megaMenu.classList.contains('active')) {
        closeMegaMenu();
      }
    });

    // ==========================================================================
    // EXPONER FUNCIONES GLOBALMENTE (para back button handler)
    // ==========================================================================
    
    window.__megaMenu = {
      open: openMegaMenu,
      close: closeMegaMenu,
      toggle: toggleMegaMenu,
      isOpen: () => megaMenu.classList.contains('active')
    };
  }

  function cleanup() {
    initialized = false;
    if (window.__megaMenu) {
      delete window.__megaMenu;
    }
  }

  onReady(init);
  document.addEventListener('turbo:before-render', cleanup);
  document.addEventListener('turbo:before-cache', cleanup);
})();
