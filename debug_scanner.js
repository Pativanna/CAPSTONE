// DIAGNÓSTICO ESPECÍFICO DEL VERIFICADOR - Pega en consola del navegador
console.clear();
console.log('=== DIAGNÓSTICO VERIFICADOR ===\n');

// 1. Verificar que estamos en la URL correcta
console.log('1. URL:', window.location.pathname);

// 2. Verificar turbo-frame
const frame = document.getElementById('app-frame');
console.log('2. Turbo frame existe:', !!frame);
if (frame) {
  console.log('   - Frame complete:', frame.hasAttribute('complete'));
  console.log('   - Frame src:', frame.getAttribute('src'));
}

// 3. Verificar elementos del DOM
const scannerPage = document.getElementById('scanner-page');
console.log('3. scanner-page existe:', !!scannerPage);
if (scannerPage) {
  console.log('   - Visible:', window.getComputedStyle(scannerPage).display !== 'none');
  console.log('   - CSS display:', window.getComputedStyle(scannerPage).display);
  console.log('   - Clases:', scannerPage.className);
}

// 4. Verificar CSS cargados
const cssLinks = Array.from(document.querySelectorAll('link[rel="stylesheet"]'));
const scanVerifyCSS = cssLinks.find(link => link.href.includes('scan-verify'));
console.log('4. scan-verify.css cargado:', !!scanVerifyCSS);
if (scanVerifyCSS) {
  console.log('   - URL:', scanVerifyCSS.href);
  console.log('   - Sheet cargado:', !!scanVerifyCSS.sheet);
  console.log('   - Rules:', scanVerifyCSS.sheet ? scanVerifyCSS.sheet.cssRules.length : 0);
}

// 5. Verificar scripts cargados
const scripts = Array.from(document.querySelectorAll('script[src]'));
const scanVerifyJS = scripts.find(s => s.src.includes('scan-verify'));
console.log('5. scan-verify.js cargado:', !!scanVerifyJS);
if (scanVerifyJS) {
  console.log('   - URL:', scanVerifyJS.src);
}

// 6. Verificar overlay de loading
const overlay = document.getElementById('app-loading-overlay');
console.log('6. Loading overlay existe:', !!overlay);
if (overlay) {
  console.log('   - Visible:', !overlay.classList.contains('is-hidden'));
  console.log('   - Clases:', overlay.className);
  console.log('   - Display:', window.getComputedStyle(overlay).display);
  console.log('   - Opacity:', window.getComputedStyle(overlay).opacity);
}

// 7. Verificar JSON de datos iniciales
const dataScript = document.getElementById('scan-initial-parts');
console.log('7. scan-initial-parts existe:', !!dataScript);
if (dataScript) {
  try {
    const data = JSON.parse(dataScript.textContent);
    console.log('   - Piezas cargadas:', data.length);
  } catch (e) {
    console.log('   - ERROR parseando JSON:', e.message);
  }
}

// 8. Verificar errores en consola
console.log('\n8. Revisa arriba si hay errores en rojo');

console.log('\n=== FIN DIAGNÓSTICO ===');
console.log('Si overlay.visible = true, el problema es que no se oculta.');
console.log('Si scanner-page no existe, Turbo no cargó el contenido.');
console.log('Si CSS rules = 0, el archivo no se descargó correctamente.');
