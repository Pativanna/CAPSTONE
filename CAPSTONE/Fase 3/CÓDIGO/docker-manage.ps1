# Script de ayuda para gestionar el despliegue Docker en Windows
# Ejecutar con: .\docker-manage.ps1

param(
    [Parameter(Position=0)]
    [string]$Command
)

function Write-Success {
    param([string]$Message)
    Write-Host "✓ $Message" -ForegroundColor Green
}

function Write-Error-Custom {
    param([string]$Message)
    Write-Host "✗ $Message" -ForegroundColor Red
}

function Write-Info {
    param([string]$Message)
    Write-Host "ℹ $Message" -ForegroundColor Yellow
}

function Check-Docker {
    try {
        $null = docker --version
        $null = docker-compose --version
        Write-Success "Docker y Docker Compose están instalados"
        return $true
    } catch {
        Write-Error-Custom "Docker o Docker Compose no están instalados"
        return $false
    }
}

function Setup-Env {
    if (-not (Test-Path .env)) {
        Write-Info "Creando archivo .env..."
        Copy-Item .env.example .env
        Write-Success "Archivo .env creado. Por favor, edítalo con tus valores"
        Write-Info "Puedes usar 'notepad .env' para editarlo"
        return $false
    } else {
        Write-Success "Archivo .env ya existe"
        return $true
    }
}

function First-Deploy {
    Write-Info "Iniciando primera instalación..."
    
    if (-not (Check-Docker)) {
        return
    }
    
    if (-not (Setup-Env)) {
        Write-Info "Por favor, edita el archivo .env y vuelve a ejecutar el script"
        return
    }
    
    Write-Info "Construyendo imágenes Docker..."
    docker-compose build
    
    Write-Info "Aplicando migraciones..."
    docker-compose run --rm web python manage.py migrate
    
    Write-Info "Recolectando archivos estáticos..."
    docker-compose run --rm web python manage.py collectstatic --noinput
    
    $response = Read-Host "¿Deseas crear un superusuario? (s/n)"
    if ($response -eq 's' -or $response -eq 'S') {
        docker-compose run --rm web python manage.py createsuperuser
    }
    
    Write-Info "Iniciando servicios..."
    docker-compose up -d
    
    Write-Success "¡Despliegue completado!"
    Write-Info "Accede a tu aplicación en: http://localhost"
}

function Update-Deploy {
    Write-Info "Actualizando aplicación..."
    
    Write-Info "Deteniendo servicios..."
    docker-compose down
    
    Write-Info "Reconstruyendo imagen..."
    docker-compose build web
    
    Write-Info "Aplicando migraciones..."
    docker-compose run --rm web python manage.py migrate
    
    Write-Info "Recolectando archivos estáticos..."
    docker-compose run --rm web python manage.py collectstatic --noinput
    
    Write-Info "Iniciando servicios..."
    docker-compose up -d
    
    Write-Success "¡Actualización completada!"
}

function Show-Logs {
    docker-compose logs -f
}

function Stop-Services {
    Write-Info "Deteniendo servicios..."
    docker-compose stop
    Write-Success "Servicios detenidos"
}

function Start-Services {
    Write-Info "Iniciando servicios..."
    docker-compose start
    Write-Success "Servicios iniciados"
}

function Restart-Services {
    Write-Info "Reiniciando servicios..."
    docker-compose restart
    Write-Success "Servicios reiniciados"
}

function Show-Status {
    docker-compose ps
}

function Cleanup {
    $response = Read-Host "¿Estás seguro de que quieres eliminar todos los contenedores y volúmenes? (s/n)"
    if ($response -eq 's' -or $response -eq 'S') {
        docker-compose down -v
        Write-Success "Limpieza completada"
    } else {
        Write-Info "Limpieza cancelada"
    }
}

function Backup-Database {
    $backupDir = "backups"
    if (-not (Test-Path $backupDir)) {
        New-Item -ItemType Directory -Path $backupDir | Out-Null
    }
    
    $timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
    $backupFile = "$backupDir\db_backup_$timestamp.sqlite3"
    
    Write-Info "Creando backup de la base de datos..."
    docker-compose exec -T web cat db.sqlite3 | Set-Content -Path $backupFile -Encoding Byte
    Write-Success "Backup guardado en: $backupFile"
}

function Show-Menu {
    Write-Host ""
    Write-Host "╔════════════════════════════════════════╗" -ForegroundColor Cyan
    Write-Host "║   Car Inventory - Docker Manager      ║" -ForegroundColor Cyan
    Write-Host "╚════════════════════════════════════════╝" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "1) Primera instalación (setup completo)"
    Write-Host "2) Actualizar aplicación"
    Write-Host "3) Ver logs"
    Write-Host "4) Ver estado de servicios"
    Write-Host "5) Iniciar servicios"
    Write-Host "6) Detener servicios"
    Write-Host "7) Reiniciar servicios"
    Write-Host "8) Crear backup de base de datos"
    Write-Host "9) Limpiar todo (⚠️ elimina datos)"
    Write-Host "0) Salir"
    Write-Host ""
}

function Main-Menu {
    while ($true) {
        Show-Menu
        $option = Read-Host "Selecciona una opción"
        
        switch ($option) {
            "1" { First-Deploy }
            "2" { Update-Deploy }
            "3" { Show-Logs }
            "4" { Show-Status }
            "5" { Start-Services }
            "6" { Stop-Services }
            "7" { Restart-Services }
            "8" { Backup-Database }
            "9" { Cleanup }
            "0" { 
                Write-Info "¡Hasta luego!"
                return
            }
            default { Write-Error-Custom "Opción inválida" }
        }
        
        Write-Host ""
        Read-Host "Presiona Enter para continuar"
    }
}

# Ejecutar comando si se proporciona
if ($Command) {
    switch ($Command) {
        "deploy" { First-Deploy }
        "update" { Update-Deploy }
        "logs" { Show-Logs }
        "status" { Show-Status }
        "start" { Start-Services }
        "stop" { Stop-Services }
        "restart" { Restart-Services }
        "backup" { Backup-Database }
        "clean" { Cleanup }
        default {
            Write-Host "Uso: .\docker-manage.ps1 [deploy|update|logs|status|start|stop|restart|backup|clean]"
            exit 1
        }
    }
} else {
    Main-Menu
}
