# parts/api_views.py
from rest_framework import viewsets, permissions, status, filters
from rest_framework.decorators import action
from rest_framework.response import Response
from django.db.models import Count, Avg, Sum, Min, Max, Q
from django.utils import timezone
from datetime import timedelta
from .models import Part, Workshop, Auto, ReportSchedule
from .api_permissions import PartInventoryPermission
from .serializers import (
    PartListSerializer, PartDetailSerializer, WorkshopSerializer,
    AutoSerializer, ReportScheduleSerializer, PartStatsSerializer,
    LowStockItemSerializer, TopSellingPartSerializer
)


class PartViewSet(viewsets.ModelViewSet):
    """
    API para el inventario de piezas.

    Incluye endpoints de mantención y utilidades:
    - GET/POST /api/parts/
    - GET/PUT/PATCH/DELETE /api/parts/{id}/
    - POST /api/parts/{id}/mark_sold/
    - POST /api/parts/{id}/mark_available/
    - GET /api/parts/stats/
    - GET /api/parts/low_stock/
    - GET /api/parts/top_selling/
    - GET /api/parts/powerbi_dataset/
    """

    queryset = Part.objects.select_related('workshop', 'auto').all()
    permission_classes = [permissions.IsAuthenticated, PartInventoryPermission]
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ['name', 'details', 'auto__brand_model', 'workshop__name']
    ordering_fields = ['date_added', 'max_value', 'name', 'sold']
    ordering = ['-date_added']

    def get_serializer_class(self):
        """Usa serializer detallado para create/retrieve y uno liviano para list."""
        if self.action in ['retrieve', 'create', 'update', 'partial_update']:
            return PartDetailSerializer
        return PartListSerializer

    def get_queryset(self):
        """Aplica filtros sencillos leídos desde query params."""
        consulta = super().get_queryset()

        taller_id = self.request.query_params.get('workshop')
        if taller_id:
            consulta = consulta.filter(workshop_id=taller_id)

        auto_id = self.request.query_params.get('auto')
        if auto_id:
            consulta = consulta.filter(auto_id=auto_id)

        vendido = self.request.query_params.get('sold')
        if vendido is not None:
            consulta = consulta.filter(sold=vendido.lower() in ['true', '1', 'yes'])

        activo = self.request.query_params.get('state')
        if activo is not None:
            consulta = consulta.filter(state=activo.lower() in ['true', '1', 'yes'])

        precio_min = self.request.query_params.get('min_price')
        if precio_min:
            consulta = consulta.filter(max_value__gte=precio_min)

        precio_max = self.request.query_params.get('max_price')
        if precio_max:
            consulta = consulta.filter(max_value__lte=precio_max)

        fecha_desde = self.request.query_params.get('date_from')
        if fecha_desde:
            consulta = consulta.filter(date_added__gte=fecha_desde)

        fecha_hasta = self.request.query_params.get('date_to')
        if fecha_hasta:
            consulta = consulta.filter(date_added__lte=fecha_hasta)

        return consulta

    @action(detail=True, methods=['post'])
    def mark_sold(self, request, pk=None):
        """Marca una pieza como vendida."""
        pieza = self.get_object()

        if pieza.sold:
            return Response(
                {'detail': 'La pieza ya está marcada como vendida.'},
                status=status.HTTP_400_BAD_REQUEST
            )

        pieza.sold = True
        pieza.sold_at = timezone.now()
        pieza.save()

        return Response({
            'status': 'success',
            'message': 'Pieza marcada como vendida',
            'id': pieza.id,
            'sold_at': pieza.sold_at
        })

    @action(detail=True, methods=['post'])
    def mark_available(self, request, pk=None):
        """Revierte la venta de una pieza."""
        pieza = self.get_object()

        if not pieza.sold:
            return Response(
                {'detail': 'La pieza ya está disponible.'},
                status=status.HTTP_400_BAD_REQUEST
            )

        pieza.sold = False
        pieza.save()

        return Response({
            'status': 'success',
            'message': 'Pieza marcada como disponible',
            'id': pieza.id
        })

    @action(detail=False, methods=['get'])
    def stats(self, request):
        """Snapshot general del inventario."""
        piezas = Part.objects.all()

        total_piezas = piezas.count()
        piezas_activas = piezas.filter(sold=False, state=True).count()
        piezas_vendidas = piezas.filter(sold=True).count()

        resumen_precios = piezas.aggregate(
            total_value=Sum('max_value'),
            avg_price=Avg('max_value'),
            min_price=Min('max_value'),
            max_price=Max('max_value')
        )

        total_talleres = Workshop.objects.count()
        total_autos = Auto.objects.count()

        data = {
            'total_parts': total_piezas,
            'active_parts': piezas_activas,
            'sold_parts': piezas_vendidas,
            'total_value': resumen_precios['total_value'] or 0,
            'avg_price': resumen_precios['avg_price'] or 0,
            'min_price': resumen_precios['min_price'] or 0,
            'max_price': resumen_precios['max_price'] or 0,
            'workshops_count': total_talleres,
            'autos_count': total_autos
        }

        serializer = PartStatsSerializer(data)
        return Response(serializer.data)

    @action(detail=False, methods=['get'])
    def low_stock(self, request):
        """Piezas con bajo stock (menos de 5 unidades por nombre)."""
        umbral = int(request.query_params.get('threshold', 5))

        piezas_bajas = (
            Part.objects.filter(state=True, sold=False)
            .values('name', 'workshop__name')
            .annotate(count=Count('id'))
            .filter(count__lt=umbral)
            .order_by('count')
        )

        alerta = []
        for fila in piezas_bajas:
            nivel = 'critical' if fila['count'] <= 1 else 'warning'
            alerta.append({
                'name': fila['name'],
                'count': fila['count'],
                'workshop_name': fila['workshop__name'] or 'Sin taller',
                'alert_level': nivel
            })

        serializer = LowStockItemSerializer(alerta, many=True)
        return Response(serializer.data)
    
    @action(detail=False, methods=['get'])
    def top_selling(self, request):
        """Ranking de piezas vendidas en un rango corto."""
        limite = int(request.query_params.get('limit', 10))
        dias = int(request.query_params.get('days', 30))
        fecha_corte = timezone.now() - timedelta(days=dias)

        ranking = (
            Part.objects.filter(sold=True, sold_at__gte=fecha_corte)
            .values('name')
            .annotate(
                sold_count=Count('id'),
                total_revenue=Sum('max_value'),
                avg_price=Avg('max_value')
            )
            .order_by('-sold_count')[:limite]
        )

        serializer = TopSellingPartSerializer(ranking, many=True)
        return Response(serializer.data)
    
    @action(detail=False, methods=['get'])
    def powerbi_dataset(self, request):
        """
        Dataset optimizado para Power BI.
        Retorna datos planos con todas las relaciones resueltas.
        """
        piezas = self.get_queryset()

        payload = []
        for pieza in piezas:
            payload.append({
                'PartID': pieza.id,
                'PartName': pieza.name,
                'CatalogName': pieza.catalog_name or '',
                'Position': pieza.position or '',
                'Details': pieza.details or '',
                'Workshop': pieza.workshop.name if pieza.workshop else 'N/A',
                'WorkshopLocation': pieza.workshop.direction if pieza.workshop else 'N/A',
                'AutoBrandModel': pieza.auto.brand_model if pieza.auto else 'N/A',
                'AutoYear': pieza.auto.year if pieza.auto else None,
                'AutoColor': pieza.auto.color if pieza.auto else 'N/A',
                'AutoLicensePlate': pieza.auto.license_plate if pieza.auto else 'N/A',
                'Price': float(pieza.max_value or 0),
                'MinPrice': float(pieza.min_value or 0),
                'Sold': pieza.sold,
                'State': pieza.state,
                'DateAdded': pieza.date_added.isoformat(),
                'SoldAt': pieza.sold_at.isoformat() if pieza.sold_at else None,
                'MonthAdded': pieza.date_added.strftime('%Y-%m'),
                'YearAdded': pieza.date_added.year,
                'DayOfWeek': pieza.date_added.strftime('%A'),
                'HasImage': bool(pieza.image),
            })
        
        return Response(payload)


