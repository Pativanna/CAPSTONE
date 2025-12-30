/**
 * Web Worker para búsqueda de piezas en segundo plano.
 * 
 * Este worker implementa búsqueda O(1) mediante índice invertido,
 * liberando el hilo principal de la UI para mantener 60fps.
 * 
 * Cumple con:
 * - ISO/IEC 25010: Eficiencia de desempeño (tiempo de respuesta)
 * - ISO 9241-171: Usabilidad (respuesta inmediata al usuario)
 * 
 * @author Sistema Automatizado
 * @version 2.0.0
 * @since 2025-12-30
 */

'use strict';

/**
 * Estado interno del worker
 */
const WorkerState = {
  parts: [],
  invertedIndex: new Map(),
  barcodeIndex: new Map(),
  idIndex: new Map(),
  version: null,
  ready: false
};

/**
 * Configuración de búsqueda
 */
const SearchConfig = {
  MIN_TERM_LENGTH: 1,
  MAX_RESULTS: 20,
  SCORE_BARCODE_PREFIX: 15,
  SCORE_BARCODE_EXACT: 20,
  SCORE_FULL_MATCH: 8,
  SCORE_TOKEN_HIT: 2,
  SCORE_NAME_PRIORITY: 3,
  NGRAM_SIZE: 3
};

/**
 * Normaliza texto para búsqueda (elimina acentos, minúsculas).
 * Implementación optimizada sin regex costosos.
 * 
 * @param {string} value - Texto a normalizar
 * @returns {string} Texto normalizado
 */
function normalizeForSearch(value) {
  if (!value) return '';
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * Genera n-gramas de un texto para búsqueda fuzzy.
 * 
 * @param {string} text - Texto fuente
 * @param {number} n - Tamaño del n-grama
 * @returns {Set<string>} Set de n-gramas únicos
 */
function generateNgrams(text, n = SearchConfig.NGRAM_SIZE) {
  const ngrams = new Set();
  if (!text || text.length < n) {
    if (text) ngrams.add(text);
    return ngrams;
  }
  for (let i = 0; i <= text.length - n; i++) {
    ngrams.add(text.substring(i, i + n));
  }
  return ngrams;
}

/**
 * Tokeniza texto en palabras significativas.
 * 
 * @param {string} text - Texto a tokenizar
 * @returns {string[]} Array de tokens
 */
function tokenize(text) {
  if (!text) return [];
  return text.split(/\s+/).filter(token => token.length >= SearchConfig.MIN_TERM_LENGTH);
}

/**
 * Construye índice invertido para búsqueda O(1).
 * 
 * Estructura del índice:
 * - invertedIndex: Map<token, Set<partId>>
 * - barcodeIndex: Map<barcode, partId>
 * - idIndex: Map<partId, partObject>
 * 
 * @param {Array} parts - Array de piezas
 */
function buildIndex(parts) {
  console.time('[SearchWorker] buildIndex');
  
  WorkerState.invertedIndex.clear();
  WorkerState.barcodeIndex.clear();
  WorkerState.idIndex.clear();
  
  const invertedIndex = WorkerState.invertedIndex;
  const barcodeIndex = WorkerState.barcodeIndex;
  const idIndex = WorkerState.idIndex;
  
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const partId = part.id;
    
    // Índice por ID para lookup O(1)
    idIndex.set(partId, part);
    
    // Índice por código de barras
    const barcode = (part.barcode || '').toLowerCase();
    if (barcode) {
      barcodeIndex.set(barcode, partId);
      // También indexamos prefijos del código de barras
      for (let len = 1; len <= barcode.length; len++) {
        const prefix = barcode.substring(0, len);
        if (!invertedIndex.has(prefix)) {
          invertedIndex.set(prefix, new Set());
        }
        invertedIndex.get(prefix).add(partId);
      }
    }
    
    // Construir texto combinado normalizado
    const nameNorm = normalizeForSearch(part.name || '');
    const autoNorm = normalizeForSearch(part.auto || '');
    const yearNorm = normalizeForSearch(part.auto_year || '');
    const workshopNorm = normalizeForSearch(part.workshop || '');
    
    // Guardar normalizados en el objeto para scoring
    part._normalized = `${nameNorm} ${autoNorm} ${yearNorm}`;
    part._nameNorm = nameNorm;
    part._barcode = barcode;
    
    // Tokenizar e indexar cada campo
    const allTokens = new Set([
      ...tokenize(nameNorm),
      ...tokenize(autoNorm),
      ...tokenize(yearNorm),
      ...tokenize(workshopNorm)
    ]);
    
    // Indexar tokens completos
    for (const token of allTokens) {
      if (!invertedIndex.has(token)) {
        invertedIndex.set(token, new Set());
      }
      invertedIndex.get(token).add(partId);
      
      // También indexamos n-gramas para búsqueda parcial
      const ngrams = generateNgrams(token);
      for (const ngram of ngrams) {
        if (!invertedIndex.has(ngram)) {
          invertedIndex.set(ngram, new Set());
        }
        invertedIndex.get(ngram).add(partId);
      }
    }
  }
  
  console.timeEnd('[SearchWorker] buildIndex');
  console.log(`[SearchWorker] Indexed ${parts.length} parts, ${invertedIndex.size} terms`);
}

