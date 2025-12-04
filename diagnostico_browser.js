// SCRIPT DE DIAGNÓSTICO - Pega esto en la consola del navegador (F12)
(function() {
  console.log('=== DIAGNÓSTICO DE CARGA ===');
  
  // 1. Verificar overlay
  const overlay = document.getElementById('app-loading-overlay');
  console.log('Overlay existe:', !!overlay);
  if (overlay) {
    console.log('Overlay visible:', !overlay.classList.contains('is-hidden'));
    console.log('Overlay classes:', overlay.className);
  }
  
  // 2. Verificar CSS cargados
  const links = document.querySelectorAll('link[rel="stylesheet"]');
  console.log('\n=== CSS ENCONTRADOS (' + links.length + ') ===');
  links.forEach((link, i) => {
    const loaded = link.sheet && link.sheet.cssRules && link.sheet.cssRules.length > 0;
    console.log((i+1) + '.', link.href.split('/').slice(-2).join('/'), 
                '- Cargado:', loaded, 
                '- Watch:', link.dataset.styleWatch,
                '- Rules:', link.sheet ? link.sheet.cssRules.length : 0);
  });
  
  // 3. Verificar scripts
  const scripts = document.querySelectorAll('script[src]');
  console.log('\n=== SCRIPTS EXTERNOS (' + scripts.length + ') ===');
  scripts.forEach((script, i) => {
    console.log((i+1) + '.', script.src.split('/').slice(-2).join('/'));
  });
  
  // 4. Verificar BootLog
  if (window.__getBootLog) {
    const log = window.__getBootLog();
    console.log('\n=== BOOT LOG (últimos 10) ===');
    log.slice(-10).forEach(entry => {
      console.log(new Date(entry.ts).toISOString().split('T')[1].slice(0, 12), 
                  entry.event, 
                  entry.detail || '');
    });
  } else {
    console.log('\n⚠️ BootLog no disponible');
  }
  
  // 5. Verificar errores de CSP
  console.log('\n=== VERIFICAR EN LA PESTAÑA CONSOLE ===');
  console.log('Busca errores de tipo:');
  console.log('- "Content Security Policy"');
  console.log('- "Refused to load"');
  console.log('- "net::ERR_"');
  
  // 6. Estado del DOM
  console.log('\n=== ESTADO DEL DOM ===');
  console.log('Body classes:', document.body.className);
  console.log('HTML classes:', document.documentElement.className);
  console.log('Turbo frame existe:', !!document.getElementById('app-frame'));
  
  console.log('\n=== FIN DIAGNÓSTICO ===');
})();
