// HTTP adapters — framework-agnostic. See spec/webhook.pseudo.md
import type { Clock, PaymentProvider, Repo } from '@schift/payment-kit-core';
import { receive } from './receive.js';

export interface NodeRequest {
  headers: Record<string, string>;
  body: string;
}
export interface NodeResponse {
  status: number;
  body: string;
}

export type NodeHandler = (req: NodeRequest) => Promise<NodeResponse>;

export function createNodeHandler(deps: { provider: PaymentProvider; repo: Repo; clock: Clock }): NodeHandler {
  return async (req: NodeRequest): Promise<NodeResponse> => {
    const result = await receive({ provider: deps.provider, headers: req.headers, rawBody: req.body, repo: deps.repo, clock: deps.clock });
    return { status: result.status, body: JSON.stringify(result) };
  };
}

export function toFetchHandler(handler: NodeHandler): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => { headers[key] = value; });
    const body = await request.text();
    const result = await handler({ headers, body });
    return new Response(result.body, { status: result.status, headers: { 'content-type': 'application/json' } });
  };
}
