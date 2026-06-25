"""WSGI entrypoint for production servers (gunicorn/uwsgi)."""
from connector import app  # noqa: F401

if __name__ == "__main__":
    app.run()
