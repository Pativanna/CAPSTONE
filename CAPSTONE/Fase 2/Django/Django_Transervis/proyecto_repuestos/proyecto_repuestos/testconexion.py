import oracledb

# Especifica explícitamente la ruta del cliente
oracledb.init_oracle_client(
    lib_dir=r"C:\oracle\instantclient_21_19",  # Ruta a las DLLs
    config_dir=r"C:\oracle\instantclient_21_19\wallet"  # Ruta al wallet
)

try:
    conn = oracledb.connect(
        user="TRANSERVIS_DJANGO",
        password="Djangocontraseña1234!",
        dsn="transervisbd_high",
        wallet_password="wallet1234"
    )
    print("Conexión exitosa!")
    conn.close()
except Exception as e:
    print(f"Error: {e}")