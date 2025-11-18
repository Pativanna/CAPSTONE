"""
Sistema de Logging Continuo para Transcripciones de Voz
Guarda todas las transcripciones en tiempo real con timestamps
"""

import os
import json
import logging
from datetime import datetime
from pathlib import Path
from django.conf import settings

# Logger estructurado central (configurado en settings.LOGGING)
logger = logging.getLogger('parts.voice')


class VoiceLogger:
    """Maneja el logging continuo de transcripciones de voz"""
    
    def __init__(self):
        # Directorio base para logs
        self.logs_dir = Path(settings.BASE_DIR) / 'voice_logs'
        self.logs_dir.mkdir(exist_ok=True)
        
        # Sesión actual
        self.current_session_id = None
        self.current_log_file = None
        self.session_start_time = None
        # Contadores y secuencia
        self._seq = 0
        self.partial_count = 0
        self.final_count = 0
        self.command_count = 0
    
    def start_new_session(self):
        """Inicia una nueva sesión de logging"""
        self.current_session_id = datetime.now().strftime('%Y%m%d_%H%M%S_%f')
        self.session_start_time = datetime.now()
        self._seq = 0
        self.partial_count = 0
        self.final_count = 0
        self.command_count = 0
        
        # Crear archivo de log para esta sesión
        log_filename = f"session_{self.current_session_id}.jsonl"
        self.current_log_file = self.logs_dir / log_filename
        
        # Escribir metadata de inicio de sesión
        self._write_log({
            'event': 'session_start',
            'session_id': self.current_session_id,
            'timestamp': self.session_start_time.isoformat(),
            'timestamp_unix': self.session_start_time.timestamp(),
            'seq': self._next_seq()
        })
        
        # Log estructurado de inicio de sesión
        logger.info(
            "inicio_sesion_voz",
            extra={
                'event': 'voice_session_start',
                'session_id': self.current_session_id,
                'timestamp_unix': self.session_start_time.timestamp(),
                'partial_count': 0,
                'final_count': 0,
                'command_count': 0
            }
        )
        return self.current_session_id
    
    def log_transcription(self, text, transcription_type='partial', metadata=None):
        """
        Registra una transcripción en el log actual
        
        Args:
            text: Texto transcrito
            transcription_type: 'partial' o 'final'
            metadata: Diccionario con información adicional
        """
        if not self.current_session_id:
            self.start_new_session()
        
        timestamp = datetime.now()
        
        if transcription_type == 'partial':
            self.partial_count += 1
        elif transcription_type == 'final':
            self.final_count += 1

        log_entry = {
            'event': 'transcription',
            'type': transcription_type,
            'text': text,
            'timestamp': timestamp.isoformat(),
            'timestamp_unix': timestamp.timestamp(),
            'session_id': self.current_session_id,
            'seq': self._next_seq(),
            'counters': {
                'partial': self.partial_count,
                'final': self.final_count,
                'command': self.command_count
            }
        }
        
        # Agregar metadata si existe
        if metadata:
            log_entry['metadata'] = metadata
        
        self._write_log(log_entry)
        
        return log_entry
    
    def log_command(self, command_name, command_text):
        """Registra detección de un comando de voz"""
        if not self.current_session_id:
            self.start_new_session()
        
        timestamp = datetime.now()
        self.command_count += 1
        
        log_entry = {
            'event': 'command_detected',
            'command': command_name,
            'text': command_text,
            'timestamp': timestamp.isoformat(),
            'timestamp_unix': timestamp.timestamp(),
            'session_id': self.current_session_id,
            'seq': self._next_seq(),
            'counters': {
                'partial': self.partial_count,
                'final': self.final_count,
                'command': self.command_count
            }
        }
        
        self._write_log(log_entry)
        # Log central del comando detectado
        logger.info(
            "comando_detectado",
            extra={
                'event': 'voice_command',
                'session_id': self.current_session_id,
                'command': command_name,
                'text': command_text,
                'partial_count': self.partial_count,
                'final_count': self.final_count,
                'command_count': self.command_count,
                'timestamp_unix': timestamp.timestamp(),
            }
        )
        
        return log_entry
    
    def close_session(self, reason='part_saved'):
        """
        Cierra la sesión actual de logging
        
        Args:
            reason: Razón del cierre ('part_saved', 'manual', 'timeout')
        """
        if not self.current_session_id:
            return None
        
        timestamp = datetime.now()
        duration = (timestamp - self.session_start_time).total_seconds()
        
        log_entry = {
            'event': 'session_end',
            'session_id': self.current_session_id,
            'reason': reason,
            'timestamp': timestamp.isoformat(),
            'timestamp_unix': timestamp.timestamp(),
            'duration_seconds': duration,
            'seq': self._next_seq(),
            'counters': {
                'partial': self.partial_count,
                'final': self.final_count,
                'command': self.command_count
            }
        }
        
        self._write_log(log_entry)
        logger.info(
            "cierre_sesion_voz",
            extra={
                'event': 'voice_session_end',
                'session_id': self.current_session_id,
                'reason': reason,
                'duration_seconds': duration,
                'partial_count': self.partial_count,
                'final_count': self.final_count,
                'command_count': self.command_count,
                'timestamp_unix': timestamp.timestamp(),
            }
        )
        
        # Resetear estado
        old_session_id = self.current_session_id
        self.current_session_id = None
        self.current_log_file = None
        self.session_start_time = None
        
        return old_session_id
    
    def get_current_session_id(self):
        """Retorna el ID de la sesión actual (o None si no hay sesión activa)"""
        return self.current_session_id
    
    def _write_log(self, log_entry):
        """Escribe una entrada al archivo de log (formato JSONL)"""
        if not self.current_log_file:
            return
        
        try:
            with open(self.current_log_file, 'a', encoding='utf-8') as f:
                f.write(json.dumps(log_entry, ensure_ascii=False) + '\n')
        except Exception as e:
            logger.error(
                "error_escribiendo_log",
                extra={
                    'event': 'voice_log_write_error',
                    'session_id': self.current_session_id,
                    'error': str(e)
                }
            )

    def _next_seq(self) -> int:
        self._seq += 1
        return self._seq
    
    def read_session_log(self, session_id=None):
        """
        Lee el contenido de un log de sesión
        
        Args:
            session_id: ID de la sesión a leer (None = sesión actual)
        
        Returns:
            Lista de entradas de log
        """
        if session_id is None:
            session_id = self.current_session_id
        
        if not session_id:
            return []
        
        log_file = self.logs_dir / f"session_{session_id}.jsonl"
        
        if not log_file.exists():
            return []
        
        entries = []
        try:
            with open(log_file, 'r', encoding='utf-8') as f:
                for line in f:
                    if line.strip():
                        entries.append(json.loads(line))
        except Exception as e:
            logger.error(
                "error_leyendo_log",
                extra={
                    'event': 'voice_log_read_error',
                    'session_id': session_id,
                    'error': str(e)
                }
            )
        
        return entries


# Instancia global del logger
voice_logger = VoiceLogger()
