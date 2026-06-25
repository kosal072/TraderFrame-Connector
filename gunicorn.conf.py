"""Gunicorn config for the connector. Run:  gunicorn -c gunicorn.conf.py wsgi:app"""
import os

bind = f"{os.environ.get('HOST', '0.0.0.0')}:{os.environ.get('PORT', '8000')}"
workers = int(os.environ.get("WEB_CONCURRENCY", "2"))
threads = int(os.environ.get("THREADS", "4"))
timeout = int(os.environ.get("WORKER_TIMEOUT", "30"))
accesslog = "-"   # stdout
errorlog = "-"    # stderr
loglevel = os.environ.get("LOG_LEVEL", "info").lower()
