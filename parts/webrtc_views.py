import asyncio
import json
import logging
import os
from typing import Optional

from django.http import JsonResponse, HttpRequest
from django.views.decorators.csrf import csrf_protect
from django.contrib.auth.decorators import login_required

# aiortc / AV
from aiortc import RTCPeerConnection, RTCSessionDescription, RTCConfiguration, RTCIceServer
from aiortc.rtcrtpsender import RTCRtpSender
from aiortc.contrib.media import MediaRelay, MediaBlackhole
from av import AudioResampler
import numpy as np
import websockets
try:
    import webrtcvad
except ImportError:
    webrtcvad = None

from parts.utils.permissions import ensure_voice_ingest_permission

logger = logging.getLogger(__name__)

# Reutilizar un relay para tracks
_relay = MediaRelay()

# Registro de PeerConnections para limpieza
_pcs: set[RTCPeerConnection] = set()

VOSK_WS_URL = os.getenv('VOSK_WS_URL', 'ws://vosk:8765')
SAMPLE_RATE = 16000

# Configuración de ICE para servidor público
# Obtener IP pública del servidor
PUBLIC_IP = os.getenv('PUBLIC_IP', '144.22.55.109')  # IP de www.transervis.cl
WEBRTC_PORT_RANGE = (10000, 10100)  # Rango de puertos UDP abiertos


async def _forward_vosk_to_dc(ws, dc):
    try:
        logger.info(f" Iniciando forward de Vosk → DataChannel, readyState inicial: {getattr(dc, 'readyState', 'unknown')}")
        async for message in ws:
            try:
                if isinstance(message, (bytes, bytearray)):
                    continue
                
                dc_state = getattr(dc, 'readyState', None)
                if dc and dc_state == 'open':
                    dc.send(message)
                    logger.debug(f" Mensaje enviado al DataChannel")
                else:
                    logger.warning(f" DataChannel no está abierto (state={dc_state})")
                    continue
            except Exception as e:
                logger.warning("Error reenviando mensaje a DataChannel: %s", e)
                await asyncio.sleep(0.05)
    except Exception as e:
        logger.warning("Lectura WS Vosk finalizada: %s", e)


async def _consume_webrtc_audio(track, usuario_id, dc=None):
    """
    Consume audio WebRTC usando el patrón estándar de aiortc.
    CRÍTICO: aiortc necesita un loop activo llamando track.recv() continuamente.
    """
    vosk_host = os.getenv('VOSK_HOST', 'vosk')
    vosk_port = int(os.getenv('VOSK_PORT', 8765))
    url = f"ws://{vosk_host}:{vosk_port}"
    
    logger.info(" Conectando a Vosk: %s", url)
    
    try:
        ws = await websockets.connect(url)
        logger.info(" Conectado a Vosk WebSocket")
    except Exception as e:
        logger.error(" Error conectando a Vosk: %s", e)
        return

    # Forward task opcional
    forward_task = None
    if dc:
        forward_task = asyncio.create_task(_forward_vosk_to_dc(ws, dc))
        logger.info(" Forward Vosk→DataChannel activo")
    else:
        logger.info("ℹ  Cliente recibirá transcripciones por WebSocket directo")

    # Resampler
    resampler = AudioResampler(format='s16', layout='mono', rate=SAMPLE_RATE)
    
    # VAD opcional
    try:
        vad = webrtcvad.Vad(2) if webrtcvad else None
    except:
        vad = None

    RMS_MIN = 0.005
    FEED_MIN_MS = 30
    FEED_MAX_MS = 120

    try:
        pcm_buffer = bytearray()
        last_feed_ts = asyncio.get_event_loop().time()
        feed_flush_count = 0
        frames_recibidos = 0

        logger.info(" INICIANDO LOOP DE CONSUMO - track=%s", track)
        
        # LOOP PRINCIPAL: consumir frames continuamente
        while True:
            try:
                # CRÍTICO: recv() debe llamarse continuamente para mantener track activo
                frame = await track.recv()
                frames_recibidos += 1
                
                if frames_recibidos == 1:
                    logger.info(" PRIMER FRAME - formato=%s samples=%s", 
                               getattr(frame, 'format', 'unknown'),
                               getattr(frame, 'samples', 'unknown'))
                elif frames_recibidos % 100 == 0:
                    logger.info(" Frame #%d", frames_recibidos)
                
                # Resamplear a 16kHz mono
                for af in resampler.resample(frame):
                    try:
                        pcm_bytes = af.planes[0].to_bytes()
                    except:
                        arr = af.to_ndarray()
                        if arr.dtype != np.int16:
                            arr = arr.astype(np.int16, copy=False)
                        pcm_bytes = arr.tobytes()

                    # RMS para gate de silencio
                    try:
                        arr = np.frombuffer(pcm_bytes, dtype=np.int16)
                        rms = np.sqrt(np.mean(arr.astype(np.float32)**2)) / 32768.0 if arr.size else 0.0
                    except:
                        rms = 0.0

                    # Solo enviar si hay audio
                    if rms >= RMS_MIN:
                        pcm_buffer.extend(pcm_bytes)

                    # Flush por tamaño/tiempo
                    now = asyncio.get_event_loop().time()
                    elapsed_ms = (now - last_feed_ts) * 1000.0
                    min_bytes = int(32 * FEED_MIN_MS)
                    
                    if len(pcm_buffer) >= min_bytes or elapsed_ms >= FEED_MAX_MS:
                        if pcm_buffer:
                            try:
                                await ws.send(bytes(pcm_buffer))
                                feed_flush_count += 1
                                if feed_flush_count % 30 == 0:
                                    logger.info("Flush #%d bytes=%d rms=%.4f", feed_flush_count, len(pcm_buffer), rms)
                            except Exception as e:
                                logger.warning("Error enviando a Vosk: %s", e)
                            pcm_buffer.clear()
                            last_feed_ts = now

            except Exception as e:
                logger.error(" Error en loop: %s", e, exc_info=True)
                break

    except Exception as e:
        logger.error(" Error general: %s", e, exc_info=True)
    finally:
        if forward_task:
            forward_task.cancel()
        try:
            await ws.close()
        except:
            pass
        logger.info(" Consumo WebRTC finalizado - frames_recibidos=%d", frames_recibidos)


