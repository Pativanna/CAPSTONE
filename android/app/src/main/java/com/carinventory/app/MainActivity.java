package com.carinventory.app;

import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        
        // Configuración para desarrollo: deshabilitar cache de WebView
        WebView webView = getBridge().getWebView();
        if (webView != null) {
            WebSettings webSettings = webView.getSettings();
            
            // Deshabilitar todos los tipos de cache
            webSettings.setCacheMode(WebSettings.LOAD_NO_CACHE);
            webSettings.setAppCacheEnabled(false);
            
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
}
