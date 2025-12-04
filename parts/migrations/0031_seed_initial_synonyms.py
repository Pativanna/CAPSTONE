from django.db import migrations
import unicodedata


def normalize(value: str) -> str:
    if not value:
        return ''
    normalized = unicodedata.normalize('NFKD', value.strip().lower())
    return ''.join(ch for ch in normalized if not unicodedata.combining(ch))


DEFAULT_SYNONYM_GROUPS = [
    ('Óptico', ['óptico', 'optico', 'faro', 'foco', 'luz']),
    ('Guardafango', ['guardafango', 'aleta', 'fender']),
    ('Parachoque', ['parachoque', 'paragolpe', 'bumper']),
    ('Retrovisor', ['retrovisor', 'espejo', 'espejo exterior']),
    ('Puerta', ['puerta', 'door']),
    ('Tapa', ['tapa', 'cover']),
]


def seed_synonyms(apps, schema_editor):
    Group = apps.get_model('parts', 'SynonymGroup')
    Term = apps.get_model('parts', 'SynonymTerm')

    category_field = getattr(Group, 'Category', None)
    default_category = getattr(category_field, 'PART', 'part') if category_field else 'part'

    for name, variants in DEFAULT_SYNONYM_GROUPS:
        group, _ = Group.objects.get_or_create(
            name=name,
            defaults={'category': default_category}
        )
        seen = set()
        ordered_terms = [name, *variants]
        for priority, term in enumerate(ordered_terms):
            norm = normalize(term)
            if not norm or norm in seen:
                continue
            seen.add(norm)
            Term.objects.get_or_create(
                group=group,
                term=term,
                defaults={
                    'priority': priority,
                    'normalized_term': norm,
                }
            )


def unseed_synonyms(apps, schema_editor):
    Group = apps.get_model('parts', 'SynonymGroup')
    names = [name for name, _ in DEFAULT_SYNONYM_GROUPS]
    Group.objects.filter(name__in=names).delete()


class Migration(migrations.Migration):

    dependencies = [
        ('parts', '0030_synonymgroup_synonymterm'),
    ]

    operations = [
        migrations.RunPython(seed_synonyms, unseed_synonyms),
    ]