@login_required
@csrf_protect
async def webrtc_offer(request: HttpRequest):
    """
    Endpoint WebRTC siguiendo el patrón estándar de aiortc.
    CRÍTICO: Necesitamos "activar" el track con algo que lo consuma (recorder/relay).
    """
    if request.method != 'POST':
        return JsonResponse({'success': False, 'error': 'Método no permitido'}, status=405)

    ensure_voice_ingest_permission(request.user)

    try:
        data = json.loads(request.body.decode('utf-8'))
        offer = data.get('sdp')
        tipo = data.get('type') or 'offer'
        usuario_id = data.get('usuario_id')
        if not offer:
            return JsonResponse({'success': False, 'error': 'SDP requerido'}, status=400)
        
        logger.info(f" SDP recibido de usuario {usuario_id}")
        
    except Exception as e:
        return JsonResponse({'success': False, 'error': f'JSON inválido: {e}'}, status=400)

    # CONFIGURACIÓN DE ICE optimizada para mismo dominio/proxy
    # Para cliente-servidor detrás del mismo proxy NGINX,
    # los host candidates funcionan mejor que STUN
    configuration = RTCConfiguration(
        iceServers=[]  # Sin STUN - usar solo host candidates (conexión directa)
    )
    
    pc = RTCPeerConnection(configuration=configuration)
    _pcs.add(pc)
    
    logger.info(' PeerConnection creado - usando solo host candidates (sin STUN)')

    # CRÍTICO: MediaBlackhole para "activar" el track (patrón del ejemplo oficial de aiortc)
    recorder = MediaBlackhole()

    @pc.on('connectionstatechange')
    async def on_state():
        st = pc.connectionState
        logger.info(' WebRTC connectionState: %s', st)
        if st == 'connected':
            logger.info(' WebRTC CONECTADO - audio debería fluir')
        elif st in ('failed', 'closed', 'disconnected'):
            logger.warning(' WebRTC desconectado: %s', st)
            try:
                await recorder.stop()
            except:
                pass
            try:
                await pc.close()
            finally:
                _pcs.discard(pc)

    @pc.on('iceconnectionstatechange')
    async def on_ice_state():
        st = pc.iceConnectionState
        logger.info(' ICE connectionState: %s', st)
        if st == 'failed':
            logger.error(' ICE falló - verificar configuración de red/firewall')
        elif st in ('connected', 'completed'):
            logger.info(' ICE CONECTADO')

    @pc.on('icegatheringstatechange')
    async def on_ice_gathering():
        logger.info(' ICE gatheringState: %s', pc.iceGatheringState)

    @pc.on('track')
    def on_track(track):
        logger.info(' Track recibido: kind=%s id=%s', track.kind, getattr(track, 'id', 'N/A'))
        if track.kind == 'audio':
            logger.info(' Audio track recibido')
            
            # PATRÓN OFICIAL aiortc: addTrack al recorder para activarlo
            recorder.addTrack(track)
            logger.info(' Track agregado a MediaBlackhole')
            
            # También consumir con nuestro procesador
            relayed_track = _relay.subscribe(track)
            asyncio.create_task(_consume_webrtc_audio(relayed_track, usuario_id, None))

    # Procesar oferta
    await pc.setRemoteDescription(RTCSessionDescription(sdp=offer, type=tipo))
    
    # CRÍTICO: Iniciar recorder DESPUÉS de setRemoteDescription (patrón oficial aiortc)
    await recorder.start()
    logger.info(' MediaBlackhole iniciado - track debería activarse')
    
    # Crear respuesta
    answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
    
    logger.info(' SDP Answer enviado - esperando conexión ICE...')

    return JsonResponse({
        'success': True,
        'sdp': pc.localDescription.sdp,
        'type': pc.localDescription.type
    })