class WorkshopViewSet(viewsets.ModelViewSet):
    """
    API ViewSet para gestión de talleres.
    
    Endpoints:
    - GET /api/workshops/ - Listar talleres
    - POST /api/workshops/ - Crear taller
    - GET /api/workshops/{id}/ - Detalle de taller
    - PUT /api/workshops/{id}/ - Actualizar taller
    - DELETE /api/workshops/{id}/ - Eliminar taller
    - GET /api/workshops/{id}/parts/ - Piezas del taller
    - GET /api/workshops/{id}/stats/ - Estadísticas del taller
    """
    
    queryset = Workshop.objects.all()
    serializer_class = WorkshopSerializer
    permission_classes = [permissions.IsAuthenticated]
    filter_backends = [filters.SearchFilter]
    search_fields = ['name', 'direction']
    
    @action(detail=True, methods=['get'])
    def parts(self, request, pk=None):
        """Obtiene todas las piezas de un taller."""
        taller = self.get_object()
        piezas = taller.parts.select_related('auto').all()

        vendido = request.query_params.get('sold')
        if vendido is not None:
            piezas = piezas.filter(sold=vendido.lower() in ['true', '1', 'yes'])

        serializer = PartListSerializer(piezas, many=True)
        return Response(serializer.data)
    
    @action(detail=True, methods=['get'])
    def stats(self, request, pk=None):
        """Estadísticas del taller."""
        taller = self.get_object()
        piezas = taller.parts.all()

        total_piezas = piezas.count()
        piezas_activas = piezas.filter(sold=False, state=True).count()
        piezas_vendidas = piezas.filter(sold=True).count()

        resumen = piezas.aggregate(
            total_value=Sum('max_value'),
            avg_price=Avg('max_value')
        )
        
        return Response({
            'workshop': WorkshopSerializer(taller).data,
            'total_parts': total_piezas,
            'active_parts': piezas_activas,
            'sold_parts': piezas_vendidas,
            'total_value': resumen['total_value'] or 0,
            'avg_price': resumen['avg_price'] or 0
        })


