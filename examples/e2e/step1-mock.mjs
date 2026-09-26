import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHmac } from 'node:crypto';

export const webhookSecret = `whsec_${Buffer.from('step1-local-test-secret').toString('base64')}`;

/** Local wire fixture, not a claim of live PortOne compatibility. */
export async function startMock() {
  const payments = new Map();
  const refunds = [];
  const charges = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/');
    const paymentId = decodeURIComponent(parts[2] ?? '');
    let reply;
    if (req.method === 'POST' && url.pathname === '/__test/seed') {
      payments.set(body.id, body);
      reply = { seeded: body.id };
    } else if (req.method === 'POST' && url.pathname === '/__test/settle') {
      const cancellation = refunds.find((row) => row.id === body.id);
      if (!cancellation) throw new Error(`Unknown cancellation ${body.id}`);
      cancellation.status = body.status;
      const payment = payments.get(cancellation.paymentId);
      payment.status = body.status === 'SUCCEEDED' ? 'PARTIAL_CANCELLED' : 'PAID';
      reply = { settled: body.id };
    } else if (req.method === 'GET' && url.pathname === '/__test/state') {
      reply = { refunds, charges };
    } else if (req.method === 'POST' && url.pathname === '/__test/sign') {
      const rawBody = JSON.stringify({ type: body.type, timestamp: new Date().toISOString(), data: body.data });
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = createHmac('sha256', Buffer.from(webhookSecret.slice(6), 'base64'))
        .update(`${body.id}.${timestamp}.${rawBody}`).digest('base64');
      reply = { rawBody, headers: { 'webhook-id': body.id, 'webhook-timestamp': timestamp, 'webhook-signature': `v1,${signature}` } };
    } else if (req.headers.authorization !== 'PortOne test_step1') {
      res.writeHead(401).end('{}');
      return;
    } else if (req.method === 'GET' && url.pathname === '/payments') {
      reply = { items: [...payments.values()] };
    } else if (req.method === 'GET' && payments.has(paymentId)) {
      reply = payments.get(paymentId);
    } else if (req.method === 'POST' && parts[3] === 'cancel' && payments.has(paymentId)) {
      const payment = payments.get(paymentId);
      const cancellation = { id: `cancel_${paymentId}_${refunds.length}`, paymentId, status: payment.testRefundStatus ?? 'SUCCEEDED', totalAmount: body.amount, requestedAt: new Date().toISOString(), cancelledAt: new Date().toISOString() };
      refunds.push(cancellation);
      payment.cancellations.push(cancellation);
      if (cancellation.status === 'SUCCEEDED') payment.status = 'PARTIAL_CANCELLED';
      reply = { cancellation };
    } else if (req.method === 'POST' && parts[3] === 'billing-key') {
      if (!charges.some((charge) => charge.paymentId === paymentId)) charges.push({ paymentId, amount: body.amount.total });
      reply = { payment: { pgTxId: `txn_${paymentId}`, paidAt: new Date().toISOString() } };
    } else {
      res.writeHead(404).end('{}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('local mock missing TCP address');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}
