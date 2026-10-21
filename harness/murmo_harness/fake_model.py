"""The fake model server (safety rule 1).

Listens on 127.0.0.1 on an ephemeral port and speaks just enough of each
host's wire format:

- `POST /v1/messages`: Anthropic (Claude), streaming, plus the non-streaming
  title calls.
- `POST /v1/responses`: OpenAI Responses (Codex).
- `POST /v1/chat/completions`: chat completions (Pi, OpenCode).
- `GET /v1/models`.

A marker in the user text picks the mode: `ok` (default), `busy` (40 chunks
over 20 s), `approval` (one tool call for the driver to deny) and
`slow-first-byte`. Any key but `FAKE_KEY` gets 403. Request bodies are
recorded as JSON lines; request headers are never stored or logged. Any other
path gets 404 and is flagged.
"""

from __future__ import annotations

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from .safety import FAKE_KEY

MODE_MARKERS = {
    'busy': 'murmo-fake-busy',
    'approval': 'murmo-fake-approval',
    'slow-first-byte': 'murmo-fake-slow-first-byte',
}
BUSY_CHUNKS = 40
BUSY_SECONDS = 20.0
SLOW_FIRST_BYTE_SECONDS = 3.0
REPLY = 'Synthetic local reply.'
MODEL_ID = 'murmo-fake'
SELF_TEST_PATH = '/__harness/self-test'

ROUTES = {
    ('POST', '/v1/messages'): 'anthropic',
    ('POST', '/v1/responses'): 'responses',
    ('POST', '/v1/chat/completions'): 'chat',
    ('GET', '/v1/models'): 'models',
}

# Wrappers hosts add around the prompt as separate text blocks (Claude's
# reminders, Codex's environment context); they are not the user's text.
_WRAPPER_PREFIXES = ('<system-reminder>', '<environment_context>', '<user_instructions>', '# AGENTS.md')


def _texts(content: Any) -> list[str]:
    if isinstance(content, str):
        return [content]
    if isinstance(content, list):
        out = []
        for part in content:
            if isinstance(part, dict) and part.get('type') in ('text', 'input_text') and isinstance(part.get('text'), str):
                out.append(part['text'])
        return out
    return []


def user_text(route: str, body: dict) -> str | None:
    """The last user message's own text, without host wrapper blocks."""
    if route == 'responses':
        items = body.get('input')
        if isinstance(items, str):
            return items
        messages = [i for i in items or [] if isinstance(i, dict) and i.get('role') == 'user']
    elif route in ('anthropic', 'chat'):
        messages = [m for m in body.get('messages') or [] if isinstance(m, dict) and m.get('role') == 'user']
    else:
        return None
    for message in reversed(messages):
        own = [t for t in _texts(message.get('content')) if not t.lstrip().startswith(_WRAPPER_PREFIXES)]
        if own:
            return '\n'.join(own)
    return None


def mode_of(text: str | None) -> str:
    for mode, marker in MODE_MARKERS.items():
        if text and marker in text:
            return mode
    return 'ok'


def _offered_tool(route: str, body: dict, preferred: tuple[str, ...]) -> str | None:
    names = []
    for tool in body.get('tools') or []:
        if not isinstance(tool, dict):
            continue
        name = tool.get('name') or (tool.get('function') or {}).get('name')
        if isinstance(name, str):
            names.append(name)
    for name in preferred:
        if name in names:
            return name
    return names[0] if names else None


