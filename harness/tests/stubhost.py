"""A minimal TUI host for the harness's own tests (not a Murmo test double:
real-host behaviour is only ever tested on real hosts).

It draws a header and a `› ` prompt line, echoes typed text, takes Ctrl+J as
a newline and bracketed paste as text, and on Enter posts the draft to the
fake server's chat route with the profile's fake key. Flags make it misbehave
in the ways the safety tests need:

  --leak-screen TEXT   draw TEXT on screen after the prompt is ready
  --leak-title TEXT    set the window title (status line) to TEXT
  --leak-log TEXT      append TEXT to $STUB_LOG (a followed host log)
  --fetch URL          request URL through the environment's proxy at start
  --child              start a long-sleeping child process (cleanup test)
  --delay SECONDS      wait before a leak (default 0.3)
"""

import argparse
import json
import os
import subprocess
import sys
import termios
import time
import tty
import urllib.request

PASTE_START, PASTE_END = '\x1b[200~', '\x1b[201~'


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--leak-screen')
    parser.add_argument('--leak-title')
    parser.add_argument('--leak-log')
    parser.add_argument('--fetch')
    parser.add_argument('--child', action='store_true')
    parser.add_argument('--delay', type=float, default=0.3)
    parser.add_argument('--version', action='store_true')
    parser.add_argument('--help-text', action='store_true')
    args = parser.parse_args()
    if args.version:
        print('stubhost 1.0.0')
        return 0
    if args.help_text:
        print('usage: stubhost [options]')
        return 0
    if args.child:
        subprocess.Popen([sys.executable, '-I', '-c', 'import time; time.sleep(600)'], start_new_session=False)
    if args.fetch:
        try:
            urllib.request.urlopen(args.fetch, timeout=3).read()
        except OSError:
            pass
    fd = sys.stdin.fileno()
    saved = termios.tcgetattr(fd)
    tty.setraw(fd)
    out = sys.stdout
    draft = ''

    def draw(status: str = '') -> None:
        out.write('\x1b[2J\x1b[H')
        out.write('stubhost 1.0.0\r\n\r\n')
        lines = draft.split('\n')
        out.write('› ' + lines[0] + '\r\n')
        for line in lines[1:]:
            out.write('  ' + line + '\r\n')
        out.write('\r\n' + status + '\r\n')
        out.write(f'\x1b[{3 + len(lines) - 1};{3 + len(lines[-1])}H')
        out.flush()

    out.write('\x1b]0;Ready\x07')
    draw()
    started = time.monotonic()
    leaked = False
    buffer = ''
    try:
        while True:
            if not leaked and time.monotonic() - started > args.delay:
                leaked = True
                with open(os.environ['STUB_LOG'] + '.leak-at', 'w') as stamp:
                    stamp.write(repr(time.time()))
                if args.leak_screen:
                    draw(args.leak_screen)
                if args.leak_title:
                    out.write(f'\x1b]0;{args.leak_title}\x07')
                    out.flush()
                if args.leak_log:
                    with open(os.environ['STUB_LOG'], 'a') as log:
                        log.write(args.leak_log + '\n')
            import select

            ready, _, _ = select.select([fd], [], [], 0.05)
            if not ready:
                continue
            data = os.read(fd, 4096)
            if not data:
                return 0
            buffer += data.decode('utf-8', 'replace')
            while buffer:
                if buffer.startswith(PASTE_START):
                    end = buffer.find(PASTE_END)
                    if end < 0:
                        break
                    draft += buffer[len(PASTE_START) : end].replace('\r', '\n')
                    buffer = buffer[end + len(PASTE_END) :]
                    continue
                ch, buffer = buffer[0], buffer[1:]
                if ch == '\r':
                    submit(draft)
                    draft = ''
                elif ch == '\n':
                    draft += '\n'
                elif ch in ('\x7f', '\x08'):
                    draft = draft[:-1]
                elif ch == '\x03':
                    return 0
                elif ch == '\x1b':
                    # Drop the rest of an escape sequence (arrow keys, End).
                    while buffer and not buffer[0].isalpha() and buffer[0] != '~':
                        buffer = buffer[1:]
                    buffer = buffer[1:]
                elif ch >= ' ':
                    draft += ch
            draw()
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, saved)


def submit(text: str) -> None:
    body = json.dumps({'model': 'murmo-fake', 'stream': False, 'messages': [{'role': 'user', 'content': text}]}).encode()
    request = urllib.request.Request(
        os.environ['ANTHROPIC_BASE_URL'] + '/v1/chat/completions',
        data=body,
        headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + os.environ['MURMO_FAKE_KEY']},
    )
    try:
        urllib.request.urlopen(request, timeout=5).read()
    except OSError:
        pass


if __name__ == '__main__':
    sys.exit(main())
