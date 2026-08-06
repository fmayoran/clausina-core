"""Cifrado simétrico para secretos de marca en la DB (AES-256-GCM).
Formato interoperable con el panel (Node): 'gcm$<hex iv>$<hex ct||tag>'.
La clave (APP_ENC_KEY, 64 hex = 32 bytes) vive en infra (plataforma.env / env del panel)."""
import os

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

PLATAFORMA_ENV = "/root/clausina/core/plataforma.env"


def _key():
    k = os.environ.get("APP_ENC_KEY")
    if not k:
        try:
            for line in open(PLATAFORMA_ENV):
                line = line.strip()
                if line.startswith("APP_ENC_KEY="):
                    k = line.split("=", 1)[1].strip().strip('"').strip("'")
                    break
        except FileNotFoundError:
            pass
    if not k:
        raise RuntimeError("Falta APP_ENC_KEY (plataforma.env / env)")
    return bytes.fromhex(k)


def encrypt(plain: str) -> str:
    iv = os.urandom(12)
    ct = AESGCM(_key()).encrypt(iv, plain.encode("utf-8"), None)  # ct incluye el tag
    return f"gcm${iv.hex()}${ct.hex()}"


def decrypt(blob: str) -> str:
    if not blob:
        return ""
    parts = blob.split("$")
    if len(parts) != 3 or parts[0] != "gcm":
        raise RuntimeError("ciphertext inválido")
    iv = bytes.fromhex(parts[1])
    ct = bytes.fromhex(parts[2])
    return AESGCM(_key()).decrypt(iv, ct, None).decode("utf-8")


# Entrada por línea de comandos, para los scripts de shell que necesitan un secreto de la base
# (voz_job.sh, por ejemplo). El texto va por stdout y nada más, para poder capturarlo directo.
if __name__ == "__main__":
    import sys
    if len(sys.argv) < 3 or sys.argv[1] not in ("encrypt", "decrypt"):
        print("uso: ads_crypto.py encrypt|decrypt <valor>", file=sys.stderr)
        sys.exit(2)
    try:
        sys.stdout.write(encrypt(sys.argv[2]) if sys.argv[1] == "encrypt" else decrypt(sys.argv[2]))
    except Exception as e:
        print(f"error: {e}", file=sys.stderr)
        sys.exit(1)
