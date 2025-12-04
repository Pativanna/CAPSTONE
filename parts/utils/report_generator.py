# parts/utils/report_generator.py
from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.lib.units import cm
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak
from reportlab.graphics.shapes import Drawing
from reportlab.graphics.charts.barcharts import VerticalBarChart
from reportlab.graphics.charts.piecharts import Pie
from django.utils import timezone
from django.db.models import Count, Sum, Avg, Q, F
from parts.models import Part, Workshop, Auto
import io
import datetime

PRIMARY = colors.HexColor("#0069BC")
SECONDARY = colors.HexColor("#00A86B")
WARNING = colors.HexColor("#FFA500")
DANGER = colors.HexColor("#DC3545")
TEXT_GRAY = colors.HexColor("#444444")
BG_GRAY = colors.whitesmoke


def _format_currency(valor):
    """Formatea un número como precio en pesos chilenos: $999.999.999"""
    if valor is None:
        return "$0"
    try:
        valor_int = int(valor)
        # Formatear con separador de miles usando puntos
        valor_str = f"{valor_int:,}".replace(",", ".")
        return f"${valor_str}"
    except (ValueError, TypeError):
        return "$0"


def formato_precio_chileno(valor):
    """Formatea un número como precio en pesos chilenos: $999.999.999"""
    if valor is None:
        return "$0"
    try:
        valor_int = int(valor)
        # Formatear con separador de miles
        valor_str = f"{valor_int:,}".replace(",", ".")
        return f"${valor_str}"
    except (ValueError, TypeError):
        return "$0"


def _get_time_filter(frequency: str):
    """Retorna start y end como objetos datetime con timezone."""
    now = timezone.now()
    today = now.date()
    
    if frequency == "daily":
        start = today
    elif frequency == "weekly":
        start = today - datetime.timedelta(days=7)
    elif frequency == "monthly":
        start = today - datetime.timedelta(days=30)
    else:
        start = today - datetime.timedelta(days=365)
    
    # Convertir a datetime con timezone para evitar warnings
    start_dt = timezone.make_aware(datetime.datetime.combine(start, datetime.time.min))
    end_dt = timezone.make_aware(datetime.datetime.combine(today, datetime.time.max))
    
    return start_dt, end_dt


def _get_previous_period(start, end):
    """Retorna el período anterior con la misma duración para comparación."""
    duration = (end - start).days
    prev_end = start - datetime.timedelta(days=1)
    prev_start = prev_end - datetime.timedelta(days=duration)
    return prev_start, prev_end


def _bar_chart(title, labels, values, color=PRIMARY, height=7*cm, width=14*cm):
    """Retorna un Drawing de ReportLab con un gráfico de barras."""
    drawing = Drawing(width, height)
    chart = VerticalBarChart()
    chart.x = 1*cm
    chart.y = 1*cm
    chart.height = height - 2*cm
    chart.width = width - 3*cm
    chart.data = [values]
    chart.categoryAxis.categoryNames = labels
    chart.barWidth = 0.5*cm
    chart.valueAxis.valueMin = 0
    chart.bars[0].fillColor = color
    chart.categoryAxis.labels.boxAnchor = 'ne'
    chart.categoryAxis.labels.angle = 45
    chart.categoryAxis.labels.dy = -15
    chart.categoryAxis.labels.fontName = 'Helvetica'
    chart.categoryAxis.labels.fontSize = 8
    drawing.add(chart)
    return drawing


def _pie_chart(title, labels, values, colors_list=None, height=7*cm, width=14*cm):
    """Retorna un Drawing de ReportLab con un gráfico de pastel."""
    if not colors_list:
        colors_list = [PRIMARY, SECONDARY, WARNING, DANGER, colors.purple, colors.orange]
    
    drawing = Drawing(width, height)
    pie = Pie()
    pie.x = 3*cm
    pie.y = 1*cm
    pie.width = 6*cm
    pie.height = 6*cm
    pie.data = values
    pie.labels = [f"{l}\n({v})" for l, v in zip(labels, values)]
    pie.slices.strokeWidth = 0.5
    
    # Aplicar colores
    for i, color in enumerate(colors_list[:len(values)]):
        pie.slices[i].fillColor = color
    
    drawing.add(pie)
    return drawing


