from django.contrib import admin
from django.contrib.auth.admin import UserAdmin as BaseUserAdmin
from django.contrib.auth.models import User
from .models import (Workshop, Auto, Part, UserProfile, AuditLog, VoiceSession, 
                     VoiceIngestResult, PerfilVozUsuario, OpenAILlamada, EventoSistema)


class UserProfileInline(admin.StackedInline):
    """Perfil embebido dentro del admin de usuarios."""
    model = UserProfile
    can_delete = False
    verbose_name_plural = 'Perfil'
    fk_name = 'user'
    fields = ['role', 'phone', 'created_at', 'updated_at']
    readonly_fields = ['created_at', 'updated_at']


class CustomUserAdmin(BaseUserAdmin):
    """Admin extendido para mostrar datos del perfil sin salir del usuario."""
    inlines = (UserProfileInline,)
    list_display = ['username', 'email', 'get_role', 'first_name', 'last_name', 'is_active', 'is_staff']
    list_filter = ['is_active', 'is_staff', 'is_superuser', 'profile__role']
    
    def get_role(self, obj):
        if hasattr(obj, 'profile'):
            return obj.profile.get_role_display()
        return '-'
    get_role.short_description = 'Rol'
    
    def get_inline_instances(self, request, obj=None):
        if not obj:
            return list()
        return super(CustomUserAdmin, self).get_inline_instances(request, obj)


# Re-register UserAdmin
admin.site.unregister(User)
admin.site.register(User, CustomUserAdmin)


@admin.register(AuditLog)
class AuditLogAdmin(admin.ModelAdmin):
    """Audit log admin - read only"""
    list_display = ['timestamp', 'user', 'action', 'model_name', 'object_id', 'ip_address']
    list_filter = ['action', 'model_name', 'timestamp']
    search_fields = ['user__username', 'description', 'ip_address']
    ordering = ['-timestamp']
    readonly_fields = ['user', 'action', 'model_name', 'object_id', 'description', 'ip_address', 'user_agent', 'timestamp']
    
    def has_add_permission(self, request):
        """Prevent manual creation of audit logs"""
        return False
    
    def has_delete_permission(self, request, obj=None):
        """Prevent deletion of audit logs"""
        return False


# Register existing models if not already registered
try:
    admin.site.register(Workshop)
    admin.site.register(Auto)
    admin.site.register(Part)
except admin.sites.AlreadyRegistered:
    pass


@admin.register(VoiceSession)
class VoiceSessionAdmin(admin.ModelAdmin):
    list_display = ['session_id', 'status', 'started_at', 'ended_at', 'partial_count', 'final_count', 'command_count']
    list_filter = ['status', 'started_at']
    search_fields = ['session_id']
    readonly_fields = ['session_id', 'started_at', 'ended_at', 'partial_count', 'final_count', 'command_count', 'meta']


@admin.register(VoiceIngestResult)
class VoiceIngestResultAdmin(admin.ModelAdmin):
    list_display = ['session', 'pair_key', 'source', 'created_at']
    list_filter = ['source', 'created_at']
    search_fields = ['pair_key', 'session__session_id']
    readonly_fields = ['session', 'pair_key', 'start_ts', 'end_ts', 'transcript', 'fields', 'source', 'created_at']


@admin.register(PerfilVozUsuario)
class PerfilVozUsuarioAdmin(admin.ModelAdmin):
    list_display = ['usuario', 'muestras_totales', 'actualizado_en', 'estado_resumen']
    search_fields = ['usuario__username']
    readonly_fields = ['creado_en', 'actualizado_en']

    def estado_resumen(self, obj):
        return f"{len(obj.estado_adaptacion or '')} chars"
    estado_resumen.short_description = 'Adaptación (resumen)'


@admin.register(OpenAILlamada)
class OpenAILlamadaAdmin(admin.ModelAdmin):
    list_display = ['creado_en', 'tipo', 'modelo', 'exito', 'codigo_http', 'duracion_ms', 'tokens_prompt', 'tokens_respuesta', 'costo_estimado']
    list_filter = ['tipo', 'modelo', 'exito', 'codigo_http', 'creado_en']
    search_fields = ['request_id', 'origen', 'usuario_id']
    readonly_fields = ['creado_en', 'tipo', 'modelo', 'tokens_prompt', 'tokens_respuesta', 'costo_estimado', 'duracion_ms',
                       'exito', 'codigo_http', 'error_texto', 'hash_prompt', 'usuario_id', 'origen', 'request_id', 'meta']


@admin.register(EventoSistema)
class EventoSistemaAdmin(admin.ModelAdmin):
    """Admin para auditoría centralizada del sistema"""
    list_display = ['timestamp', 'categoria', 'nivel', 'accion', 'usuario', 'exito', 'duracion_ms', 'request_id']
    list_filter = ['categoria', 'nivel', 'exito', 'timestamp']
    search_fields = ['accion', 'descripcion', 'request_id', 'usuario__username', 'pieza__name']
    readonly_fields = ['timestamp', 'categoria', 'nivel', 'accion', 'descripcion', 'usuario', 
                      'pieza', 'sesion_voz', 'datos', 'exito', 'error_mensaje', 'duracion_ms',
                      'request_id', 'ip_origen', 'user_agent']
    date_hierarchy = 'timestamp'
    ordering = ['-timestamp']
    
    fieldsets = (
        ('Información Básica', {
            'fields': ('timestamp', 'categoria', 'nivel', 'accion', 'exito')
        }),
        ('Descripción', {
            'fields': ('descripcion', 'error_mensaje')
        }),
        ('Contexto', {
            'fields': ('usuario', 'pieza', 'sesion_voz', 'request_id')
        }),
        ('Datos Adicionales', {
            'fields': ('datos', 'duracion_ms')
        }),
        ('Información del Request', {
            'fields': ('ip_origen', 'user_agent'),
            'classes': ('collapse',)
        }),
    )
    
    def has_add_permission(self, request):
        """Prevenir creación manual de eventos"""
        return False
    
    def has_delete_permission(self, request, obj=None):
        """Prevenir eliminación de eventos"""
        return request.user.is_superuser


