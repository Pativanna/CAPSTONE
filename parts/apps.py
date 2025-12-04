from django.apps import AppConfig


class PartsConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'parts'
    
    def ready(self):
        """Importar signals y modelos de inventario cuando la app esté lista"""
        import parts.signals
        import parts.inventory_models  # Asegurar que Django detecte estos modelos
