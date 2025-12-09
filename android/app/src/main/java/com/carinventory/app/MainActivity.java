package com.carinventory.app;

import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // IMPORTANT: Register plugins BEFORE super.onCreate()
        // The bridge is created in super.onCreate() -> load()
        // After that, bridgeBuilder.addPlugin() has no effect
        registerPlugin(MLKitScannerPlugin.class);
        
        super.onCreate(savedInstanceState);
        
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
}
