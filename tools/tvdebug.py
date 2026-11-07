"""Drive the Taher IPTV app on the TV through the Chrome DevTools protocol. Standard library only.

  python -I tools/tvdebug.py start                  relaunch the app in debug mode and forward port 9222
  python -I tools/tvdebug.py eval "S.state"         run JavaScript in the app, print the result as JSON
  python -I tools/tvdebug.py keys down down enter   press remote keys (see KEYS)
  python -I tools/tvdebug.py logs 10                print console output and errors for N seconds
  python -I tools/tvdebug.py shot out.png           screenshot of the web layer (AVPlay video is NOT captured)

Several commands can be chained with '+':  keys enter + wait 5 + eval "S.state"
"""
import base64, json, os, re, socket, struct, subprocess, sys, time, urllib.request

SDB = r'C:\tizen-studio\tools\sdb.exe'
SERIAL = os.environ.get('TV_SERIAL', '192.168.1.78:26101')  # set TV_SERIAL=192.168.1.64:26101 for the living room TV
APP = 'TaherIPTV0.TaherIPTV'
PORT = 9222

KEYS = {
    'left': 37, 'up': 38, 'right': 39, 'down': 40, 'enter': 13, 'ok': 13, 'back': 10009,
    'red': 403, 'green': 404, 'yellow': 405, 'blue': 406, 'chup': 427, 'chdown': 428,
    'play': 415, 'pause': 19, 'stop': 413, 'info': 457,
    **{str(d): 48 + d for d in range(10)},
}


def sdb(*args, timeout=60):
    r = subprocess.run([SDB, '-s', SERIAL, *args], capture_output=True, text=True, timeout=timeout)
    return (r.stdout + r.stderr).strip()


def start():
    print(sdb('shell', '0', 'kill', APP.split('.')[0]))
    out = sdb('shell', '0', 'debug', APP)
    print(out)
    m = re.search(r'port:\s*(\d+)', out)
    if not m:
        sys.exit('debug launch failed')
    print(sdb('forward', f'tcp:{PORT}', f'tcp:{m.group(1)}'))
    time.sleep(2)


class CDP:
    def __init__(self, port=PORT):
        pages = json.load(urllib.request.urlopen(f'http://127.0.0.1:{port}/json', timeout=10))
        url = next(p for p in pages if p.get('type') == 'page')['webSocketDebuggerUrl']
        host, path = re.match(r'ws://([^/]+)(/.*)', url).groups()
        h, p = host.split(':')
        self.sock = socket.create_connection((h, int(p)), 10)
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock.sendall((f'GET {path} HTTP/1.1\r\nHost: {host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
                           f'Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n').encode())
        buf = b''
        while b'\r\n\r\n' not in buf:
            buf += self.sock.recv(4096)
        self.buf = buf.split(b'\r\n\r\n', 1)[1]
        self.n = 0
        self.events = []

    def _read(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise ConnectionError('closed')
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def _recv(self):
        data = b''
        while True:
            b1, b2 = self._read(2)
            ln = b2 & 0x7F
            if ln == 126:
                ln = struct.unpack('>H', self._read(2))[0]
            elif ln == 127:
                ln = struct.unpack('>Q', self._read(8))[0]
            data += self._read(ln)
            if b1 & 0x80:
                return json.loads(data)

    def _send(self, obj):
        data = json.dumps(obj).encode()
        mask = os.urandom(4)
        hdr = bytes([0x81])
        if len(data) < 126:
            hdr += bytes([0x80 | len(data)])
        elif len(data) < 65536:
            hdr += bytes([0x80 | 126]) + struct.pack('>H', len(data))
        else:
            hdr += bytes([0x80 | 127]) + struct.pack('>Q', len(data))
        self.sock.sendall(hdr + mask + bytes(c ^ mask[i % 4] for i, c in enumerate(data)))

    def call(self, method, **params):
        self.n += 1
        self._send({'id': self.n, 'method': method, 'params': params})
        while True:
            msg = self._recv()
            if msg.get('id') == self.n:
                if 'error' in msg:
                    raise RuntimeError(msg['error'])
                return msg.get('result', {})
            self.events.append(msg)

    def eval(self, expr):
        r = self.call('Runtime.evaluate', expression=expr, returnByValue=True, awaitPromise=True)
        if 'exceptionDetails' in r:
            return 'EXCEPTION: ' + json.dumps(r['exceptionDetails'].get('exception', {}).get('description', r['exceptionDetails']))
        return r.get('result', {}).get('value')

    def key(self, name):
        code = KEYS[name.lower()]
        for t in ('rawKeyDown', 'keyUp'):
            self.call('Input.dispatchKeyEvent', type=t, windowsVirtualKeyCode=code, nativeVirtualKeyCode=code)
        time.sleep(0.25)

    def logs(self, seconds):
        self.call('Runtime.enable')
        self.sock.settimeout(0.5)
        end = time.time() + seconds
        while time.time() < end:
            try:
                self.events.append(self._recv())
            except socket.timeout:
                pass
        self.sock.settimeout(10)
        for ev in self.events:
            m = ev.get('method')
            if m == 'Runtime.consoleAPICalled':
                args = [a.get('value', a.get('description', '')) for a in ev['params']['args']]
                print('[console.%s]' % ev['params']['type'], *args)
            elif m == 'Runtime.exceptionThrown':
                d = ev['params']['exceptionDetails']
                print('[exception]', d.get('exception', {}).get('description', d.get('text')))
        self.events.clear()


def main(argv, port=PORT, start_fn=start):
    if not argv:
        print(__doc__)
        return
    groups, cur = [], []
    for a in argv:
        if a == '+':
            groups.append(cur); cur = []
        else:
            cur.append(a)
    groups.append(cur)
    cdp = None
    for g in groups:
        cmd, args = g[0], g[1:]
        if cmd == 'start':
            start_fn(); cdp = None
            continue
        if cmd == 'wait':
            time.sleep(float(args[0])); continue
        cdp = cdp or CDP(port)
        if cmd == 'eval':
            print(json.dumps(cdp.eval(' '.join(args)), indent=1, ensure_ascii=False))
        elif cmd == 'keys':
            for k in args:
                cdp.key(k)
            print('pressed', ' '.join(args))
        elif cmd == 'logs':
            cdp.logs(float(args[0]) if args else 5)
        elif cmd == 'shot':
            png = base64.b64decode(cdp.call('Page.captureScreenshot', format='png')['data'])
            open(args[0], 'wb').write(png)
            print('saved', args[0], len(png), 'bytes')
        else:
            sys.exit('unknown command ' + cmd)


if __name__ == '__main__':
    main(sys.argv[1:])
