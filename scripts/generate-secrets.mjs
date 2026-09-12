import crypto from 'node:crypto';

const token = () => crypto.randomBytes(32).toString('hex');
console.log(`AGENTPULSE_BRIDGE_TOKEN=${token()}`);
console.log(`AGENTPULSE_MOBILE_TOKEN=${token()}`);
