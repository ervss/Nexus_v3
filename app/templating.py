"""Shared Jinja2 templates instance (extracted from main.py during A5 split)."""
import os

from fastapi.templating import Jinja2Templates

APP_DIR = os.path.dirname(os.path.abspath(__file__))
templates = Jinja2Templates(directory=os.path.join(APP_DIR, "templates"))
