"""Vistas de autenticación y gestión de usuarios."""

from django.conf import settings
from django.contrib.auth import login, logout, authenticate
from django.contrib.auth.decorators import login_required
from django.contrib.auth.models import User
from django.contrib import messages
from django.shortcuts import render, redirect
from django.urls import reverse
from django.utils.http import url_has_allowed_host_and_scheme
from django.views.decorators.csrf import csrf_protect
from django.views.decorators.cache import never_cache
from .models import UserProfile, AuditLog
from .utils.privacy import anonymize_ip


def obtener_ip_cliente(request):
    """Devuelve la IP anonimizada del usuario considerando proxies."""
    proxy_chain = request.META.get('HTTP_X_FORWARDED_FOR')
    if proxy_chain:
        raw_ip = proxy_chain.split(',')[0].strip()
    else:
        raw_ip = request.META.get('REMOTE_ADDR')
    return anonymize_ip(raw_ip)


def registrar_en_bitacora(user, action, model_name='User', object_id=None, description='', request=None):
    """Guarda un movimiento en AuditLog."""
    AuditLog.objects.create(
        user=user,
        action=action,
        model_name=model_name,
        object_id=object_id,
        description=description,
        ip_address=obtener_ip_cliente(request) if request else None,
        user_agent=request.META.get('HTTP_USER_AGENT', '')[:256] if request else ''
    )


def _allowed_hosts(request):
    """Devuelve el conjunto de hosts permitidos para redirecciones."""
    hosts = {request.get_host()}
    for host in getattr(settings, 'ALLOWED_HOSTS', []):
        if host and host != '*':
            hosts.add(host)
    return hosts


def _sanitize_next_url(request, candidate):
    """Valida que la URL de destino permanezca en el dominio controlado."""
    if not candidate:
        return ''
    allowed_hosts = _allowed_hosts(request)
    if url_has_allowed_host_and_scheme(candidate, allowed_hosts=allowed_hosts, require_https=request.is_secure()):
        return candidate
    return ''


def _resolve_login_redirect(request):
    """Determina un destino seguro posterior al login."""
    candidate = request.POST.get('next') or request.GET.get('next')
    safe_next = _sanitize_next_url(request, candidate)
    return safe_next or reverse('parts:part_list')


@csrf_protect
@never_cache
def login_view(request):
    """Pantalla de ingreso al sistema."""
    if request.user.is_authenticated:
        return redirect('parts:part_list')
    
    next_hint = ''
    if request.method == 'POST':
        next_hint = _sanitize_next_url(request, request.POST.get('next'))
    else:
        next_hint = _sanitize_next_url(request, request.GET.get('next'))

    if request.method == 'POST':
        username = request.POST.get('username')
        password = request.POST.get('password')
        
        usuario = authenticate(request, username=username, password=password)

        if usuario and usuario.is_active:
            login(request, usuario)
            registrar_en_bitacora(usuario, AuditLog.Action.LOGIN, description='Ingreso exitoso', request=request)
            destino = _resolve_login_redirect(request)
            return redirect(destino)

        messages.error(request, 'Usuario o contraseña incorrectos.')
        if username:
            try:
                registrado = User.objects.get(username=username)
                registrar_en_bitacora(
                    registrado,
                    AuditLog.Action.LOGIN,
                    description='Intento de login fallido',
                    request=request
                )
            except User.DoesNotExist:
                pass
    
    return render(request, 'parts/login.html', {'next': next_hint})


@login_required
def logout_view(request):
    """Cierra sesión y deja registro."""
    registrar_en_bitacora(request.user, AuditLog.Action.LOGOUT, description='Logout exitoso', request=request)
    logout(request)
    return redirect('parts:login')


def es_admin(user):
    """Valida si el usuario tiene permisos de administración."""
    if not user.is_authenticated:
        return False
    perfil = getattr(user, 'profile', None)
    return bool(user.is_superuser or (perfil and perfil.is_admin))


def _enforce_admin_access(request):
    """Devuelve respuesta 403 amigable si el usuario no es admin."""
    if es_admin(request.user):
        return None
    return render(request, 'parts/access_denied.html', {
        'title': 'Acceso restringido',
        'message': 'Solo el administrador puede realizar esta acción.'
    }, status=403)