/**
 * Busca piezas usando el índice invertido.
 * 
 * Algoritmo:
 * 1. Normalizar término de búsqueda
 * 2. Buscar coincidencias exactas de código de barras
 * 3. Tokenizar y buscar en índice invertido
 * 4. Calcular scores y ordenar resultados
 * 
 * @param {string} term - Término de búsqueda
 * @param {number} limit - Máximo de resultados
 * @returns {Array} Piezas ordenadas por relevancia
 */
function search(term, limit = SearchConfig.MAX_RESULTS) {
  if (!WorkerState.ready || !WorkerState.parts.length) {
    return [];
  }
  
  const normalized = normalizeForSearch(term);
  if (!normalized) {
    // Sin término, devolver las más recientes
    return WorkerState.parts.slice(0, limit);
  }
  
  const stripped = normalized.replace(/\s+/g, '');
  const tokens = tokenize(normalized);
  const candidateScores = new Map();
  
  // 1. Búsqueda por código de barras (mayor prioridad)
  if (stripped && WorkerState.barcodeIndex.has(stripped)) {
    const partId = WorkerState.barcodeIndex.get(stripped);
    candidateScores.set(partId, SearchConfig.SCORE_BARCODE_EXACT);
  }
  
  // 2. Búsqueda por prefijo de código de barras
  if (stripped) {
    const barcodeMatches = WorkerState.invertedIndex.get(stripped);
    if (barcodeMatches) {
      for (const partId of barcodeMatches) {
        const part = WorkerState.idIndex.get(partId);
        if (part && part._barcode && part._barcode.startsWith(stripped)) {
          const currentScore = candidateScores.get(partId) || 0;
          candidateScores.set(partId, currentScore + SearchConfig.SCORE_BARCODE_PREFIX);
        }
      }
    }
  }
  
  // 3. Búsqueda por tokens en índice invertido
  for (const token of tokens) {
    const matches = WorkerState.invertedIndex.get(token);
    if (matches) {
      for (const partId of matches) {
        const currentScore = candidateScores.get(partId) || 0;
        candidateScores.set(partId, currentScore + SearchConfig.SCORE_TOKEN_HIT);
      }
    }
    
    // También buscar n-gramas si el token es corto
    if (token.length >= SearchConfig.NGRAM_SIZE) {
      const ngrams = generateNgrams(token);
      for (const ngram of ngrams) {
        const ngramMatches = WorkerState.invertedIndex.get(ngram);
        if (ngramMatches) {
          for (const partId of ngramMatches) {
            const currentScore = candidateScores.get(partId) || 0;
            // Los n-gramas dan menos puntos que tokens completos
            candidateScores.set(partId, currentScore + 0.5);
          }
        }
      }
    }
  }
  
  // 4. Refinar scores con coincidencia en texto completo
  for (const [partId, baseScore] of candidateScores) {
    const part = WorkerState.idIndex.get(partId);
    if (!part) continue;
    
    let finalScore = baseScore;
    
    // Bonus por coincidencia completa del término
    if (part._normalized && part._normalized.includes(normalized)) {
      finalScore += SearchConfig.SCORE_FULL_MATCH;
    }
    
    // Bonus por coincidencia en nombre (campo prioritario)
    if (part._nameNorm && part._nameNorm.includes(normalized)) {
      finalScore += SearchConfig.SCORE_NAME_PRIORITY;
    }
    
    candidateScores.set(partId, finalScore);
  }
  
  // 5. Ordenar por score descendente, luego por ID
  const results = Array.from(candidateScores.entries())
    .filter(([_, score]) => score > 0)
    .sort((a, b) => {
      const scoreDiff = b[1] - a[1];
      if (scoreDiff !== 0) return scoreDiff;
      return a[0] - b[0]; // IDs más bajos primero (más antiguos)
    })
    .slice(0, limit)
    .map(([partId]) => WorkerState.idIndex.get(partId))
    .filter(Boolean);
  
  return results;
}

