"""Browser check at true TV size: headless Chrome at 1920x1080 driven over DevTools.

Needs the app server running (`app` in .claude/launch.json, http://localhost:8765).

  python -I tools/webcheck.py start                 launch headless Chrome on the app (fresh profile)
  python -I tools/webcheck.py keys left down        press keys (same names as tvdebug: ok, back, red, ...)
  python -I tools/webcheck.py type jazeera          type text into the focused input
  python -I tools/webcheck.py eval "__tiptv.S.zone"
  python -I tools/webcheck.py shot out.png          full 1920x1080 screenshot
  python -I tools/webcheck.py logs 3                console output and errors
  python -I tools/webcheck.py stop                  close the browser

Chain commands with '+', as in tvdebug.py.
"""
import json, os, subprocess, sys, tempfile, time, urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tvdebug  # noqa: E402

PORT = 9333
URL = 'http://localhost:8765/'
CHROME = [r'C:\Program Files\Google\Chrome\Application\chrome.exe',
          r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe']


def alive():
    try:
        urllib.request.urlopen(f'http://127.0.0.1:{PORT}/json/version', timeout=2)
        return True
    except OSError:
        return False


def start():
    if alive():
        stop()
    exe = next(p for p in CHROME if os.path.exists(p))
    profile = tempfile.mkdtemp(prefix='tiptv-chrome-')
    # Headless windows lose 36x105 px to (invisible) window chrome; this leaves a 1920x1080 viewport.
    subprocess.Popen([exe, '--headless=new', f'--remote-debugging-port={PORT}', '--window-size=1956,1185',
                      '--force-device-scale-factor=1', '--hide-scrollbars', '--mute-audio',
                      '--autoplay-policy=no-user-gesture-required', f'--user-data-dir={profile}', URL],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                     creationflags=getattr(subprocess, 'DETACHED_PROCESS', 0))
    for _ in range(40):
        if alive():
            time.sleep(1.5)
            print('chrome ready on', PORT)
            return
        time.sleep(0.25)
    sys.exit('chrome did not start')


def stop():
    try:
        cdp = tvdebug.CDP(PORT)
        cdp.call('Browser.close')
    except Exception:
        pass
    print('chrome stopped')


def main(argv):
    if not argv:
        print(__doc__)
        return
    if argv == ['stop']:
        stop()
        return
    # 'type' is handled here; everything else goes to tvdebug against this browser.
    groups, cur = [], []
    for a in argv:
        if a == '+':
            groups.append(cur); cur = []
        else:
            cur.append(a)
    groups.append(cur)
    for g in groups:
        if g[0] == 'type':
            cdp = tvdebug.CDP(PORT)
            cdp.call('Input.insertText', text=' '.join(g[1:]))
            print('typed', ' '.join(g[1:]))
        elif g[0] == 'stop':
            stop()
        else:
            tvdebug.main(g, port=PORT, start_fn=start)


if __name__ == '__main__':
    main(sys.argv[1:])
