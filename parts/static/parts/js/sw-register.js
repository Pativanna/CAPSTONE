(function () {
  var logBoot = window.__logBoot || function () {};
  
  // DESHABILITADO TEMPORALMENTE: Service Worker causa problemas con Turbo Frame
  // Los estilos se cachean y causan flash de contenido sin estilos
  logBoot('sw:disabled', { reason: 'turbo-frame-compatibility' });
  
  // Desregistrar service workers existentes
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then(function(registrations) {
      for (let registration of registrations) {
        registration.unregister().then(function(success) {
          if (success) {
            logBoot('sw:unregistered', { scope: registration.scope });
            console.info('[sw] desregistrado', registration.scope);
          }
        });
      }
    }).catch(function(err) {
      console.warn('[sw] error al desregistrar', err);
    });
  }
  
  return; // Early exit - no registrar SW
  
  /* CÓDIGO ORIGINAL DESHABILITADO
  if (!('serviceWorker' in navigator)) {
    logBoot('sw:unsupported');
    return;
  }
  
  function register() {
    logBoot('sw:register:start');
    navigator.serviceWorker.register('/service-worker.js', { scope: '/' })
      .then((registration) => {
        logBoot('sw:register:success', { scope: registration.scope });
        console.info('[sw] registrado', registration.scope);
        
        // Auto-actualización: verificar cada hora
        setInterval(() => {
          registration.update().catch((err) => {
            console.warn('[sw] error al verificar actualizaciones', err);
          });
        }, 60 * 60 * 1000);
        
        // Actualizar inmediatamente si hay nueva versión esperando
        registration.addEventListener('updatefound', () => {
          const newWorker = registration.installing;
          if (!newWorker) return;
          
          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              console.info('[sw] nueva versión disponible, recargando...');
              // Mostrar notificación si está disponible
              if (window.showToast) {
                window.showToast({
                  title: 'Actualización disponible',
                  body: 'Recargando para aplicar cambios...',
                  variant: 'info',
                  delay: 2000
                });
              }
              // Recargar después de 2 segundos
              setTimeout(() => {
                window.location.reload();
              }, 2000);
            }
          });
        });
      })
      .catch((error) => {
        logBoot('sw:register:error', { message: error && error.message });
        console.warn('[sw] error', error);
      });
  }
  
  // Escuchar mensajes del service worker
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SW_UPDATED') {
      console.info('[sw] actualizado, recargando página...');
      window.location.reload();
    }
  });
  
  window.addEventListener('load', register);
  */
})();
