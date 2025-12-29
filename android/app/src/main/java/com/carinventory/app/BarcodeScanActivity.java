package com.carinventory.app;

import android.content.Intent;
import android.media.Image;
import android.os.Bundle;
import android.os.Vibrator;
import android.util.Log;
import android.util.Size;
import android.view.Gravity;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.ImageAnalysis;
import androidx.camera.core.ImageProxy;
import androidx.camera.core.Preview;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.view.PreviewView;
import androidx.core.content.ContextCompat;

import com.google.common.util.concurrent.ListenableFuture;
import com.google.mlkit.vision.barcode.BarcodeScanner;
import com.google.mlkit.vision.barcode.BarcodeScannerOptions;
import com.google.mlkit.vision.barcode.BarcodeScanning;
import com.google.mlkit.vision.barcode.common.Barcode;
import com.google.mlkit.vision.common.InputImage;

import java.util.ArrayDeque;
import java.util.Deque;
import java.util.Iterator;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import android.graphics.drawable.GradientDrawable;

/**
 * Activity separada para escaneo de códigos de barras con ML Kit.
 * Se lanza desde el plugin MLKitScannerPlugin y devuelve el resultado.
 */
public class BarcodeScanActivity extends AppCompatActivity {

    private static final String TAG = "BarcodeScan";
    
    // Extras para intent
    public static final String EXTRA_TARGET_BARCODE = "target_barcode";
    public static final String EXTRA_TARGET_NAME = "target_name";
    public static final String EXTRA_CONTINUOUS = "continuous";
    
    // Resultado
    public static final String RESULT_BARCODE = "barcode";
    public static final String RESULT_FORMAT = "format";
    public static final String RESULT_IS_MATCH = "is_match";

    private PreviewView previewView;
    private TextView txtStatus;
    private TextView txtResult;
    private TextView txtTarget;
    private TextView txtHistory;
    private View flashOverlay;
    private LinearLayout infoPanel;
    
    private ExecutorService cameraExecutor;
    private BarcodeScanner scanner;
    private ProcessCameraProvider cameraProvider;
    
    private boolean isProcessing = false;
    private String lastScannedCode = "";
    private long lastScanTime = 0;
    private final Deque<String> recentDetections = new ArrayDeque<>();
    
    // Configuración
    private String targetBarcode = null;
    private String targetName = null;
    private boolean continuousMode = true;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        
        // Fullscreen
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        getWindow().setFlags(
            WindowManager.LayoutParams.FLAG_FULLSCREEN,
            WindowManager.LayoutParams.FLAG_FULLSCREEN
        );
        
        // Obtener configuración del intent
        Intent intent = getIntent();
        if (intent != null) {
            targetBarcode = intent.getStringExtra(EXTRA_TARGET_BARCODE);
            targetName = intent.getStringExtra(EXTRA_TARGET_NAME);
            continuousMode = intent.getBooleanExtra(EXTRA_CONTINUOUS, true);
        }
        
        // Crear UI programáticamente
        createUI();
        
