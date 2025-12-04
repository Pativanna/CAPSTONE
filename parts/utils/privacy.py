import ipaddress


def anonymize_ip(ip_value: str | None) -> str:
    """Redacts the host portion of an IP address to comply with privacy requirements."""
    if not ip_value:
        return ''
    ip_value = ip_value.strip()
    try:
        ip_obj = ipaddress.ip_address(ip_value)
    except ValueError:
        return ''

    if ip_obj.version == 4:
        network = ipaddress.ip_network(f"{ip_obj}/24", strict=False)
        return str(network.network_address)

    # IPv6: zero out last 80 bits (keep /48)
    network = ipaddress.ip_network(f"{ip_obj}/48", strict=False)
    return str(network.network_address)
