// HTTP adapters — framework-agnostic. See spec/webhook.pseudo.md
import type { Clock, PaymentProvider, Repo } from 'boilpayment-core';
import { receive } from './receive.js';

export interface NodeRequest {
  headers: Record<string, string>;
  body: string;
  /** EC:E18 — the connection's peer address (e.g. req.socket.remoteAddress), never a header. */
  remoteAddress?: string;
}
export interface NodeResponse {
  status: number;
  body: string;
}

export type NodeHandler = (req: NodeRequest) => Promise<NodeResponse>;

export function createNodeHandler(deps: { provider: PaymentProvider; repo: Repo; clock: Clock }): NodeHandler {
  return async (req: NodeRequest): Promise<NodeResponse> => {
    const result = await receive({ provider: deps.provider, headers: req.headers, rawBody: req.body, remoteAddress: req.remoteAddress, repo: deps.repo, clock: deps.clock });
    return { status: result.status, body: JSON.stringify(result) };
  };
}

/** `remoteAddress` reads the peer address for a request from your runtime (a fetch Request has none). */
export function toFetchHandler(handler: NodeHandler, remoteAddress?: (request: Request) => string | undefined): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => { headers[key] = value; });
    const body = await request.text();
    const result = await handler({ headers, body, remoteAddress: remoteAddress?.(request) });
    return new Response(result.body, { status: result.status, headers: { 'content-type': 'application/json' } });
  };
}
