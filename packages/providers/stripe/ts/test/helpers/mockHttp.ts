// Test helper — intercepts Node's `http.request` so the Stripe SDK's built-in NodeHttpClient
// never opens a real socket. The Stripe SDK's own NodeHttpClient source comments that this
// monkey-patch seam is intentional ("users ... might be using a library like nock which relies
// on the ability to monkey-patch and intercept calls to http.request"). We drive StripeProvider
// with `apiBase: { host, port, protocol: 'http' }` so requests go through plain `http.request`
// (no TLS to fake), and this helper replaces `http.request` for the lifetime of a test.
import http from 'node:http';
import { EventEmitter } from 'node:events';

export interface RecordedRequest {
  method: string;
  host: string | undefined;
  port: string | number | undefined;
  path: string;
  headers: Record<string, string | number | string[] | undefined>;
  body: string;
}

export interface MockResponse {
  statusCode: number;
  body: unknown;
}

export type Handler = (req: RecordedRequest) => MockResponse;

export interface HttpMock {
  requests: RecordedRequest[];
  /** Push the next handler; each call to http.request consumes (and shifts) the next queued handler. */
  respond(handler: Handler): void;
  /** Convenience: queue a single fixed JSON response for the next request. */
  respondJson(statusCode: number, body: unknown): void;
  restore(): void;
}

export function installHttpMock(): HttpMock {
  const original = http.request;
  const requests: RecordedRequest[] = [];
  const queue: Handler[] = [];
  let fallback: Handler | null = null;

  const mock: HttpMock = {
    requests,
    respond(handler: Handler) {
      queue.push(handler);
    },
    respondJson(statusCode: number, body: unknown) {
      queue.push(() => ({ statusCode, body }));
    },
    restore() {
      (http as unknown as { request: typeof http.request }).request = original;
    },
  };

  (http as unknown as { request: (options: any) => any }).request = (options: any) => {
    const chunks: Buffer[] = [];
    const req = new EventEmitter() as EventEmitter & {
      write: (chunk: unknown) => boolean;
      end: (chunk?: unknown) => void;
      setTimeout: (ms: number, cb?: () => void) => unknown;
      destroy: () => void;
    };
    req.write = (chunk: unknown) => {
      if (chunk != null) chunks.push(Buffer.from(chunk as string));
      return true;
    };
    req.end = (chunk?: unknown) => {
      if (chunk != null) chunks.push(Buffer.from(chunk as string));
      const body = Buffer.concat(chunks).toString('utf8');
      const recorded: RecordedRequest = {
        method: options.method,
        host: options.host,
        port: options.port,
        path: options.path,
        headers: options.headers ?? {},
        body,
      };
      requests.push(recorded);
      const handler = queue.shift() ?? fallback;
      if (!handler) {
        setImmediate(() => req.emit('error', new Error(`installHttpMock: no handler queued for ${recorded.method} ${recorded.path}`)));
        return;
      }
      const { statusCode, body: responseBody } = handler(recorded);
      const res = new EventEmitter() as EventEmitter & { statusCode: number; headers: Record<string, string>; setEncoding: (enc: string) => void };
      res.statusCode = statusCode;
      res.headers = { 'content-type': 'application/json' };
      res.setEncoding = () => {};
      setImmediate(() => {
        req.emit('response', res);
        setImmediate(() => {
          const payload = typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody);
          res.emit('data', payload);
          res.emit('end');
        });
      });
    };
    req.setTimeout = () => req;
    req.destroy = () => {};
    setImmediate(() => req.emit('socket', { connecting: false }));
    return req;
  };

  return mock;
}
