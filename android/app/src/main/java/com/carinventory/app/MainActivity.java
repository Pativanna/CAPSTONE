package com.carinventory.app;

import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register ML Kit Scanner plugin BEFORE super.onCreate()
        registerPlugin(MLKitScannerPlugin.class);
        
        super.onCreate(savedInstanceState);
        
        // Configurar edge-to-edge para SafeAreas
        setupEdgeToEdge();
        
        // Development configuration: disable WebView cache
        WebView webView = getBridge().getWebView();
        if (webView != null) {
            WebSettings webSettings = webView.getSettings();
            
            // Deshabilitar cache de WebView (setAppCacheEnabled removido en API 33+)
            webSettings.setCacheMode(WebSettings.LOAD_NO_CACHE);
            
            // Forzar recarga desde red
            webView.clearCache(true);
            webView.clearHistory();
            
            // Habilitar debugging (para Chrome DevTools remote)
            WebView.setWebContentsDebuggingEnabled(true);
            
            // Optimizaciones para desarrollo
            webSettings.setDomStorageEnabled(true);
            webSettings.setDatabaseEnabled(true);
        }
    }
    
    /**
     * Configura edge-to-edge para que la app se extienda detrás de las barras del sistema.
     * Esto permite que CSS use env(safe-area-inset-*) correctamente.
     */
    private void setupEdgeToEdge() {
        Window window = getWindow();
        
        // Permitir que la app dibuje detrás de las barras del sistema
        WindowCompat.setDecorFitsSystemWindows(window, false);
        
        // Hacer las barras del sistema transparentes
        window.setStatusBarColor(Color.TRANSPARENT);
        window.setNavigationBarColor(Color.TRANSPARENT);
        
        // Configurar el color de los iconos de las barras del sistema
        // (iconos oscuros para fondo claro)
        View decorView = window.getDecorView();
        WindowInsetsControllerCompat insetsController = 
            WindowCompat.getInsetsController(window, decorView);
        
        if (insetsController != null) {
            // Iconos oscuros en status bar (para fondo claro)
            insetsController.setAppearanceLightStatusBars(true);
            // Iconos oscuros en navigation bar (para fondo claro)
            insetsController.setAppearanceLightNavigationBars(true);
        }
        
        // Para Android 10+ (API 29+), configurar contraste de barras
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            window.setNavigationBarContrastEnforced(false);
        }
    }
    
    @Override
    public void onBackPressed() {
        // Enviar evento de backbutton al JavaScript
        WebView webView = getBridge().getWebView();
        if (webView != null) {
            webView.evaluateJavascript(
                "(function() { " +
                "  var evt = new CustomEvent('backbutton', { cancelable: true }); " +
                "  var handled = !document.dispatchEvent(evt); " +
                "  return handled; " +
                "})()",
                result -> {
                    // Si el JS no manejó el evento, usar comportamiento por defecto
                    if (!"true".equals(result)) {
                        // Verificar si podemos ir atrás en el WebView
                        if (webView.canGoBack()) {
                            webView.goBack();
                        } else {
                            // Comportamiento por defecto (minimizar app)
                            moveTaskToBack(true);
                        }
                    }
                }
            );
        } else {
            super.onBackPressed();
        }
    }
}
