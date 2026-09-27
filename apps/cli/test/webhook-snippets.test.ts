// EC:A68 (round-8 A8-10 A8-11) — the webhook snippets in the generated webhook.py are run, not read:
// each FastAPI/Django handler is executed against stand-in framework objects and the kit's real
// ReceiveResult, and must answer with the status the kit decided (and hand Toss the socket address).
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toPaykitConfig } from '../src/wizard-state.js';
import { generateWebhookPy, generateWebhookTs } from '../src/generate/webhook.js';
import { buildConfig } from './helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function block(doc: string, from: string, to: string): string {
  const body = doc.slice(doc.indexOf(from) + from.length, doc.indexOf(to));
  const lines = body.split('\n').filter((line) => line.trim() !== '');
  const indent = Math.min(...lines.map((line) => line.length - line.trimStart().length));
  return lines.map((line) => line.slice(indent)).filter((line) => !line.startsWith('from .index')).join('\n');
}

function runSnippets(providers: string[]): { status: number | null; out: string } {
  const config = toPaykitConfig(buildConfig({ providers, languages: ['py'] }));
  const doc = generateWebhookPy(config);
  const fastapi = block(doc, '--- FastAPI ---', '--- Django ---');
  const django = block(doc, '--- Django ---', '--- Next.js ---');
  const single = providers.length === 1;
  const code = `
import asyncio, sys, types
from boilpayment_webhook import ReceiveResult

calls = []
async def handle_webhook(raw_body, headers, *args, **kwargs):
    calls.append({"raw": raw_body, "args": args, "kwargs": kwargs})
    return ReceiveResult(status=400, event_id=None, duplicated=None)
kit = {"handle_webhook": handle_webhook}

class Response:
    def __init__(self, status_code=200, **kw): self.status_code = status_code
class FastAPI:
    def post(self, path):
        return lambda fn: fn
class Client:
    host = "13.124.18.147"
class Request:
    headers = {"content-type": "application/json"}
    client = Client()
    META = {"REMOTE_ADDR": "13.124.18.147"}
    body = b'{"x":1}'
fastapi_mod = types.ModuleType("fastapi")
fastapi_mod.FastAPI, fastapi_mod.Request, fastapi_mod.Response = FastAPI, Request, Response
sys.modules["fastapi"] = fastapi_mod
def create_payment_kit(*a, **k): return kit
config = deps = env = None

class FastRequest(Request):
    async def body(self): return b'{"x":1}'

ns = {"create_payment_kit": create_payment_kit, "config": None, "deps": None, "env": None}
exec(${JSON.stringify(fastapi)}, ns)
res = asyncio.run(ns["paykit_webhook"](FastRequest()${single ? '' : ', "toss"'}))
assert isinstance(res, Response) and res.status_code == 400, ("fastapi", vars(res) if hasattr(res, "__dict__") else res)

def csrf_exempt(fn): return fn
def async_to_sync(fn): return lambda *a, **k: asyncio.run(fn(*a, **k))
class HttpResponse:
    def __init__(self, status=200): self.status = status
dns = {"kit": kit, "csrf_exempt": csrf_exempt, "async_to_sync": async_to_sync, "HttpResponse": HttpResponse}
exec(${JSON.stringify(django)}, dns)
res = dns["paykit_webhook"](Request()${single ? '' : ', "toss"'})
assert res.status == 400, ("django", res.status)
toss = ${providers.includes('toss') ? 'True' : 'False'}
for call in calls:
    assert (call["kwargs"].get("remote_address") == "13.124.18.147") == toss, call
print("OK", len(calls))
`;
  const result = spawnSync(path.join(ROOT, '.venv/bin/python'), ['-c', code], { encoding: 'utf8' });
  return { status: result.status, out: `${result.stdout}\n${result.stderr}` };
}

describe('[EC:A68] generated webhook.py snippets run and answer with the kit\'s status', () => {
  it.each([[['toss']], [['portone']], [['toss', 'stripe']]])('providers %j', (providers) => {
    const { status, out } = runSnippets(providers);
    expect(status, out).toBe(0);
    expect(out).toContain('OK 2');
  }, 60_000);

  it('the TS Express snippet hands Toss the socket address', () => {
    const doc = generateWebhookTs(toPaykitConfig(buildConfig({ providers: ['toss'], languages: ['ts'] })));
    expect(doc).toContain('remoteAddress: req.socket.remoteAddress');
  });
});
