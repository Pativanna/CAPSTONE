# parts/serializers.py
from rest_framework import serializers
from django.db.models import Count
from .models import Part, Workshop, Auto, ReportSchedule


class WorkshopSerializer(serializers.ModelSerializer):
    """Detalle de taller con métricas básicas."""

    total_parts = serializers.SerializerMethodField()
    active_parts = serializers.SerializerMethodField()
    sold_parts = serializers.SerializerMethodField()

    class Meta:
        model = Workshop
        fields = [
            'id', 
            'name', 
            'direction',
            'total_parts',
            'active_parts',
            'sold_parts'
        ]

    def get_total_parts(self, taller):
        return taller.parts.count()

    def get_active_parts(self, taller):
        return taller.parts.filter(sold=False, state=True).count()

    def get_sold_parts(self, taller):
        return taller.parts.filter(sold=True).count()


class AutoSerializer(serializers.ModelSerializer):
    """Ficha resumida de un auto."""

    total_parts = serializers.SerializerMethodField()
    display_name = serializers.SerializerMethodField()

    class Meta:
        model = Auto
        fields = [
            'id',
            'brand_model',
            'year',
            'color',
            'license_plate',
            'date_added',
            'display_name',
            'total_parts'
        ]
        read_only_fields = ['date_added']

    def get_display_name(self, auto):
        return str(auto)

    def get_total_parts(self, auto):
        return auto.parts.count()


class PartListSerializer(serializers.ModelSerializer):
    """Versión liviana para listados y tablas."""

    workshop_name = serializers.CharField(source='workshop.name', read_only=True)
    auto_display = serializers.CharField(source='auto.__str__', read_only=True)
    auto_brand_model = serializers.CharField(source='auto.brand_model', read_only=True)
    auto_year = serializers.IntegerField(source='auto.year', read_only=True)
    
    class Meta:
        model = Part
        fields = [
            'id',
            'name',
            'catalog_name',
            'position',
            'details',
            'sold',
            'sold_at',
            'state',
            'max_value',
            'min_value',
            'date_added',
            'workshop',
            'workshop_name',
            'auto',
            'auto_display',
            'auto_brand_model',
            'auto_year',
            'image'
        ]
        read_only_fields = ['date_added', 'sold_at']


class PartDetailSerializer(serializers.ModelSerializer):
    """Versión completa para alta/edición de piezas."""

    workshop = WorkshopSerializer(read_only=True)
    auto = AutoSerializer(read_only=True)
    
    # IDs para escritura
    workshop_id = serializers.PrimaryKeyRelatedField(
        queryset=Workshop.objects.all(),
        source='workshop',
        write_only=True
    )
    auto_id = serializers.PrimaryKeyRelatedField(
        queryset=Auto.objects.all(),
        source='auto',
        write_only=True
    )
    
    class Meta:
        model = Part
        fields = [
            'id',
            'name',
            'catalog_name',
            'position',
            'details',
            'sold',
            'sold_at',
            'state',
            'max_value',
            'min_value',
            'date_added',
            'image',
            'workshop',
            'workshop_id',
            'auto',
            'auto_id'
        ]
        read_only_fields = ['date_added', 'sold_at']


class ReportScheduleSerializer(serializers.ModelSerializer):
    """Programación de envíos automáticos."""

    recipients_list = serializers.SerializerMethodField()
    
    class Meta:
        model = ReportSchedule
        fields = [
            'id',
            'name',
            'frequency',
            'recipients',
            'recipients_list',
            'last_generated'
        ]
        read_only_fields = ['last_generated']

    def get_recipients_list(self, programacion):
        return [user.email for user in programacion.recipients.all()]


class PartStatsSerializer(serializers.Serializer):
    """Estructura plana para KPI del stock."""

    total_parts = serializers.IntegerField()
    active_parts = serializers.IntegerField()
    sold_parts = serializers.IntegerField()
    total_value = serializers.DecimalField(max_digits=10, decimal_places=2)
    avg_price = serializers.DecimalField(max_digits=10, decimal_places=2)
    min_price = serializers.DecimalField(max_digits=10, decimal_places=2)
    max_price = serializers.DecimalField(max_digits=10, decimal_places=2)
    workshops_count = serializers.IntegerField()
    autos_count = serializers.IntegerField()


class LowStockItemSerializer(serializers.Serializer):
    """Items que requieren reposición."""

    name = serializers.CharField()
    count = serializers.IntegerField()
    workshop_name = serializers.CharField()
    alert_level = serializers.CharField()


class TopSellingPartSerializer(serializers.Serializer):
    """Ranking simple de ventas."""

    name = serializers.CharField()
    sold_count = serializers.IntegerField()
    total_revenue = serializers.DecimalField(max_digits=10, decimal_places=2)
    avg_price = serializers.DecimalField(max_digits=10, decimal_places=2)
