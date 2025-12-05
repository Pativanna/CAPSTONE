package com.carinventory.app.scanner;

import java.nio.ByteBuffer;

/**
 * Interface para procesadores de frames de cámara
 */
public interface BarcodeProcessor {
    void processByteBuffer(ByteBuffer data, FrameMetadata frameMetadata);
    void stop();
}