class FakeModelServer:
    """Start with `start()`, stop with `close()`. Thread-safe test API."""

    def __init__(self, log_path: Path | None = None, *, on_record=None) -> None:
        self.log_path = log_path
        self._records: list[dict] = []
        self._lock = threading.Lock()
        self._seq = 0
        self._approved: set[str] = set()
        self._on_record = on_record
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None
        self.self_test_token = f'murmo-harness-self-test-{id(self):x}'

    # --- lifecycle -------------------------------------------------------

    def start(self) -> FakeModelServer:
        owner = self

        class Handler(BaseHTTPRequestHandler):
            server_version = 'murmo-fake/1'

            def log_message(self, *args):  # never log: the default line has headers' worth of detail
                pass

            def do_GET(self):
                owner._handle(self, 'GET')

            def do_POST(self):
                owner._handle(self, 'POST')

            def do_PUT(self):
                owner._handle(self, 'PUT')

            def do_DELETE(self):
                owner._handle(self, 'DELETE')

        self._server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self._server.daemon_threads = True
        self._thread = threading.Thread(target=self._server.serve_forever, name='fake-model', daemon=True)
        self._thread.start()
        return self

    @property
    def port(self) -> int:
        assert self._server is not None, 'server not started'
        return self._server.server_address[1]

    @property
    def base_url(self) -> str:
        return f'http://127.0.0.1:{self.port}'

    def close(self) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
            self._server = None
        if self._thread is not None:
            self._thread.join(timeout=3)
            self._thread = None

    # --- test API --------------------------------------------------------

    def requests(self, route: str | None = None) -> list[dict]:
        with self._lock:
            return [dict(r) for r in self._records if route is None or r.get('route') == route]

    def model_requests(self) -> list[dict]:
        return [r for r in self.requests() if r.get('route') in ('anthropic', 'responses', 'chat') and r['status'] == 200]

    def last_user_text(self) -> str | None:
        for record in reversed(self.model_requests()):
            if record.get('userText') is not None:
                return record['userText']
        return None

    def flagged(self) -> list[dict]:
        return [r for r in self.requests() if r.get('flag')]

    def mark(self) -> int:
        """The current sequence number; `since(mark)` gives later requests."""
        with self._lock:
            return self._seq

    def since(self, mark: int) -> list[dict]:
        return [r for r in self.requests() if r['seq'] > mark]

    # --- handling --------------------------------------------------------

    def _record(self, record: dict) -> None:
        with self._lock:
            self._seq += 1
            record = {'seq': self._seq, 'at': time.time(), **record}
            self._records.append(record)
            if self.log_path is not None:
                with self.log_path.open('a', encoding='utf-8') as log:
                    log.write(json.dumps(record, ensure_ascii=False) + '\n')
        if self._on_record is not None:
            self._on_record(record)

    @staticmethod
    def _key_ok(handler: BaseHTTPRequestHandler) -> bool:
        # Read transiently and compared; never stored, never logged.
        api_key = handler.headers.get('x-api-key')
        auth = handler.headers.get('authorization') or ''
        bearer = auth[7:] if auth.lower().startswith('bearer ') else None
        return FAKE_KEY in (api_key, bearer)

    def _handle(self, handler: BaseHTTPRequestHandler, method: str) -> None:
        path = handler.path.split('?', 1)[0]
        if method == 'GET' and path == SELF_TEST_PATH:
            self._send_json(handler, 200, None, raw=self.self_test_token.encode())
            return
        length = int(handler.headers.get('content-length') or 0)
        raw = handler.rfile.read(length) if length else b''
        route = ROUTES.get((method, path))
        if route is None:
            self._record({'method': method, 'path': path, 'status': 404, 'flag': 'unknown-route'})
            self._send_json(handler, 404, {'error': {'type': 'not_found', 'message': 'murmo fake: no such route'}})
            return
        if not self._key_ok(handler):
            self._record({'method': method, 'path': path, 'route': route, 'status': 403, 'flag': 'bad-key'})
            self._send_json(handler, 403, {'error': {'type': 'permission_error', 'message': 'murmo fake: wrong key'}})
            return
        if route == 'models':
            self._record({'method': method, 'path': path, 'route': route, 'status': 200})
            self._send_json(handler, 200, {'object': 'list', 'data': [{'id': MODEL_ID, 'object': 'model'}]})
            return
        try:
            body = json.loads(raw or b'{}')
        except json.JSONDecodeError:
            self._record({'method': method, 'path': path, 'route': route, 'status': 400, 'flag': 'bad-json'})
            self._send_json(handler, 400, {'error': {'message': 'murmo fake: body is not JSON'}})
            return
        text = user_text(route, body)
        mode = mode_of(text)
        tool = None
        if mode == 'approval' and text not in self._approved:
            preferred = {'anthropic': ('Bash',), 'responses': ('exec_command', 'shell'), 'chat': ('bash', 'shell')}
            tool = _offered_tool(route, body, preferred[route])
            if tool:
                # One tool call per prompt: after the driver denies it, the
                # host's follow-up request gets a plain reply.
                self._approved.add(text)
        self._record(
            {
                'method': method,
                'path': path,
                'route': route,
                'status': 200,
                'mode': mode,
                'stream': bool(body.get('stream')),
                'userText': text,
                'tool': tool,
                'body': body,
            }
        )
        if mode == 'slow-first-byte':
            time.sleep(SLOW_FIRST_BYTE_SECONDS)
        try:
            if route == 'anthropic':
                self._anthropic(handler, body, mode, tool)
            elif route == 'responses':
                self._responses(handler, body, mode, tool)
            else:
                self._chat(handler, body, mode, tool)
        except (BrokenPipeError, ConnectionResetError):
            pass

    @staticmethod
    def _send_json(handler, status: int, payload, *, raw: bytes | None = None) -> None:
        data = raw if raw is not None else json.dumps(payload).encode()
        handler.send_response(status)
        handler.send_header('Content-Type', 'application/json')
        handler.send_header('Content-Length', str(len(data)))
        handler.end_headers()
        handler.wfile.write(data)

    @staticmethod
    def _start_stream(handler) -> None:
        handler.send_response(200)
        handler.send_header('Content-Type', 'text/event-stream')
        handler.send_header('Cache-Control', 'no-cache')
        handler.end_headers()

    @staticmethod
    def _event(handler, data, name: str | None = None) -> None:
        head = f'event: {name}\n' if name else ''
        handler.wfile.write(f'{head}data: {json.dumps(data)}\n\n'.encode())
        handler.wfile.flush()

    @staticmethod
    def _chunks(mode: str) -> tuple[list[str], float]:
        if mode == 'busy':
            return [f'busy {i} ' for i in range(BUSY_CHUNKS)], BUSY_SECONDS / BUSY_CHUNKS
        return [REPLY], 0.0

    def _anthropic(self, handler, body: dict, mode: str, tool: str | None) -> None:
        model = body.get('model')
        usage = {'input_tokens': 1, 'output_tokens': 1}
        if not body.get('stream'):
            message = {
                'id': 'msg_murmo_fake',
                'type': 'message',
                'role': 'assistant',
                'model': model,
                'content': [{'type': 'text', 'text': REPLY}],
                'stop_reason': 'end_turn',
                'stop_sequence': None,
                'usage': usage,
            }
            self._send_json(handler, 200, message)
            return
        self._start_stream(handler)
        start = {
            'type': 'message_start',
            'message': {
                'id': 'msg_murmo_fake',
                'type': 'message',
                'role': 'assistant',
                'model': model,
                'content': [],
                'stop_reason': None,
                'stop_sequence': None,
                'usage': {'input_tokens': 1, 'output_tokens': 0},
            },
        }
        self._event(handler, start, 'message_start')
        if tool:
            block = {'type': 'tool_use', 'id': 'toolu_murmo_fake', 'name': tool, 'input': {}}
            self._event(handler, {'type': 'content_block_start', 'index': 0, 'content_block': block}, 'content_block_start')
            arguments = json.dumps({'command': 'true', 'description': 'murmo harness approval probe: deny this'})
            delta = {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'input_json_delta', 'partial_json': arguments}}
            self._event(handler, delta, 'content_block_delta')
            stop_reason = 'tool_use'
        else:
            block = {'type': 'text', 'text': ''}
            self._event(handler, {'type': 'content_block_start', 'index': 0, 'content_block': block}, 'content_block_start')
            chunks, gap = self._chunks(mode)
            for chunk in chunks:
                delta = {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'text_delta', 'text': chunk}}
                self._event(handler, delta, 'content_block_delta')
                if gap:
                    time.sleep(gap)
            stop_reason = 'end_turn'
        self._event(handler, {'type': 'content_block_stop', 'index': 0}, 'content_block_stop')
        end = {'type': 'message_delta', 'delta': {'stop_reason': stop_reason, 'stop_sequence': None}, 'usage': usage}
        self._event(handler, end, 'message_delta')
        self._event(handler, {'type': 'message_stop'}, 'message_stop')

    def _responses(self, handler, body: dict, mode: str, tool: str | None) -> None:
        model = body.get('model')
        usage = {'input_tokens': 1, 'output_tokens': 1, 'total_tokens': 2}
        base = {'id': 'resp_murmo_fake', 'object': 'response', 'created_at': int(time.time()), 'model': model}
        self._start_stream(handler)

        def emit(kind: str, **rest) -> None:
            self._event(handler, {'type': kind, **rest}, kind)

        emit('response.created', response={**base, 'status': 'in_progress', 'output': []})
        if tool:
            arguments = {
                'cmd': 'true',
                'sandbox_permissions': 'require_escalated',
                'justification': 'murmo harness approval probe: deny this',
            }
            item = {
                'type': 'function_call',
                'id': 'fc_murmo_fake',
                'call_id': 'call_murmo_fake',
                'name': tool,
                'arguments': json.dumps(arguments),
                'status': 'completed',
            }
            emit('response.output_item.added', output_index=0, item={**item, 'status': 'in_progress'})
            emit('response.output_item.done', output_index=0, item=item)
            emit('response.completed', response={**base, 'status': 'completed', 'output': [item], 'usage': usage})
            return
        msg = {'id': 'msg_murmo_fake', 'type': 'message', 'role': 'assistant', 'status': 'in_progress', 'content': []}
        emit('response.output_item.added', output_index=0, item=msg)
        part = {'type': 'output_text', 'text': '', 'annotations': []}
        emit('response.content_part.added', item_id=msg['id'], output_index=0, content_index=0, part=part)
        chunks, gap = self._chunks(mode)
        for chunk in chunks:
            emit('response.output_text.delta', item_id=msg['id'], output_index=0, content_index=0, delta=chunk)
            if gap:
                time.sleep(gap)
        text = ''.join(chunks)
        emit('response.output_text.done', item_id=msg['id'], output_index=0, content_index=0, text=text)
        done = {**msg, 'status': 'completed', 'content': [{'type': 'output_text', 'text': text, 'annotations': []}]}
        emit('response.output_item.done', output_index=0, item=done)
        emit('response.completed', response={**base, 'status': 'completed', 'output': [done], 'usage': usage})

    def _chat(self, handler, body: dict, mode: str, tool: str | None) -> None:
        model = body.get('model')
        created = int(time.time())
        if not body.get('stream'):
            message = {'role': 'assistant', 'content': REPLY}
            payload = {
                'id': 'chatcmpl-murmo-fake',
                'object': 'chat.completion',
                'created': created,
                'model': model,
                'choices': [{'index': 0, 'message': message, 'finish_reason': 'stop'}],
                'usage': {'prompt_tokens': 1, 'completion_tokens': 1, 'total_tokens': 2},
            }
            self._send_json(handler, 200, payload)
            return
        self._start_stream(handler)

        def chunk(delta: dict, finish: str | None = None) -> None:
            data = {
                'id': 'chatcmpl-murmo-fake',
                'object': 'chat.completion.chunk',
                'created': created,
                'model': model,
                'choices': [{'index': 0, 'delta': delta, 'finish_reason': finish}],
            }
            self._event(handler, data)

        if tool:
            arguments = json.dumps({'command': 'true', 'description': 'murmo harness approval probe: deny this'})
            call = {'index': 0, 'id': 'call_murmo_fake', 'type': 'function', 'function': {'name': tool, 'arguments': arguments}}
            chunk({'role': 'assistant', 'tool_calls': [call]})
            chunk({}, 'tool_calls')
        else:
            chunks, gap = self._chunks(mode)
            for i, text in enumerate(chunks):
                chunk({'role': 'assistant', 'content': text} if i == 0 else {'content': text})
                if gap:
                    time.sleep(gap)
            chunk({}, 'stop')
        handler.wfile.write(b'data: [DONE]\n\n')
        handler.wfile.flush()