def generate_report_bytes(frequency: str = "weekly") -> bytes:
    """
    Genera un PDF profesional multi-página con análisis exhaustivo.
    
    CARACTERÍSTICAS COMPLETAS:
    - KPIs con comparativa vs período anterior
    - Análisis de precios (min/max/promedio/total)
    - Métricas de rendimiento (conversión, rotación)
    - Top 10 piezas más vendidas con ingresos
    - Top 10 modelos de autos más comunes
    - Gráficos de barras y pastel
    - Análisis por taller detallado
    - Proyecciones y tendencias
    """
    buffer = io.BytesIO()
    doc = SimpleDocTemplate(
        buffer,
        pagesize=A4,
        leftMargin=2*cm,
        rightMargin=2*cm,
        topMargin=2*cm,
        bottomMargin=2*cm,
        title="InventoryEye Report - Transervis",
    )

    styles = getSampleStyleSheet()
    styles.add(ParagraphStyle(
        name="CustomTitle",
        fontSize=18,
        leading=22,
        textColor=PRIMARY,
        spaceAfter=12,
        fontName='Helvetica-Bold'
    ))
    styles.add(ParagraphStyle(
        name="SectionHeading",
        fontSize=14,
        leading=18,
        textColor=TEXT_GRAY,
        spaceBefore=10,
        spaceAfter=6,
        fontName='Helvetica-Bold'
    ))
    styles.add(ParagraphStyle(
        name="SubHeading",
        fontSize=11,
        textColor=TEXT_GRAY,
        spaceBefore=6,
        fontName='Helvetica-Bold'
    ))
    styles.add(ParagraphStyle(name="NormalGray", textColor=TEXT_GRAY, fontSize=10))
    styles.add(ParagraphStyle(name="SmallText", textColor=TEXT_GRAY, fontSize=9))
    styles.add(ParagraphStyle(
        name="NormalBold",
        fontSize=10,
        textColor=colors.white,
        fontName='Helvetica-Bold'
    ))

    elements = []

    start, end = _get_time_filter(frequency)
    prev_start, prev_end = _get_previous_period(start, end)
    
    # Determinar títulos según frecuencia
    frequency_titles = {
        'daily': 'Reporte Diario',
        'weekly': 'Reporte Semanal', 
        'monthly': 'Reporte Mensual',
    }
    title = frequency_titles.get(frequency, 'Reporte de Inventario')
    
    period_descriptions = {
        'daily': 'Día actual',
        'weekly': 'Últimos 7 días',
        'monthly': 'Últimos 30 días',
    }
    period_desc = period_descriptions.get(frequency, 'Período personalizado')

    # ══════════════════════════════════════════════════════════
    # PÁGINA 1: HEADER Y KPIs PRINCIPALES CON COMPARATIVA
    # ══════════════════════════════════════════════════════════
    
    elements.append(Paragraph(f"📊 {title} - Transervis", styles["CustomTitle"]))
    elements.append(Paragraph(
        f"<b>Período:</b> {period_desc} ({start.strftime('%d/%m/%Y')} - {end.strftime('%d/%m/%Y')})",
        styles["NormalGray"]
    ))
    elements.append(Paragraph(
        f"<b>Generado:</b> {timezone.now().strftime('%d de %B de %Y a las %H:%M hrs')}",
        styles["NormalGray"]
    ))
    elements.append(Spacer(1, 0.8*cm))

    # Calcular KPIs del período actual (todas las piezas en el rango)
    total_parts = Part.objects.filter(date_added__range=(start, end)).count()
    sold_parts = Part.objects.filter(sold=True, sold_at__range=(start, end)).count()
    active_parts = Part.objects.filter(date_added__range=(start, end), state=True, sold=False).count()
    workshops = Workshop.objects.count()
    cars = Auto.objects.filter(date_added__range=(start, end)).count()
    
    # Calcular KPIs del período anterior
    prev_total_parts = Part.objects.filter(date_added__range=(prev_start, prev_end)).count()
    prev_sold_parts = Part.objects.filter(sold=True, sold_at__range=(prev_start, prev_end)).count()
    prev_cars = Auto.objects.filter(date_added__range=(prev_start, prev_end)).count()
    
    # Función para calcular cambios porcentuales
    def calc_change(current, previous):
        if previous == 0:
            return "N/A" if current == 0 else "+100%"
        change = ((current - previous) / previous) * 100
        sign = "+" if change > 0 else ""
        return f"{sign}{change:.1f}%"
    
    parts_change = calc_change(total_parts, prev_total_parts)
    sold_change = calc_change(sold_parts, prev_sold_parts)
    cars_change = calc_change(cars, prev_cars)
    
    # Totales del sistema
    total_system_parts = Part.objects.count()
    total_system_sold = Part.objects.filter(sold=True).count()
    total_system_available = total_system_parts - total_system_sold

    elements.append(Paragraph("Indicadores Clave de Rendimiento (KPIs)", styles["SectionHeading"]))
    
    kpi_data = [
        ["Métrica", "Período Actual", "vs Período Anterior", "Total Sistema"],
        ["Total Piezas Agregadas", str(total_parts), parts_change, str(total_system_parts)],
        ["Piezas Vendidas", str(sold_parts), sold_change, str(total_system_sold)],
        ["Piezas Activas", str(active_parts), "-", "-"],
        ["Autos Ingresados", str(cars), cars_change, str(Auto.objects.count())],
        ["Talleres Operando", str(workshops), "-", str(workshops)],
        ["Piezas Disponibles", str(active_parts), "-", str(total_system_available)],
    ]
    
    kpi_table = Table(kpi_data, hAlign="LEFT", colWidths=[6*cm, 3.5*cm, 3.5*cm, 3*cm])
    kpi_table.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), PRIMARY),
        ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
        ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
        ('FONTNAME', (0, 1), (-1, -1), 'Helvetica'),
        ('FONTSIZE', (0, 0), (-1, -1), 9),
        ('ALIGN', (1, 0), (-1, -1), 'CENTER'),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('ROWBACKGROUNDS', (0, 1), (-1, -1), [BG_GRAY, colors.Color(0.95, 0.95, 0.95)]),
        ('GRID', (0, 0), (-1, -1), 0.5, colors.grey),
        ('LEFTPADDING', (0, 0), (-1, -1), 6),
        ('RIGHTPADDING', (0, 0), (-1, -1), 6),
        ('TOPPADDING', (0, 0), (-1, -1), 5),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 5),
    ]))
    elements.append(kpi_table)
    elements.append(Spacer(1, 0.8*cm))

    # ══════════════════════════════════════════════════════════
    # ANÁLISIS FINANCIERO DETALLADO
    # ══════════════════════════════════════════════════════════
    
    elements.append(Paragraph("Análisis Financiero y de Precios", styles["SectionHeading"]))
    
    # Calcular valor promedio de inventario: (min + max) / 2
    parts_in_period = Part.objects.filter(date_added__range=(start, end))
    total_inventory_value = sum(
        ((p.min_value or 0) + (p.max_value or 0)) / 2 
        for p in parts_in_period
    )
    
    # Ingresos por ventas (usando promedio de min/max)
    sold_parts_in_period = Part.objects.filter(sold=True, sold_at__range=(start, end))
    sold_revenue = sum(
        ((p.min_value or 0) + (p.max_value or 0)) / 2 
        for p in sold_parts_in_period
    )
    
    price_data = [
        ["Concepto", "Valor"],
        ["Valor Total Inventario (período)", _format_currency(total_inventory_value)],
        ["Ingresos por Ventas (período)", _format_currency(sold_revenue)],
        ["Ingreso Promedio por Venta", _format_currency(sold_revenue / sold_parts if sold_parts > 0 else 0)],
    ]
    
    price_table = Table(price_data, hAlign="LEFT", colWidths=[10*cm, 6*cm])
    price_table.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), SECONDARY),
        ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
        ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
        ('FONTSIZE', (0, 0), (-1, -1), 10),
        ('ALIGN', (1, 1), (-1, -1), 'RIGHT'),
        ('ROWBACKGROUNDS', (0, 1), (-1, -1), [BG_GRAY, colors.Color(0.95, 0.95, 0.95)]),
        ('GRID', (0, 0), (-1, -1), 0.5, colors.grey),
        ('LEFTPADDING', (0, 0), (-1, -1), 8),
        ('RIGHTPADDING', (0, 0), (-1, -1), 8),
        ('TOPPADDING', (0, 0), (-1, -1), 6),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
    ]))
    elements.append(price_table)
    elements.append(Spacer(1, 0.8*cm))

    # ══════════════════════════════════════════════════════════
    # MÉTRICAS DE RENDIMIENTO Y EFICIENCIA
    # ══════════════════════════════════════════════════════════
    
    elements.append(Paragraph("Métricas de Rendimiento Operativo", styles["SectionHeading"]))
    
    # Tasa de conversión (piezas vendidas en el período / total piezas agregadas en el período)
    conversion_rate = (sold_parts / total_parts * 100) if total_parts > 0 else 0
    
    # Días promedio hasta venta (solo piezas vendidas en el período)
    sold_parts_with_dates = Part.objects.filter(
        sold=True,
        sold_at__range=(start, end),
        sold_at__isnull=False
    )
    
    total_days = 0
    count_with_dates = 0
    for part in sold_parts_with_dates:
        if part.sold_at and part.date_added:
            # Convertir ambos a date para comparación
            sold_date = part.sold_at.date() if hasattr(part.sold_at, 'date') else part.sold_at
            added_date = part.date_added.date() if hasattr(part.date_added, 'date') else part.date_added
            days_to_sale = (sold_date - added_date).days
            if days_to_sale >= 0:
                total_days += days_to_sale
                count_with_dates += 1
    
    avg_days_to_sale = total_days / count_with_dates if count_with_dates > 0 else 0
    
    # Tasa de rotación
    inventory_turnover = (sold_parts / active_parts) if active_parts > 0 else 0
    
    metrics_data = [
        ["Métrica", "Valor", "Interpretación"],
        ["Tasa de Conversión", f"{conversion_rate:.1f}%", "Piezas vendidas del total agregado"],
        ["Días Promedio a Venta", f"{avg_days_to_sale:.1f} días", "Tiempo hasta vender una pieza"],
        ["Rotación de Inventario", f"{inventory_turnover:.2f}x", "Veces que rota el inventario"],
        ["Eficiencia de Ventas", f"{sold_parts}/{total_parts}", "Proporción vendidas/agregadas"],
        ["Disponibilidad", f"{(active_parts/total_parts*100):.1f}%" if total_parts > 0 else "0%", "Piezas activas disponibles"],
    ]
    
    metrics_table = Table(metrics_data, hAlign="LEFT", colWidths=[5*cm, 4*cm, 7*cm])
    metrics_table.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor("#6C757D")),
        ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
        ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
        ('FONTSIZE', (0, 0), (-1, -1), 9),
        ('ALIGN', (1, 1), (1, -1), 'CENTER'),
        ('ROWBACKGROUNDS', (0, 1), (-1, -1), [BG_GRAY, colors.Color(0.95, 0.95, 0.95)]),
        ('GRID', (0, 0), (-1, -1), 0.5, colors.grey),
        ('LEFTPADDING', (0, 0), (-1, -1), 6),
        ('RIGHTPADDING', (0, 0), (-1, -1), 6),
        ('TOPPADDING', (0, 0), (-1, -1), 5),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 5),
    ]))
    elements.append(metrics_table)
    elements.append(PageBreak())

    # ══════════════════════════════════════════════════════════
    # PÁGINA 2: TOP 10 PIEZAS Y ANÁLISIS DE MODELOS
    # ══════════════════════════════════════════════════════════
    
    elements.append(Paragraph("Análisis de Productos y Modelos", styles["CustomTitle"]))
    elements.append(Spacer(1, 0.5*cm))
    
    # TOP 10 PIEZAS MÁS VENDIDAS
    elements.append(Paragraph("Top 10 Piezas Más Vendidas", styles["SectionHeading"]))
    
    # Calcular ingresos como promedio de (min + max) / 2
    top_parts_raw = Part.objects.filter(sold=True, sold_at__range=(start, end)).select_related('auto')
    
    # Agrupar por nombre y calcular métricas
    parts_by_name = {}
    for part in top_parts_raw:
        name = part.name or "Sin nombre"
        if name not in parts_by_name:
            parts_by_name[name] = {
                'count': 0,
                'total_revenue': 0,
            }
        parts_by_name[name]['count'] += 1
        parts_by_name[name]['total_revenue'] += ((part.min_value or 0) + (part.max_value or 0)) / 2
    
    # Convertir a lista y ordenar
    top_parts = sorted(
        [{'name': k, **v} for k, v in parts_by_name.items()],
        key=lambda x: x['count'],
        reverse=True
    )[:10]
    
    if top_parts:
        top_data = [
            ["#", "Nombre", "Cant.", "Ingreso Total"]
        ]
        for idx, part in enumerate(top_parts, 1):
            top_data.append([
                str(idx),
                (part['name'])[:35],
                str(part['count']),
                _format_currency(part['total_revenue'])
            ])
        
        top_table = Table(top_data, hAlign="LEFT", colWidths=[1*cm, 8*cm, 2.5*cm, 4.5*cm])
        top_table.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, 0), WARNING),
            ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
            ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
            ('FONTSIZE', (0, 0), (-1, -1), 9),
            ('ALIGN', (0, 1), (0, -1), 'CENTER'),
            ('ALIGN', (2, 1), (-1, -1), 'CENTER'),
            ('ROWBACKGROUNDS', (0, 1), (-1, -1), [BG_GRAY, colors.Color(0.95, 0.95, 0.95)]),
            ('GRID', (0, 0), (-1, -1), 0.5, colors.grey),
            ('LEFTPADDING', (0, 0), (-1, -1), 5),
            ('RIGHTPADDING', (0, 0), (-1, -1), 5),
        ]))
        elements.append(top_table)
    else:
        elements.append(Paragraph("No hay datos de ventas en este período.", styles["SmallText"]))
    
    elements.append(Spacer(1, 1*cm))
    
    # TOP 10 MODELOS DE AUTOS (solo para reporte mensual)
    if frequency == 'monthly':
        elements.append(Paragraph("Top 10 Modelos de Autos Más Comunes", styles["SectionHeading"]))
        
        top_car_models = (
            Part.objects.filter(date_added__range=(start, end), auto__isnull=False)
            .values('auto__brand_model')
            .annotate(
                parts_count=Count('id'),
                sold_count=Count('id', filter=Q(sold=True))
            )
            .order_by('-parts_count')[:10]
        )
        
        if top_car_models:
            car_model_data = [
                ["#", "Modelo", "Piezas", "Vendidas", "% Vendidas"]
            ]
            for idx, model in enumerate(top_car_models, 1):
                sold_pct = (model['sold_count'] / model['parts_count'] * 100) if model['parts_count'] > 0 else 0
                car_model_data.append([
                    str(idx),
                    (model['auto__brand_model'] or "Sin modelo")[:30],
                    str(model['parts_count']),
                    str(model['sold_count']),
                    f"{sold_pct:.1f}%"
                ])
            
            car_table = Table(car_model_data, hAlign="LEFT", colWidths=[1*cm, 7.5*cm, 2*cm, 2.5*cm, 3*cm])
            car_table.setStyle(TableStyle([
                ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor("#17A2B8")),
                ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
                ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
                ('FONTSIZE', (0, 0), (-1, -1), 9),
                ('ALIGN', (0, 1), (0, -1), 'CENTER'),
                ('ALIGN', (2, 1), (-1, -1), 'CENTER'),
                ('ROWBACKGROUNDS', (0, 1), (-1, -1), [BG_GRAY, colors.Color(0.95, 0.95, 0.95)]),
                ('GRID', (0, 0), (-1, -1), 0.5, colors.grey),
                ('LEFTPADDING', (0, 0), (-1, -1), 5),
                ('RIGHTPADDING', (0, 0), (-1, -1), 5),
            ]))
            elements.append(car_table)
        else:
            elements.append(Paragraph("No hay datos de modelos en este período.", styles["SmallText"]))
        
        elements.append(Spacer(1, 1*cm))
    
    elements.append(PageBreak())
    
    # ══════════════════════════════════════════════════════════
    # PÁGINA 3: ANÁLISIS POR TALLERES Y DISTRIBUCIÓN
    # ══════════════════════════════════════════════════════════
    
    # GRÁFICO DE PASTEL: DISTRIBUCIÓN
    elements.append(Paragraph("Distribución de Piezas por Estado", styles["SectionHeading"]))
    
    pie_labels = ["Vendidas", "Activas", "Inactivas"]
    inactive_parts = Part.objects.filter(date_added__range=(start, end), state=False, sold=False).count()
    pie_values = [sold_parts, active_parts, inactive_parts]
    
    if sum(pie_values) > 0:
        elements.append(_pie_chart("Distribución", pie_labels, pie_values, [SECONDARY, PRIMARY, DANGER]))
    
    elements.append(PageBreak())

    # ══════════════════════════════════════════════════════════
    # PÁGINA 3: ANÁLISIS POR TALLER
    # ══════════════════════════════════════════════════════════
    
    elements.append(Paragraph("Análisis Detallado por Taller", styles["CustomTitle"]))
    elements.append(Spacer(1, 0.5*cm))
    
    # Resumen por taller (calcular valor como promedio de min/max)
    parts_by_ws_raw = Part.objects.filter(date_added__range=(start, end)).select_related('workshop')
    
    # Agrupar por taller
    workshops_data = {}
    for part in parts_by_ws_raw:
        ws_name = part.workshop.name if part.workshop else "(Desconocido)"
        if ws_name not in workshops_data:
            workshops_data[ws_name] = {'total': 0, 'sold': 0, 'total_value': 0}
        workshops_data[ws_name]['total'] += 1
        if part.sold:
            workshops_data[ws_name]['sold'] += 1
        workshops_data[ws_name]['total_value'] += ((part.min_value or 0) + (part.max_value or 0)) / 2
    
    # Ordenar por total descendente
    parts_by_ws = sorted(
        [{'workshop__name': k, **v} for k, v in workshops_data.items()],
        key=lambda x: x['total'],
        reverse=True
    )
    
    if parts_by_ws:
        ws_data = [
            ["Taller", "Piezas", "Vendidas", "%", "Valor Total"]
        ]
        for p in parts_by_ws:
            sold_pct = (p['sold'] / p['total'] * 100) if p['total'] > 0 else 0
            ws_data.append([
                (p["workshop__name"])[:25],
                str(p["total"]),
                str(p['sold']),
                f"{sold_pct:.1f}%",
                _format_currency(p['total_value'])
            ])
        
        ws_table = Table(ws_data, hAlign="LEFT", colWidths=[6*cm, 2.5*cm, 2.5*cm, 2*cm, 3*cm])
        ws_table.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, 0), PRIMARY),
            ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
            ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
            ('FONTSIZE', (0, 0), (-1, -1), 9),
            ('ALIGN', (1, 1), (-1, -1), 'CENTER'),
            ('ROWBACKGROUNDS', (0, 1), (-1, -1), [BG_GRAY, colors.Color(0.95, 0.95, 0.95)]),
            ('GRID', (0, 0), (-1, -1), 0.5, colors.grey),
            ('LEFTPADDING', (0, 0), (-1, -1), 6),
            ('RIGHTPADDING', (0, 0), (-1, -1), 6),
        ]))
        elements.append(ws_table)
        elements.append(Spacer(1, 1*cm))
        
        # Gráfico de barras de piezas por taller
        if len(parts_by_ws) > 0:
            labels = [p["workshop__name"] or "Desconocido" for p in parts_by_ws[:10]]
            values = [p["total"] for p in parts_by_ws[:10]]
            elements.append(_bar_chart("Piezas por Taller", labels, values, PRIMARY))
    
    # Footer informativo
    elements.append(Spacer(1, 2*cm))
    elements.append(Paragraph(
        "<i>Este reporte fue generado automáticamente por el sistema InventoryEye de Transervis.</i>",
        styles["SmallText"]
    ))
    elements.append(Paragraph(
        f"<i>Período analizado: {(end - start).days} días | Total de piezas procesadas: {total_parts}</i>",
        styles["SmallText"]
    ))

    # Construir PDF
    doc.build(elements)
    pdf = buffer.getvalue()
    buffer.close()
    return pdf
