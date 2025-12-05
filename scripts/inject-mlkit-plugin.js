#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const pluginsJsonPath = path.join(__dirname, '../android/app/src/main/assets/capacitor.plugins.json');

const pluginEntry = {
  pkg: 'com.carinventory.app',
  classpath: 'com.carinventory.app.MLKitScannerPlugin'
};

// Leer archivo existente
let plugins = [];
if (fs.existsSync(pluginsJsonPath)) {
  const content = fs.readFileSync(pluginsJsonPath, 'utf8');
  try {
    plugins = JSON.parse(content);
  } catch (e) {
    console.warn('capacitor.plugins.json inválido, creando nuevo');
  }
}

// Verificar si ya existe
const exists = plugins.some(p => p.classpath === pluginEntry.classpath);

if (!exists) {
  plugins.push(pluginEntry);
  fs.writeFileSync(pluginsJsonPath, JSON.stringify(plugins, null, 2));
  console.log('✅ MLKitScannerPlugin agregado a capacitor.plugins.json');
} else {
  console.log('✅ MLKitScannerPlugin ya existe en capacitor.plugins.json');
}
