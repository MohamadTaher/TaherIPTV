"""Render tools/icon.svg to app/icon.png (512x512, transparent) with headless Chrome.

  python -I tools/make_icon.py
"""
import os, subprocess, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SVG = os.path.join(ROOT, 'tools', 'icon.svg')
OUT = os.path.join(ROOT, 'app', 'icon.png')
CHROME = [r'C:\Program Files\Google\Chrome\Application\chrome.exe',
          r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe']

exe = next(p for p in CHROME if os.path.exists(p))
with tempfile.TemporaryDirectory() as tmp:
    page = os.path.join(tmp, 'icon.html')
    with open(SVG, encoding='utf-8') as f:
        svg = f.read()
    with open(page, 'w', encoding='utf-8') as f:
        f.write('<!doctype html><html><body style="margin:0;background:transparent">' + svg + '</body></html>')
    subprocess.run([exe, '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
                    '--default-background-color=00000000', '--window-size=512,512',
                    '--user-data-dir=' + os.path.join(tmp, 'profile'),
                    '--screenshot=' + OUT, 'file:///' + page.replace('\\', '/')],
                   check=True, capture_output=True)
print('saved', OUT)
