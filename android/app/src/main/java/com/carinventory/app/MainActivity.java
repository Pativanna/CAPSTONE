package com.carinventory.app;

import android.Manifest;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.util.DisplayMetrics;
import android.util.Log;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.content.ContextCompat;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static final String TAG = "MainActivity";
    private WebView webView;
    private PermissionRequest pendingPermissionRequest;
    
    // Launcher para solicitar permisos de audio
    private final ActivityResultLauncher<String> requestAudioPermissionLauncher =
        registerForActivityResult(new ActivityResultContracts.RequestPermission(), isGranted -> {
            Log.i(TAG, "🎤 Audio permission result: " + isGranted);
            if (pendingPermissionRequest != null) {
                if (isGranted) {
                    pendingPermissionRequest.grant(pendingPermissionRequest.getResources());
                    Log.i(TAG, "✅ WebView audio permission granted");
                } else {
                    pendingPermissionRequest.deny();
                    Log.w(TAG, "❌ WebView audio permission denied");
                }
                pendingPermissionRequest = null;
            }
        });

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register plugins BEFORE super.onCreate()
        registerPlugin(MLKitScannerPlugin.class);
        registerPlugin(MicrophonePlugin.class);
        
        super.onCreate(savedInstanceState);
        
        // Configurar edge-to-edge para SafeAreas
        setupEdgeToEdge();
        
        // Development configuration: disable WebView cache
        webView = getBridge().getWebView();
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
            
            // Habilitar MediaStream para WebRTC/audio
            webSettings.setMediaPlaybackRequiresUserGesture(false);
            
            // Configurar WebChromeClient para manejar permisos de medios
            setupWebChromeClient();
            
            // Configurar listener para inyectar safe areas cuando cambie la página
            setupSafeAreaInjection();
        }
    }
    
    /**
     * Configura un WebChromeClient personalizado para manejar permisos de medios
     * como micrófono y cámara desde JavaScript (getUserMedia).
     */
    private void setupWebChromeClient() {
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                Log.i(TAG, "📋 WebView permission request: " + java.util.Arrays.toString(request.getResources()));
                
                runOnUiThread(() -> {
                    boolean needsAudio = false;
                    boolean needsVideo = false;
                    
                    for (String resource : request.getResources()) {
                        if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) {
                            needsAudio = true;
                        }
                        if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) {
                            needsVideo = true;
                        }
                    }
                    
                    // Verificar permisos de Android
                    boolean hasAudioPermission = ContextCompat.checkSelfPermission(
                        MainActivity.this, Manifest.permission.RECORD_AUDIO
                    ) == PackageManager.PERMISSION_GRANTED;
                    
                    boolean hasCameraPermission = ContextCompat.checkSelfPermission(
                        MainActivity.this, Manifest.permission.CAMERA
                    ) == PackageManager.PERMISSION_GRANTED;
                    
                    Log.i(TAG, "🔐 Android permissions - Audio: " + hasAudioPermission + ", Camera: " + hasCameraPermission);
                    
                    // Si necesita audio y no tiene permiso, solicitarlo
                    if (needsAudio && !hasAudioPermission) {
                        Log.i(TAG, "🎤 Requesting RECORD_AUDIO permission...");
                        pendingPermissionRequest = request;
                        requestAudioPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO);
                        return;
                    }
                    
                    // Si necesita video y no tiene permiso, solicitarlo
                    if (needsVideo && !hasCameraPermission) {
                        Log.i(TAG, "📷 Requesting CAMERA permission...");
                        pendingPermissionRequest = request;
                        requestAudioPermissionLauncher.launch(Manifest.permission.CAMERA);
                        return;
                    }
                    
                    // Todos los permisos necesarios están otorgados
                    Log.i(TAG, "✅ Granting WebView permission request");
                    request.grant(request.getResources());
                });
            }
            
            @Override
            public void onPermissionRequestCanceled(PermissionRequest request) {
                Log.i(TAG, "❌ WebView permission request canceled");
                pendingPermissionRequest = null;
            }
        });
        
        Log.i(TAG, "✅ WebChromeClient configured for media permissions");
    }
    
    /**
     * Configura la inyección de safe areas reales del sistema al JavaScript.
     * Esto permite que el contenido remoto conozca los insets exactos del dispositivo.
     */
    private void setupSafeAreaInjection() {
        View rootView = getWindow().getDecorView().getRootView();
        
        // Listener que se ejecuta cuando los WindowInsets cambian
        ViewCompat.setOnApplyWindowInsetsListener(rootView, (view, windowInsets) -> {
            Insets systemBars = windowInsets.getInsets(WindowInsetsCompat.Type.systemBars());
            Insets displayCutout = windowInsets.getInsets(WindowInsetsCompat.Type.displayCutout());
            
            // Usar el máximo entre systemBars y displayCutout para cada lado
            int topPx = Math.max(systemBars.top, displayCutout.top);
            int bottomPx = Math.max(systemBars.bottom, displayCutout.bottom);
            int leftPx = Math.max(systemBars.left, displayCutout.left);
            int rightPx = Math.max(systemBars.right, displayCutout.right);
            
            // Inyectar los valores al JavaScript
            injectSafeAreas(topPx, bottomPx, leftPx, rightPx);
            
            return windowInsets;
        });
        
        // También inyectar inmediatamente con valores por defecto basados en status bar
        rootView.post(() -> {
            int statusBarHeight = getStatusBarHeight();
            int navBarHeight = getNavigationBarHeight();
            injectSafeAreas(statusBarHeight, navBarHeight, 0, 0);
        });
    }
    
    /**
     * Inyecta los safe areas al JavaScript del WebView.
     */
    private void injectSafeAreas(int topPx, int bottomPx, int leftPx, int rightPx) {
        if (webView == null) return;
        
        String js = String.format(
            "(function() {" +
            "  window.__NATIVE_SAFE_AREAS__ = {top: %d, bottom: %d, left: %d, right: %d};" +
            "  document.documentElement.style.setProperty('--safe-area-top', '%dpx');" +
            "  document.documentElement.style.setProperty('--safe-area-bottom', '%dpx');" +
            "  document.documentElement.style.setProperty('--safe-area-left', '%dpx');" +
            "  document.documentElement.style.setProperty('--safe-area-right', '%dpx');" +
            "  window.dispatchEvent(new CustomEvent('nativeSafeAreasReady', {detail: window.__NATIVE_SAFE_AREAS__}));" +
            "})();",
            topPx, bottomPx, leftPx, rightPx,
            topPx, bottomPx, leftPx, rightPx
        );
        
        webView.post(() -> webView.evaluateJavascript(js, null));
    }
    
    /**
     * Obtiene la altura del status bar.
     */
    private int getStatusBarHeight() {
        int resourceId = getResources().getIdentifier("status_bar_height", "dimen", "android");
        if (resourceId > 0) {
            return getResources().getDimensionPixelSize(resourceId);
        }
        // Fallback: ~24dp convertido a px
        DisplayMetrics metrics = getResources().getDisplayMetrics();
        return (int) (24 * metrics.density);
    }
    
    /**
     * Obtiene la altura del navigation bar.
     */
    private int getNavigationBarHeight() {
        int resourceId = getResources().getIdentifier("navigation_bar_height", "dimen", "android");
        if (resourceId > 0) {
            return getResources().getDimensionPixelSize(resourceId);
        }
        return 0;
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