        // Iniciar escáner
        cameraExecutor = Executors.newSingleThreadExecutor();
        setupMLKitScanner();
        startCamera();
    }

    private void createUI() {
        // Container principal
        FrameLayout container = new FrameLayout(this);
        container.setBackgroundColor(0xFF000000);
        
        // Preview de cámara
        previewView = new PreviewView(this);
        previewView.setLayoutParams(new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT
        ));
        container.addView(previewView);
        
        // Flash overlay (para match)
        flashOverlay = new View(this);
        flashOverlay.setLayoutParams(new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT
        ));
        flashOverlay.setBackgroundColor(0x8800FF00); // Verde semi-transparente
        flashOverlay.setVisibility(View.GONE);
        container.addView(flashOverlay);

        // Sombras superior/inferior
        View topShade = new View(this);
        FrameLayout.LayoutParams topParams = new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            dp(220)
        );
        topParams.gravity = Gravity.TOP;
        topShade.setLayoutParams(topParams);
        topShade.setBackground(new GradientDrawable(
            GradientDrawable.Orientation.TOP_BOTTOM,
            new int[]{0xCC000000, 0x00000000}
        ));
        container.addView(topShade);

        View bottomShade = new View(this);
        FrameLayout.LayoutParams bottomParams = new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            dp(260)
        );
        bottomParams.gravity = Gravity.BOTTOM;
        bottomShade.setLayoutParams(bottomParams);
        bottomShade.setBackground(new GradientDrawable(
            GradientDrawable.Orientation.BOTTOM_TOP,
            new int[]{0xCC000000, 0x00000000}
        ));
        container.addView(bottomShade);

        // HUD superior
        LinearLayout topHud = new LinearLayout(this);
        topHud.setOrientation(LinearLayout.VERTICAL);
        topHud.setPadding(dp(24), dp(48), dp(24), dp(16));
        FrameLayout.LayoutParams hudParams = new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.WRAP_CONTENT
        );
        hudParams.gravity = Gravity.TOP;
        topHud.setLayoutParams(hudParams);

        txtStatus = new TextView(this);
        txtStatus.setText("📷 Inicializando cámara…");
        txtStatus.setTextColor(0xFFFFFFFF);
        txtStatus.setTextSize(18);
        txtStatus.setPadding(dp(20), dp(12), dp(20), dp(12));
        txtStatus.setBackground(roundedBackground(0x55000000, dp(24)));
        topHud.addView(txtStatus);

        if (targetName != null && !targetName.isEmpty()) {
            txtTarget = new TextView(this);
            txtTarget.setText("Buscando: " + targetName);
            txtTarget.setTextColor(0xFFDDDDDD);
            txtTarget.setTextSize(14);
            txtTarget.setPadding(0, dp(12), 0, 0);
            topHud.addView(txtTarget);

            if (targetBarcode != null && !targetBarcode.isEmpty()) {
                TextView txtExpected = new TextView(this);
                txtExpected.setText("Código esperado: " + targetBarcode);
                txtExpected.setTextColor(0xFF7FDBFF);
                txtExpected.setTextSize(13);
                txtExpected.setPadding(0, dp(4), 0, 0);
                topHud.addView(txtExpected);
            }
        }
        container.addView(topHud);
        
        // Panel inferior
        infoPanel = new LinearLayout(this);
        infoPanel.setOrientation(LinearLayout.VERTICAL);
        infoPanel.setBackground(roundedBackground(0xE6000000, dp(32)));
        infoPanel.setPadding(dp(24), dp(24), dp(24), dp(28));
        
        FrameLayout.LayoutParams panelParams = new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.WRAP_CONTENT
        );
        panelParams.gravity = android.view.Gravity.BOTTOM;
        panelParams.setMargins(dp(16), 0, dp(16), dp(16));
        infoPanel.setLayoutParams(panelParams);
        infoPanel.setElevation(dp(6));
        
        TextView lastLabel = new TextView(this);
        lastLabel.setText("Último código");
        lastLabel.setTextColor(0xFFB0BEC5);
        lastLabel.setTextSize(13);
        infoPanel.addView(lastLabel);

        txtResult = new TextView(this);
        txtResult.setTextColor(0xFF4CAF50);
        txtResult.setText("Aún no hay lecturas");
        txtResult.setTextSize(24);
        txtResult.setPadding(0, dp(4), 0, 0);
        infoPanel.addView(txtResult);

        View divider = new View(this);
        LinearLayout.LayoutParams dividerParams = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            1
        );
        dividerParams.setMargins(0, dp(20), 0, dp(20));
        divider.setLayoutParams(dividerParams);
        divider.setBackgroundColor(0x33FFFFFF);
        infoPanel.addView(divider);

        TextView historyLabel = new TextView(this);
        historyLabel.setText("IDs detectados");
        historyLabel.setTextColor(0xFFB0BEC5);
        historyLabel.setTextSize(13);
        infoPanel.addView(historyLabel);

        txtHistory = new TextView(this);
        txtHistory.setTextColor(0xFFFFFFFF);
        txtHistory.setTextSize(16);
        txtHistory.setText("— Sin lecturas —");
        txtHistory.setPadding(0, dp(6), 0, 0);
        infoPanel.addView(txtHistory);
        
        // Botón cerrar
        Button btnClose = new Button(this);
        btnClose.setText("Cerrar escáner");
        btnClose.setTextColor(0xFFFFFFFF);
        btnClose.setAllCaps(false);
        btnClose.setBackground(roundedBackground(0x33000000, dp(24)));
        btnClose.setPadding(dp(32), dp(16), dp(32), dp(16));
        
        LinearLayout.LayoutParams btnParams = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        );
        btnParams.gravity = android.view.Gravity.CENTER_HORIZONTAL;
        btnParams.topMargin = 24;
        btnClose.setLayoutParams(btnParams);
        
        btnClose.setOnClickListener(v -> {
            setResult(RESULT_CANCELED);
            finish();
        });
        infoPanel.addView(btnClose);

        container.addView(infoPanel);
        
        setContentView(container);
    }

    private GradientDrawable roundedBackground(int color, float radiusPx) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(color);
        drawable.setCornerRadius(radiusPx);
        return drawable;
    }

    private int dp(int value) {
        float density = getResources().getDisplayMetrics().density;
        return Math.round(value * density);
    }

    private void updateHistory(String newEntry) {
        if (txtHistory == null || newEntry == null || newEntry.isEmpty()) {
            return;
        }
        recentDetections.remove(newEntry);
        recentDetections.addFirst(newEntry);
        while (recentDetections.size() > 3) {
            recentDetections.removeLast();
        }
        StringBuilder builder = new StringBuilder();
        Iterator<String> iterator = recentDetections.iterator();
        while (iterator.hasNext()) {
            builder.append("• ").append(iterator.next());
            if (iterator.hasNext()) {
                builder.append("\n");
            }
        }
        txtHistory.setText(builder.toString());
    }

    private void setupMLKitScanner() {
        Log.i(TAG, "Setting up ML Kit scanner...");
        
        BarcodeScannerOptions options = new BarcodeScannerOptions.Builder()
            .setBarcodeFormats(
                Barcode.FORMAT_EAN_13,
                Barcode.FORMAT_EAN_8,
                Barcode.FORMAT_UPC_A,
                Barcode.FORMAT_UPC_E,
                Barcode.FORMAT_CODE_128,
                Barcode.FORMAT_CODE_39,
                Barcode.FORMAT_QR_CODE,
                Barcode.FORMAT_DATA_MATRIX
            )
            .build();
        
        scanner = BarcodeScanning.getClient(options);
        Log.i(TAG, "✅ ML Kit scanner initialized");
    }

    private void startCamera() {
        Log.i(TAG, "📷 Starting camera...");
        
        ListenableFuture<ProcessCameraProvider> cameraProviderFuture = 
            ProcessCameraProvider.getInstance(this);

        cameraProviderFuture.addListener(() -> {
            try {
                cameraProvider = cameraProviderFuture.get();

                Preview preview = new Preview.Builder().build();
                preview.setSurfaceProvider(previewView.getSurfaceProvider());

                ImageAnalysis imageAnalysis = new ImageAnalysis.Builder()
                    .setTargetResolution(new Size(1280, 720))
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                    .build();

                imageAnalysis.setAnalyzer(cameraExecutor, this::analyzeImage);

                CameraSelector cameraSelector = CameraSelector.DEFAULT_BACK_CAMERA;

                cameraProvider.unbindAll();
                cameraProvider.bindToLifecycle(this, cameraSelector, preview, imageAnalysis);

                Log.i(TAG, "✅ Camera started successfully");
                runOnUiThread(() -> txtStatus.setText("📷 Cámara activa"));

            } catch (Exception e) {
                Log.e(TAG, "❌ Camera start failed", e);
                runOnUiThread(() -> txtStatus.setText("❌ Error: " + e.getMessage()));
            }
        }, ContextCompat.getMainExecutor(this));
    }

    @androidx.camera.core.ExperimentalGetImage
    private void analyzeImage(@NonNull ImageProxy imageProxy) {
        if (isProcessing) {
            imageProxy.close();
            return;
        }

        Image mediaImage = imageProxy.getImage();
        if (mediaImage == null) {
            imageProxy.close();
            return;
        }

        isProcessing = true;
        InputImage inputImage = InputImage.fromMediaImage(
            mediaImage, 
            imageProxy.getImageInfo().getRotationDegrees()
        );

        scanner.process(inputImage)
            .addOnSuccessListener(barcodes -> {
                if (!barcodes.isEmpty()) {
                    Barcode barcode = barcodes.get(0);
                    String value = barcode.getRawValue();
                    
                    if (value != null && !value.isEmpty()) {
                        // Evitar escaneo repetido del mismo código
                        long now = System.currentTimeMillis();
                        if (!value.equals(lastScannedCode) || (now - lastScanTime) > 2000) {
                            lastScannedCode = value;
                            lastScanTime = now;
                            
                            String format = formatToString(barcode.getFormat());
                            Log.i(TAG, "✅ Barcode found: " + value + " (" + format + ")");
                            
                            handleBarcodeFound(value, format);
                        }
                    }
                }
                isProcessing = false;
            })
            .addOnFailureListener(e -> {
                Log.e(TAG, "ML Kit scan failed", e);
                isProcessing = false;
            })
            .addOnCompleteListener(task -> imageProxy.close());
    }

    private void handleBarcodeFound(String barcode, String format) {
        boolean isMatch = targetBarcode != null && targetBarcode.equals(barcode);
        
        runOnUiThread(() -> {
            String displayValue = format != null && !format.isEmpty()
                ? barcode + " · " + format
                : barcode;
            txtResult.setText(displayValue);
            
            if (isMatch) {
                // ¡MATCH! - Flash verde + vibración
                txtStatus.setText("✅ ¡COINCIDE!");
                txtResult.setTextColor(0xFF00FF00);
                showFlash();
                vibrate();
            } else if (targetBarcode != null) {
                // No coincide
                txtStatus.setText("⚠️ Código diferente");
                txtResult.setTextColor(0xFFFF9800);
            } else {
                // Sin objetivo específico
                txtStatus.setText("✅ Código escaneado");
                txtResult.setTextColor(0xFF4CAF50);
            }

            updateHistory(displayValue);
        });
        
        // Enviar resultado a la Activity que nos llamó
        Intent resultIntent = new Intent();
        resultIntent.putExtra(RESULT_BARCODE, barcode);
        resultIntent.putExtra(RESULT_FORMAT, format);
        resultIntent.putExtra(RESULT_IS_MATCH, isMatch);
        
        // En modo continuo, enviamos broadcast; en modo único, terminamos
        if (!continuousMode && isMatch) {
            setResult(RESULT_OK, resultIntent);
            finish();
        } else {
            // Broadcast para que el plugin lo reciba
            Intent broadcastIntent = new Intent("com.carinventory.BARCODE_SCANNED");
            broadcastIntent.putExtras(resultIntent);
            sendBroadcast(broadcastIntent);
        }
    }

    private void showFlash() {
        flashOverlay.setVisibility(View.VISIBLE);
        flashOverlay.postDelayed(() -> flashOverlay.setVisibility(View.GONE), 300);
    }

    private void vibrate() {
        try {
            Vibrator vibrator = (Vibrator) getSystemService(VIBRATOR_SERVICE);
            if (vibrator != null && vibrator.hasVibrator()) {
                vibrator.vibrate(200);
            }
        } catch (Exception e) {
            Log.w(TAG, "Could not vibrate", e);
        }
    }

    private String formatToString(int format) {
        switch (format) {
            case Barcode.FORMAT_EAN_13: return "EAN_13";
            case Barcode.FORMAT_EAN_8: return "EAN_8";
            case Barcode.FORMAT_UPC_A: return "UPC_A";
            case Barcode.FORMAT_UPC_E: return "UPC_E";
            case Barcode.FORMAT_CODE_128: return "CODE_128";
            case Barcode.FORMAT_CODE_39: return "CODE_39";
            case Barcode.FORMAT_QR_CODE: return "QR_CODE";
            case Barcode.FORMAT_DATA_MATRIX: return "DATA_MATRIX";
            default: return "UNKNOWN";
        }
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        if (cameraProvider != null) {
            cameraProvider.unbindAll();
        }
        if (cameraExecutor != null) {
            cameraExecutor.shutdown();
        }
        if (scanner != null) {
            scanner.close();
        }
    }

    @Override
    public void onBackPressed() {
        setResult(RESULT_CANCELED);
        super.onBackPressed();
    }
}
