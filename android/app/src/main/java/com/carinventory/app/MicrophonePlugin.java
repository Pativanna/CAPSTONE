package com.carinventory.app;

import android.Manifest;
import android.content.pm.PackageManager;
import android.util.Log;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * Plugin de Capacitor para manejar permisos de micrófono.
 * Similar a MLKitScannerPlugin pero para audio.
 * 
 * Uso desde JavaScript:
 *   const { MicrophonePlugin } = Capacitor.Plugins;
 *   const result = await MicrophonePlugin.requestPermission();
 *   if (result.granted) {
 *     // Usar navigator.mediaDevices.getUserMedia()
 *   }
 */
@CapacitorPlugin(
    name = "MicrophonePlugin",
    permissions = {
        @Permission(
            alias = "microphone",
            strings = { Manifest.permission.RECORD_AUDIO }
        )
    }
)
public class MicrophonePlugin extends Plugin {

    private static final String TAG = "MicrophonePlugin";

    @Override
    public void load() {
        super.load();
        Log.i(TAG, "MicrophonePlugin loaded");
    }

    /**
     * Solicita permiso de micrófono.
     * 
     * @return { granted: boolean, state: "granted" | "denied" | "prompt" }
     */
    @PluginMethod
    public void requestPermission(PluginCall call) {
        Log.i(TAG, "🎤 requestPermission called");
        
        if (checkMicrophonePermission()) {
            Log.i(TAG, "✅ Microphone permission already granted");
            JSObject result = new JSObject();
            result.put("granted", true);
            result.put("state", "granted");
            call.resolve(result);
            return;
        }
        
        Log.i(TAG, "📋 Requesting microphone permission...");
        requestAllPermissions(call, "handleMicrophonePermissionResult");
    }

    @PermissionCallback
    private void handleMicrophonePermissionResult(PluginCall call) {
        boolean granted = getPermissionState("microphone") == com.getcapacitor.PermissionState.GRANTED;
        
        Log.i(TAG, "🎤 Permission result: " + (granted ? "GRANTED" : "DENIED"));
        
        JSObject result = new JSObject();
        result.put("granted", granted);
        result.put("state", granted ? "granted" : "denied");
        call.resolve(result);
    }

    /**
     * Verifica el estado actual del permiso.
     * 
     * @return { granted: boolean, state: "granted" | "denied" | "prompt" }
     */
    @PluginMethod
    public void checkPermission(PluginCall call) {
        boolean granted = checkMicrophonePermission();
        String state = granted ? "granted" : "prompt";
        
        // Verificar si fue denegado permanentemente
        if (!granted && getPermissionState("microphone") == com.getcapacitor.PermissionState.DENIED) {
            state = "denied";
        }
        
        Log.i(TAG, "🎤 checkPermission: " + state);
        
        JSObject result = new JSObject();
        result.put("granted", granted);
        result.put("state", state);
        call.resolve(result);
    }

    /**
     * Verifica si el permiso está otorgado.
     */
    private boolean checkMicrophonePermission() {
        return ContextCompat.checkSelfPermission(getContext(), Manifest.permission.RECORD_AUDIO)
            == PackageManager.PERMISSION_GRANTED;
    }
}