@login_required
def user_create(request):
    """Crear un usuario nuevo (solo admin)."""
    bloqueo = _enforce_admin_access(request)
    if bloqueo:
        return bloqueo
    if request.method == 'POST':
        username = request.POST.get('username')
        email = request.POST.get('email')
        password = request.POST.get('password')
        password_confirm = request.POST.get('password_confirm')
        first_name = request.POST.get('first_name')
        last_name = request.POST.get('last_name')
        phone = request.POST.get('phone')
        role = request.POST.get('role', UserProfile.Role.VENTAS)
        is_active = request.POST.get('is_active') == 'on'
        
        # Validations
        if not username or not password:
            messages.error(request, 'Usuario y contraseña son obligatorios.')
        elif password != password_confirm:
            messages.error(request, 'Las contraseñas no coinciden.')
        elif User.objects.filter(username=username).exists():
            messages.error(request, f'El usuario "{username}" ya existe.')
        elif len(password) < 8:
            messages.error(request, 'La contraseña debe tener al menos 8 caracteres.')
        else:
            # Create user
            user = User.objects.create_user(
                username=username,
                email=email,
                password=password,
                first_name=first_name,
                last_name=last_name,
                is_active=is_active
            )
            
            # Create/update profile
            profile, created = UserProfile.objects.get_or_create(user=user)
            profile.role = role
            profile.phone = phone
            profile.save()
            
            # Log user creation
            registrar_en_bitacora(
                request.user, 
                AuditLog.Action.CREATE,
                model_name='User',
                object_id=user.id,
                description=f'Usuario creado: {username} ({UserProfile.Role(role).label})',
                request=request
            )
            
            messages.success(request, f'Usuario "{username}" creado exitosamente.')
            return redirect('parts:user_list')
    
    # Pass role choices to template
    roles = UserProfile.Role.choices
    return render(request, 'parts/user_create.html', {'roles': roles})


@login_required
def user_list(request):
    """Listado completo de usuarios (solo admin)."""
    bloqueo = _enforce_admin_access(request)
    if bloqueo:
        return bloqueo
    usuarios = User.objects.select_related('profile').order_by('-date_joined')
    for usr in usuarios:
        if not hasattr(usr, 'profile'):
            UserProfile.objects.create(
                user=usr,
                role=UserProfile.Role.ADMIN if usr.is_superuser else UserProfile.Role.VENTAS
            )
    return render(request, 'parts/user_list.html', {'users': usuarios})


@login_required
def user_edit(request, user_id):
    """Editar un usuario existente."""
    bloqueo = _enforce_admin_access(request)
    if bloqueo:
        return bloqueo
    user = User.objects.get(id=user_id)

    if request.method == 'POST':
        user.email = request.POST.get('email', '')
        user.first_name = request.POST.get('first_name', '')
        user.last_name = request.POST.get('last_name', '')
        user.is_active = request.POST.get('is_active') == 'on'
        
        # Update password if provided
        new_password = request.POST.get('new_password')
        if new_password:
            if len(new_password) >= 8:
                user.set_password(new_password)
            else:
                messages.error(request, 'La contraseña debe tener al menos 8 caracteres.')
                return redirect('parts:user_edit', user_id=user_id)
        
        user.save()

        perfil = user.profile
        perfil.role = request.POST.get('role', perfil.role)
        perfil.phone = request.POST.get('phone', '')
        perfil.save()

        registrar_en_bitacora(
            request.user,
            AuditLog.Action.UPDATE,
            model_name='User',
            object_id=user.id,
            description=f'Usuario actualizado: {user.username}',
            request=request
        )
        
        messages.success(request, f'Usuario "{user.username}" actualizado.')
        return redirect('parts:user_list')
    
    roles = UserProfile.Role.choices
    return render(request, 'parts/user_edit.html', {'user_obj': user, 'roles': roles})


@login_required
def user_delete(request, user_id):
    """Elimina un usuario (no permite auto-eliminación)."""
    bloqueo = _enforce_admin_access(request)
    if bloqueo:
        return bloqueo
    user = User.objects.get(id=user_id)

    if user.id == request.user.id:
        messages.error(request, 'No puedes eliminar tu propia cuenta.')
        return redirect('parts:user_list')

    if request.method == 'POST':
        username = user.username

        registrar_en_bitacora(
            request.user,
            AuditLog.Action.DELETE,
            model_name='User',
            object_id=user.id,
            description=f'Usuario eliminado: {username}',
            request=request
        )
        
        user.delete()
        messages.success(request, f'Usuario "{username}" eliminado.')
        return redirect('parts:user_list')
    
    return render(request, 'parts/user_delete.html', {'user_obj': user})
