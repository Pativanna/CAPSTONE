"""Context processors for global template values."""
from __future__ import annotations


def security(request):
    """
    Provide CSP nonce and security flags to every template.

    Falls back to empty string if the SecurityHeadersMiddleware did not
    set the nonce (for example, in tests).
    """
    return {
        'csp_nonce': getattr(request, 'csp_nonce', ''),
    }

