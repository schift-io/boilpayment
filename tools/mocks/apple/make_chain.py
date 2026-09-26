"""Test-only Apple signing chain for the App Store mock (EC:N1).

Writes, into <out-dir>:
  root.pem          self-signed root (stands in for Apple Root CA - G3; tests inject it as trusted)
  intermediate.pem  intermediate CA with Apple's WWDR marker OID 1.2.840.113635.100.6.2.1
  leaf.pem          signing cert with Apple's App Store receipt-signing OID 1.2.840.113635.100.6.11.1
  leaf.key          PKCS#8 P-256 key that signs the JWS (x5c = [leaf, intermediate, root])
  evil-*.pem/.key   a second, unrelated chain with the same OIDs (for "wrong chain" tests)
  api.key           P-256 key the mock accepts for App Store Server API bearer JWTs

Nothing here is an Apple credential. Keys are generated per run and never committed.
Usage: python make_chain.py <out-dir>
"""

from __future__ import annotations

import datetime as dt
import sys
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

WWDR_OID = x509.ObjectIdentifier("1.2.840.113635.100.6.2.1")
LEAF_OID = x509.ObjectIdentifier("1.2.840.113635.100.6.11.1")
NULL = b"\x05\x00"  # DER NULL, the value Apple uses for these marker extensions


def _name(cn: str) -> x509.Name:
    return x509.Name(
        [
            x509.NameAttribute(NameOID.COMMON_NAME, cn),
            x509.NameAttribute(NameOID.ORGANIZATION_NAME, "boilpayment test"),
        ]
    )


def _cert(
    subject: str,
    key,
    issuer: str,
    issuer_key,
    ca: bool,
    marker: x509.ObjectIdentifier | None,
) -> x509.Certificate:
    now = dt.datetime.now(dt.timezone.utc)
    b = (
        x509.CertificateBuilder()
        .subject_name(_name(subject))
        .issuer_name(_name(issuer))
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - dt.timedelta(days=1))
        .not_valid_after(now + dt.timedelta(days=3650))
        .add_extension(x509.BasicConstraints(ca=ca, path_length=None), critical=True)
    )
    if marker is not None:
        b = b.add_extension(x509.UnrecognizedExtension(marker, NULL), critical=False)
    return b.sign(issuer_key, hashes.SHA256())


def _chain(prefix: str, out: Path) -> None:
    root_key = ec.generate_private_key(ec.SECP256R1())
    int_key = ec.generate_private_key(ec.SECP256R1())
    leaf_key = ec.generate_private_key(ec.SECP256R1())
    root_cn, int_cn = f"{prefix}Test Root CA", f"{prefix}Test WWDR"
    root = _cert(root_cn, root_key, root_cn, root_key, True, None)
    inter = _cert(int_cn, int_key, root_cn, root_key, True, WWDR_OID)
    leaf = _cert(
        f"{prefix}Test Store Signing", leaf_key, int_cn, int_key, False, LEAF_OID
    )
    stem = "" if not prefix else "evil-"
    for name, cert in (("root", root), ("intermediate", inter), ("leaf", leaf)):
        (out / f"{stem}{name}.pem").write_bytes(
            cert.public_bytes(serialization.Encoding.PEM)
        )
    (out / f"{stem}leaf.key").write_bytes(
        leaf_key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )


def main(out_dir: str) -> None:
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    _chain("", out)
    _chain("Evil ", out)
    api_key = ec.generate_private_key(ec.SECP256R1())
    (out / "api.key").write_bytes(
        api_key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    print(out)


if __name__ == "__main__":
    main(sys.argv[1])
