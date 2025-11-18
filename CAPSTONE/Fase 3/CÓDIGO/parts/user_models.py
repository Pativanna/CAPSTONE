"""
User profile models for role-based access control (RBAC)
"""
from django.contrib.auth.models import User
from django.db import models
from django.db.models.signals import post_save
from django.dispatch import receiver


class UserProfile(models.Model):
    """
    Extended user profile with role-based permissions
    """
    
    class Role(models.TextChoices):
        ADMIN = 'ADMIN', 'Administrador'
        BODEGA = 'BODEGA', 'Bodeguero'
        VENTAS = 'VENTAS', 'Ventas'
    
    user = models.OneToOneField(
        User,
        on_delete=models.CASCADE,
        related_name='profile',
        verbose_name="Usuario"
    )
    
    role = models.CharField(
        max_length=10,
        choices=Role.choices,
        default=Role.VENTAS,
        verbose_name="Rol"
    )
    
    phone = models.CharField(
        max_length=20,
        blank=True,
        null=True,
        verbose_name="Teléfono"
    )
    
    created_at = models.DateTimeField(
        auto_now_add=True,
        verbose_name="Fecha de creación"
    )
    
    updated_at = models.DateTimeField(
        auto_now=True,
        verbose_name="Última actualización"
    )
    
    class Meta:
        verbose_name = "Perfil de usuario"
        verbose_name_plural = "Perfiles de usuario"
        ordering = ['-created_at']
    
    def __str__(self):
        return f"{self.user.username} ({self.get_role_display()})"
    
    @property
    def is_admin(self):
        """Check if user is admin"""
        return self.role == self.Role.ADMIN or self.user.is_superuser
    
    @property
    def is_bodega(self):
        """Check if user is warehouse staff"""
        return self.role == self.Role.BODEGA
    
    @property
    def is_ventas(self):
        """Check if user is sales staff"""
        return self.role == self.Role.VENTAS
    
    def can_manage_users(self):
        """Only admin can manage users"""
        return self.is_admin
    
    def can_add_parts(self):
        """Admin and Bodega can add parts"""
        return self.role in [self.Role.ADMIN, self.Role.BODEGA] or self.user.is_superuser
    
    def can_edit_parts(self):
        """Admin and Bodega can edit parts"""
        return self.role in [self.Role.ADMIN, self.Role.BODEGA] or self.user.is_superuser
    
    def can_delete_parts(self):
        """Only Admin can delete parts"""
        return self.is_admin
    
    def can_view_parts(self):
        """All users can view parts"""
        return True
    
    def can_sell_parts(self):
        """Admin and Ventas can mark parts as sold"""
        return self.role in [self.Role.ADMIN, self.Role.VENTAS] or self.user.is_superuser


# Signal to create user profile automatically
@receiver(post_save, sender=User)
def create_user_profile(sender, instance, created, **kwargs):
    """Create UserProfile when User is created"""
    if created:
        # Set role to ADMIN for superusers, VENTAS for others
        role = UserProfile.Role.ADMIN if instance.is_superuser else UserProfile.Role.VENTAS
        UserProfile.objects.create(user=instance, role=role)


@receiver(post_save, sender=User)
def save_user_profile(sender, instance, **kwargs):
    """Save UserProfile when User is saved"""
    if hasattr(instance, 'profile'):
        instance.profile.save()


class AuditLog(models.Model):
    """
    Audit log for tracking user actions
    """
    
    class Action(models.TextChoices):
        CREATE = 'CREATE', 'Crear'
        UPDATE = 'UPDATE', 'Actualizar'
        DELETE = 'DELETE', 'Eliminar'
        VIEW = 'VIEW', 'Ver'
        LOGIN = 'LOGIN', 'Iniciar sesión'
        LOGOUT = 'LOGOUT', 'Cerrar sesión'
    
    user = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True,
        related_name='audit_logs',
        verbose_name="Usuario"
    )
    
    action = models.CharField(
        max_length=10,
        choices=Action.choices,
        verbose_name="Acción"
    )
    
    model_name = models.CharField(
        max_length=50,
        verbose_name="Modelo",
        help_text="Nombre del modelo afectado (Part, Auto, Workshop, etc.)"
    )
    
    object_id = models.IntegerField(
        null=True,
        blank=True,
        verbose_name="ID del objeto"
    )
    
    description = models.TextField(
        blank=True,
        verbose_name="Descripción"
    )
    
    ip_address = models.GenericIPAddressField(
        null=True,
        blank=True,
        verbose_name="Dirección IP"
    )
    
    user_agent = models.TextField(
        blank=True,
        verbose_name="User Agent"
    )
    
    timestamp = models.DateTimeField(
        auto_now_add=True,
        verbose_name="Fecha y hora"
    )
    
    class Meta:
        verbose_name = "Log de auditoría"
        verbose_name_plural = "Logs de auditoría"
        ordering = ['-timestamp']
        indexes = [
            models.Index(fields=['-timestamp']),
            models.Index(fields=['user', '-timestamp']),
        ]
    
    def __str__(self):
        username = self.user.username if self.user else "Sistema"
        return f"{username} - {self.get_action_display()} - {self.model_name} - {self.timestamp}"
