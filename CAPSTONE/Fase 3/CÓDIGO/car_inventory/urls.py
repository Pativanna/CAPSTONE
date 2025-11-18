from django.contrib import admin
from django.urls import path, include
from django.conf import settings
from django.conf.urls.static import static
from rest_framework.routers import DefaultRouter
from rest_framework.authtoken.views import obtain_auth_token
from drf_spectacular.views import SpectacularAPIView, SpectacularSwaggerView, SpectacularRedocView
from parts.api_views import PartViewSet, WorkshopViewSet, AutoViewSet, ReportScheduleViewSet

# Router para API REST
router = DefaultRouter()
router.register(r'parts', PartViewSet, basename='part')
router.register(r'workshops', WorkshopViewSet, basename='workshop')
router.register(r'autos', AutoViewSet, basename='auto')
router.register(r'report-schedules', ReportScheduleViewSet, basename='reportschedule')

urlpatterns = [
    path('admin/', admin.site.urls),
    
    # API REST
    path('api/', include(router.urls)),
    path('api/auth/token/', obtain_auth_token, name='api-token-auth'),
    
    # Documentación API
    path('api/schema/', SpectacularAPIView.as_view(), name='schema'),
    path('api/docs/', SpectacularSwaggerView.as_view(url_name='schema'), name='swagger-ui'),
    path('api/redoc/', SpectacularRedocView.as_view(url_name='schema'), name='redoc'),
    
    # COMPATIBILIDAD: incluir conjunto reducido sin namespace (tests legacy)
    path('', include('parts.urls_plain')),
    # Namespace explícito completo "parts:..."
    path('', include(('parts.urls', 'parts'), namespace='parts')),
]

if settings.DEBUG:
    urlpatterns += static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)
