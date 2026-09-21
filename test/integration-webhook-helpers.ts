import request from 'supertest';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitForDelivery(
  server: any,
  route: 'git' | 'monitoring',
  orgId: string,
  provider: string,
  deliveryId: string,
  timeoutMs = 10_000,
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let last: any = null;
  while (Date.now() < deadline) {
    const response = await request(server)
      .get(`/integrations/${route}/deliveries/${encodeURIComponent(deliveryId)}`)
      .query({ provider })
      .set('x-org-id', orgId);
    if (response.status !== 200) {
      throw new Error(`Delivery status returned HTTP ${response.status}: ${JSON.stringify(response.body)}`);
    }
    last = response.body;
    if (last.status === 'completed' || last.status === 'failed') return last;
    await wait(10);
  }
  throw new Error(`Delivery '${deliveryId}' did not settle before timeout; last status: ${last?.status}`);
}

export async function postGitAndWait(
  server: any,
  orgId: string,
  deliveryId: string,
  body: Record<string, any>,
): Promise<{ acceptance: any; delivery: any; result: any; body: any }> {
  const provider = String(body.provider || 'github').toLowerCase();
  const accepted = await request(server)
    .post('/integrations/git/webhooks')
    .set('x-org-id', orgId)
    .set('x-delivery-id', deliveryId)
    .send(body)
    .expect(202);
  const delivery = await waitForDelivery(server, 'git', orgId, provider, deliveryId);
  if (delivery.status !== 'completed') {
    throw new Error(`Git delivery '${deliveryId}' failed: ${delivery.error}`);
  }
  const bodyResult = accepted.body.duplicate
    ? { ...delivery.result, duplicate: true }
    : delivery.result;
  return { acceptance: accepted.body, delivery, result: delivery.result, body: bodyResult };
}

export async function postMonitoringAndWait(
  server: any,
  orgId: string,
  deliveryId: string,
  body: Record<string, any>,
): Promise<{ acceptance: any; delivery: any; result: any; body: any }> {
  const provider = String(body.provider || 'monitoring').toLowerCase();
  const accepted = await request(server)
    .post('/integrations/monitoring/webhooks')
    .set('x-org-id', orgId)
    .set('x-delivery-id', deliveryId)
    .send(body)
    .expect(202);
  const delivery = await waitForDelivery(server, 'monitoring', orgId, provider, deliveryId);
  if (delivery.status !== 'completed') {
    throw new Error(`Monitoring delivery '${deliveryId}' failed: ${delivery.error}`);
  }
  const bodyResult = accepted.body.duplicate
    ? { ...delivery.result, duplicate: true }
    : delivery.result;
  return { acceptance: accepted.body, delivery, result: delivery.result, body: bodyResult };
}
