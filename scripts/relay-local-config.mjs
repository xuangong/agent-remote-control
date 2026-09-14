export function localRelayConfiguration({ runtime, gatewayPort, relayPort, gatewayImage, secret }) {
  if (!['node', 'workers'].includes(runtime)) throw new Error('Select exactly one runtime: node or workers.');
  const port = (value) => {
    if (!/^\d+$/.test(String(value)) || !Number.isInteger(Number(value)) || Number(value) < 1024 || Number(value) > 65535) throw new Error('Ports must be integers from 1024 to 65535.');
    return Number(value);
  };
  gatewayPort = port(gatewayPort); relayPort = port(relayPort);
  if (gatewayPort === relayPort) throw new Error('Gateway and Relay ports must differ.');
  if (typeof gatewayImage !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_./:@-]*$/.test(gatewayImage)) throw new Error('An explicit Gateway image is required.');
  if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32 || !/^[A-Za-z0-9_+/=-]+$/.test(secret)) throw new Error('Use a signing secret of at least 32 bytes with base64 or base64url characters.');
  return { runtime, gatewayPort, relayPort, gatewayImage, secret, projectName: `arc-relay-${runtime}`,
    gatewayUrl: `http://127.0.0.1:${gatewayPort}`, relayUrl: `http://127.0.0.1:${relayPort}` };
}

export function composeEnvironment(config) {
  return Object.entries({
    AGENT_REMOTE_GATEWAY_PORT: config.gatewayPort,
    AGENT_REMOTE_PORT: config.relayPort,
    AGENT_REMOTE_GATEWAY_IMAGE: config.gatewayImage,
    AGENT_REMOTE_ISSUER: config.gatewayUrl,
    AGENT_REMOTE_RELAY_URL: config.relayUrl,
    AGENT_REMOTE_SIGNING_SECRET: config.secret,
  }).map(([name, value]) => `${name}=${value}\n`).join('');
}
