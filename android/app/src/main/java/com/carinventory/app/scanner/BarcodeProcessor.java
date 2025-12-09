package com.carinventory.app.scanner;

import androidx.camera.core.ImageProxy;

import java.nio.ByteBuffer;

/**
 * Interface para procesadores de frames de cámara
 */
public interface BarcodeProcessor {

    /**
     * Procesa un frame entregado como ByteBuffer (ruta síncrona)
     */
    void processByteBuffer(ByteBuffer data, FrameMetadata frameMetadata);

    /**
     * Procesa un ImageProxy. Devuelve true si el procesador se hace cargo de cerrar el proxy.
     */
    default boolean processImageProxy(ImageProxy imageProxy) {
        if (imageProxy == null || imageProxy.getImage() == null) {
            return false;
        }

        // Fallback: usa solo el plano Y, llama al método base y deja que el caller cierre
        ByteBuffer buffer = imageProxy.getImage().getPlanes()[0].getBuffer();
        processByteBuffer(
            buffer,
            new FrameMetadata.Builder()
                .setWidth(imageProxy.getWidth())
                .setHeight(imageProxy.getHeight())
                .setRotation(imageProxy.getImageInfo().getRotationDegrees())
                .build()
        );

        return false;
    }

    void stop();
}
