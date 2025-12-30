/**
 * Módulo de almacenamiento con IndexedDB para catálogo de piezas.
 * 
 * IndexedDB proporciona almacenamiento asíncrono que no bloquea el hilo principal,
 * a diferencia de localStorage que es síncrono y puede causar jank.
 * 
 * Cumple con:
 * - ISO/IEC 25010: Eficiencia de desempeño (no bloquea UI)
 * - ISO/IEC 27001: Datos almacenados localmente sin transmisión innecesaria
 * 
 * @author Sistema Automatizado
 * @version 1.0.0
 * @since 2025-12-30
 */

(function() {
  'use strict';

  const DB_NAME = 'parts-catalog-db';
  const DB_VERSION = 1;
  const STORE_NAME = 'catalog';
  const CACHE_KEY = 'main-catalog';

  /**
   * Abre la conexión a IndexedDB.
   * 
   * @returns {Promise<IDBDatabase>} Promesa con la conexión
   */
  function openDatabase() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        reject(new Error('IndexedDB no soportado'));
        return;
      }

      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => {
        console.warn('[CatalogDB] Error abriendo DB:', request.error);
        reject(request.error);
      };

      request.onsuccess = () => {
        resolve(request.result);
      };

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        
        // Crear object store si no existe
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'key' });
          console.log('[CatalogDB] Store creado');
        }
      };
    });
  }

  /**
   * Guarda datos en IndexedDB.
   * 
   * @param {Object} data - Datos a guardar
   * @returns {Promise<void>}
   */
  async function saveToIndexedDB(data) {
    try {
      const db = await openDatabase();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        
        const record = {
          key: CACHE_KEY,
          data: data,
          savedAt: Date.now()
        };
        
        const request = store.put(record);
        
        request.onsuccess = () => {
          console.log('[CatalogDB] Datos guardados:', data?.parts?.length || 0, 'piezas');
          resolve();
        };
        
        request.onerror = () => {
          console.warn('[CatalogDB] Error guardando:', request.error);
          reject(request.error);
        };
        
        transaction.oncomplete = () => db.close();
      });
    } catch (error) {
      console.warn('[CatalogDB] Fallback a localStorage:', error.message);
      // Fallback a localStorage
      try {
        localStorage.setItem('parts:catalog-cache:v2', JSON.stringify(data));
      } catch (_) {
        /* ignore quota */
      }
    }
  }

  /**
   * Lee datos desde IndexedDB.
   * 
   * @returns {Promise<Object|null>} Datos o null si no existen
   */
  async function loadFromIndexedDB() {
    try {
      const db = await openDatabase();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.get(CACHE_KEY);
        
        request.onsuccess = () => {
          const result = request.result;
          if (result && result.data) {
            console.log('[CatalogDB] Datos cargados:', result.data?.parts?.length || 0, 'piezas');
            resolve(result.data);
          } else {
            resolve(null);
          }
        };
        
        request.onerror = () => {
          console.warn('[CatalogDB] Error leyendo:', request.error);
          reject(request.error);
        };
        
        transaction.oncomplete = () => db.close();
      });
    } catch (error) {
      console.warn('[CatalogDB] Fallback lectura localStorage:', error.message);
      // Fallback a localStorage
      try {
        const raw = localStorage.getItem('parts:catalog-cache:v2') || 
                    localStorage.getItem('parts:catalog-cache:v1');
        return raw ? JSON.parse(raw) : null;
      } catch (_) {
        return null;
      }
    }
  }

  /**
   * Limpia los datos de IndexedDB.
   * 
   * @returns {Promise<void>}
   */
  async function clearIndexedDB() {
    try {
      const db = await openDatabase();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.delete(CACHE_KEY);
        
        request.onsuccess = () => {
          console.log('[CatalogDB] Datos eliminados');
          resolve();
        };
        
        request.onerror = () => reject(request.error);
        transaction.oncomplete = () => db.close();
      });
    } catch (error) {
      console.warn('[CatalogDB] Error limpiando:', error.message);
    }
    
    // También limpiar localStorage legacy
    try {
      localStorage.removeItem('parts:catalog-cache:v2');
      localStorage.removeItem('parts:catalog-cache:v1');
    } catch (_) {
      /* ignore */
    }
  }

  /**
   * Verifica si IndexedDB está disponible y funcional.
   * 
   * @returns {Promise<boolean>}
   */
  async function isIndexedDBAvailable() {
    if (!window.indexedDB) return false;
    
    try {
      await openDatabase();
      return true;
    } catch (_) {
      return false;
    }
  }

  // Exportar API pública
  window.CatalogDB = {
    save: saveToIndexedDB,
    load: loadFromIndexedDB,
    clear: clearIndexedDB,
    isAvailable: isIndexedDBAvailable
  };

})();
