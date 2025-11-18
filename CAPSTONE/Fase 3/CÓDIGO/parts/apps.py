from django.apps import AppConfig


class PartsConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'parts'
    
    def ready(self):
        """Importar signals cuando la app esté lista"""
        import parts.signals