class AutoViewSet(viewsets.ModelViewSet):
    """
    API ViewSet para gestión de autos.
    
    Endpoints:
    - GET /api/autos/ - Listar autos
    - POST /api/autos/ - Crear auto
    - GET /api/autos/{id}/ - Detalle de auto
    - PUT /api/autos/{id}/ - Actualizar auto
    - DELETE /api/autos/{id}/ - Eliminar auto
    - GET /api/autos/{id}/parts/ - Piezas del auto
    """
    
    queryset = Auto.objects.all()
    serializer_class = AutoSerializer
    permission_classes = [permissions.IsAuthenticated]
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ['brand_model', 'license_plate', 'color']
    ordering_fields = ['year', 'brand_model', 'date_added']
    ordering = ['-year']
    
    def get_queryset(self):
        """Aplica filtros desde query params."""
        consulta = super().get_queryset()

        year = self.request.query_params.get('year')
        if year:
            consulta = consulta.filter(year=year)

        year_from = self.request.query_params.get('year_from')
        if year_from:
            consulta = consulta.filter(year__gte=year_from)

        year_to = self.request.query_params.get('year_to')
        if year_to:
            consulta = consulta.filter(year__lte=year_to)

        return consulta
    
    @action(detail=True, methods=['get'])
    def parts(self, request, pk=None):
        """Obtiene todas las piezas de un auto."""
        auto_obj = self.get_object()
        piezas = auto_obj.parts.select_related('workshop').all()

        serializer = PartListSerializer(piezas, many=True)
        return Response(serializer.data)


class ReportScheduleViewSet(viewsets.ModelViewSet):
    """
    API ViewSet para programación de reportes.
    
    Endpoints:
    - GET /api/report-schedules/ - Listar programaciones
    - POST /api/report-schedules/ - Crear programación
    - GET /api/report-schedules/{id}/ - Detalle
    - PUT /api/report-schedules/{id}/ - Actualizar
    - DELETE /api/report-schedules/{id}/ - Eliminar
    """
    
    queryset = ReportSchedule.objects.all()
    serializer_class = ReportScheduleSerializer
    permission_classes = [permissions.IsAuthenticated]
