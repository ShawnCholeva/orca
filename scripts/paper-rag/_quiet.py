"""Silence ChromaDB telemetry noise and the LibreSSL/urllib3 import warning.

Import this before `chromadb` so the warning filter is installed before urllib3
loads. ChromaDB 0.5.x keeps firing telemetry despite anonymized_telemetry=False
(a posthog version mismatch prints "Failed to send telemetry event ..."), so we
quiet its logger directly.
"""
import logging
import warnings

warnings.filterwarnings("ignore", message=r"urllib3 v2 only supports OpenSSL")
logging.getLogger("chromadb.telemetry.product.posthog").setLevel(logging.CRITICAL)
