import { resolve } from 'path';
import { ConnectorFetch } from '../modules/connectors/connector-http';
import { OutboundRelayAgent } from '../modules/connectors/relay/outbound-relay-agent';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const fetchTransport: ConnectorFetch = async (url, init) => fetch(url, init) as any;

async function main(): Promise<void> {
  const authorization = process.env.CADENA_RELAY_PROVIDER_AUTHORIZATION?.trim();
  const agent = new OutboundRelayAgent({
    controlPlaneUrl: required('CADENA_RELAY_CONTROL_PLANE_URL'),
    relayId: required('CADENA_RELAY_ID'),
    token: required('CADENA_RELAY_TOKEN'),
    targetOrigin: required('CADENA_RELAY_TARGET_ORIGIN'),
    ledgerDirectory: resolve(process.env.CADENA_RELAY_LEDGER_DIR?.trim() || './data/relay-ledger'),
    providerHeaders: authorization ? { Authorization: authorization } : {},
  }, fetchTransport, fetchTransport);

  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());
  await agent.run(controller.signal);
}

void main().catch((error) => {
  console.error((error as Error)?.message || error);
  process.exitCode = 1;
});
