package com.carinventory.app;

import android.Manifest;
import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.util.Log;

import androidx.activity.result.ActivityResult;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * Plugin de Capacitor para escaneo de códigos de barras usando ML Kit.
 * Lanza BarcodeScanActivity para el escaneo real.
 */
@CapacitorPlugin(
    name = "MLKitScanner",
    permissions = {
        @Permission(
            alias = "camera",
            strings = { Manifest.permission.CAMERA }
        )
    }
)
public class MLKitScannerPlugin extends Plugin {

    private static final String TAG = "MLKitScanner";
    
    private PluginCall savedCall;
    private BroadcastReceiver barcodeReceiver;

    @Override
    public void load() {
        super.load();
        Log.i(TAG, "MLKitScanner plugin loaded");
    }

    @PluginMethod
    public void startScan(PluginCall call) {
        Log.i(TAG, "📷 startScan called");
        
        if (!checkCameraPermission()) {
            Log.i(TAG, "Requesting camera permission...");
            savedCall = call;
            requestAllPermissions(call, "handleCameraPermission");
            return;
        }
        
        launchScanner(call);
    }
    
    private void launchScanner(PluginCall call) {
        // Guardar call para callback
        savedCall = call;
        call.setKeepAlive(true);
        
        // Obtener parámetros opcionales
        String targetBarcode = call.getString("targetBarcode", null);
        String targetName = call.getString("targetName", null);
        boolean continuous = call.getBoolean("continuous", true);
        
        Log.i(TAG, "Target barcode: " + targetBarcode);
        Log.i(TAG, "Target name: " + targetName);
        Log.i(TAG, "Continuous mode: " + continuous);
        
        // Registrar receiver para modo continuo
        if (continuous) {
            registerBarcodeReceiver();
        }
        
        // Lanzar Activity de escaneo
        Intent intent = new Intent(getContext(), BarcodeScanActivity.class);
        intent.putExtra(BarcodeScanActivity.EXTRA_TARGET_BARCODE, targetBarcode);
        intent.putExtra(BarcodeScanActivity.EXTRA_TARGET_NAME, targetName);
        intent.putExtra(BarcodeScanActivity.EXTRA_CONTINUOUS, continuous);
        
        startActivityForResult(call, intent, "handleScanResult");
    }

    @ActivityCallback
    private void handleScanResult(PluginCall call, ActivityResult result) {
        Log.i(TAG, "Scan activity result: " + result.getResultCode());
        
        // Desregistrar receiver
        unregisterBarcodeReceiver();
        
        if (result.getResultCode() == Activity.RESULT_OK && result.getData() != null) {
            Intent data = result.getData();
            String barcode = data.getStringExtra(BarcodeScanActivity.RESULT_BARCODE);
            String format = data.getStringExtra(BarcodeScanActivity.RESULT_FORMAT);
            boolean isMatch = data.getBooleanExtra(BarcodeScanActivity.RESULT_IS_MATCH, false);
            
            Log.i(TAG, "✅ Scan result: " + barcode + " (" + format + ") match=" + isMatch);
            
            JSObject ret = new JSObject();
            ret.put("barcode", barcode);
            ret.put("format", format);
            ret.put("isMatch", isMatch);
            ret.put("cancelled", false);
            call.resolve(ret);
        } else {
            Log.i(TAG, "Scan cancelled");
            JSObject ret = new JSObject();
            ret.put("cancelled", true);
            call.resolve(ret);
        }
    }

    @PermissionCallback
    private void handleCameraPermission(PluginCall call) {
        if (getPermissionState("camera") == com.getcapacitor.PermissionState.GRANTED) {
            Log.i(TAG, "Camera permission granted");
            launchScanner(call);
        } else {
            Log.e(TAG, "Camera permission denied");
            call.reject("Camera permission denied");
        }
    }

    @PluginMethod
    public void stopScan(PluginCall call) {
        Log.i(TAG, "stopScan called");
        unregisterBarcodeReceiver();
        call.resolve();
    }

    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject result = new JSObject();
        result.put("available", true);
        result.put("hasPermission", checkCameraPermission());
        call.resolve(result);
    }

    private boolean checkCameraPermission() {
        return ContextCompat.checkSelfPermission(getContext(), Manifest.permission.CAMERA) 
            == PackageManager.PERMISSION_GRANTED;
    }

    private void registerBarcodeReceiver() {
        if (barcodeReceiver != null) return;
        
        barcodeReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                String barcode = intent.getStringExtra(BarcodeScanActivity.RESULT_BARCODE);
                String format = intent.getStringExtra(BarcodeScanActivity.RESULT_FORMAT);
                boolean isMatch = intent.getBooleanExtra(BarcodeScanActivity.RESULT_IS_MATCH, false);
                
                Log.i(TAG, "📨 Broadcast received: " + barcode);
                
                // Notificar a JS
                JSObject data = new JSObject();
                data.put("barcode", barcode);
                data.put("format", format);
                data.put("isMatch", isMatch);
                notifyListeners("barcodeScanned", data);
            }
        };
        
        IntentFilter filter = new IntentFilter("com.carinventory.BARCODE_SCANNED");
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU) {
            getContext().registerReceiver(barcodeReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            getContext().registerReceiver(barcodeReceiver, filter);
        }
        Log.i(TAG, "Barcode receiver registered");
    }

    private void unregisterBarcodeReceiver() {
        if (barcodeReceiver != null) {
            try {
                getContext().unregisterReceiver(barcodeReceiver);
            } catch (Exception e) {
                Log.w(TAG, "Error unregistering receiver", e);
            }
            barcodeReceiver = null;
            Log.i(TAG, "Barcode receiver unregistered");
        }
    }

    @Override
    protected void handleOnDestroy() {
        super.handleOnDestroy();
        unregisterBarcodeReceiver();
    }
}