/**
 * Maneja mensajes desde el hilo principal.
 * 
 * Comandos soportados:
 * - LOAD: Cargar datos y construir índice
 * - SEARCH: Ejecutar búsqueda
 * - UPDATE_ENTRY: Actualizar una pieza en el índice
 * - CLEAR: Limpiar índice
 * - STATUS: Obtener estado del worker
 */
self.onmessage = function(event) {
  const { type, payload, requestId } = event.data;
  
  switch (type) {
    case 'LOAD': {
      try {
        const { parts, version } = payload;
        WorkerState.parts = parts || [];
        WorkerState.version = version || null;
        buildIndex(WorkerState.parts);
        WorkerState.ready = true;
        
        self.postMessage({
          type: 'LOAD_COMPLETE',
          requestId,
          payload: {
            success: true,
            count: WorkerState.parts.length,
            indexSize: WorkerState.invertedIndex.size,
            version: WorkerState.version
          }
        });
      } catch (error) {
        self.postMessage({
          type: 'ERROR',
          requestId,
          payload: {
            message: error.message,
            command: 'LOAD'
          }
        });
      }
      break;
    }
    
    case 'SEARCH': {
      try {
        const { term, limit } = payload;
        const startTime = performance.now();
        const results = search(term, limit);
        const duration = performance.now() - startTime;
        
        self.postMessage({
          type: 'SEARCH_RESULTS',
          requestId,
          payload: {
            results,
            term,
            count: results.length,
            duration: Math.round(duration * 100) / 100
          }
        });
      } catch (error) {
        self.postMessage({
          type: 'ERROR',
          requestId,
          payload: {
            message: error.message,
            command: 'SEARCH'
          }
        });
      }
      break;
    }
    
    case 'UPDATE_ENTRY': {
      try {
        const { partId, updates } = payload;
        const part = WorkerState.idIndex.get(partId);
        if (part) {
          if (typeof updates === 'function') {
            updates(part);
          } else if (updates && typeof updates === 'object') {
            Object.assign(part, updates);
          }
          // Re-indexar solo esta pieza sería ideal, pero por simplicidad
          // reconstruimos el índice (para actualizaciones frecuentes
          // se podría optimizar con índice incremental)
          buildIndex(WorkerState.parts);
        }
        
        self.postMessage({
          type: 'UPDATE_COMPLETE',
          requestId,
          payload: { success: true, partId }
        });
      } catch (error) {
        self.postMessage({
          type: 'ERROR',
          requestId,
          payload: {
            message: error.message,
            command: 'UPDATE_ENTRY'
          }
        });
      }
      break;
    }
    
    case 'CLEAR': {
      WorkerState.parts = [];
      WorkerState.invertedIndex.clear();
      WorkerState.barcodeIndex.clear();
      WorkerState.idIndex.clear();
      WorkerState.version = null;
      WorkerState.ready = false;
      
      self.postMessage({
        type: 'CLEAR_COMPLETE',
        requestId,
        payload: { success: true }
      });
      break;
    }
    
    case 'STATUS': {
      self.postMessage({
        type: 'STATUS_RESPONSE',
        requestId,
        payload: {
          ready: WorkerState.ready,
          partsCount: WorkerState.parts.length,
          indexSize: WorkerState.invertedIndex.size,
          version: WorkerState.version
        }
      });
      break;
    }
    
    default:
      self.postMessage({
        type: 'ERROR',
        requestId,
        payload: {
          message: `Comando desconocido: ${type}`,
          command: type
        }
      });
  }
};

// Notificar que el worker está listo
self.postMessage({ type: 'WORKER_READY' });
