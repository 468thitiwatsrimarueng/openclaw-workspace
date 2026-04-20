import jwt from 'jsonwebtoken';

// The OpenClaw Gateway Secret from dashboard (hex string)
const gatewaySecretHex = "thanapat08";

// Decode hex → raw binary Buffer (24 bytes as per OpenClaw docs)
const secretBuf = Buffer.from(gatewaySecretHex, 'hex');

// Payload with operator.write (and admin for good measure)
const payload = {
  role: 'operator',
  scopes: ['operator.read', 'operator.write'],
  exp: Math.floor(Date.now() / 1000) + (365 * 24 * 60 * 60) // 1 year
};

// Sign with HS256 using binary secret buffer
const token = jwt.sign(payload, secretBuf, { algorithm: 'HS256' });

console.log("\n✅ Generated OpenClaw JWT Token:\n");
console.log(token);
console.log("\n👉 Copy the token above and use it as the 'Gateway Secret' in the WebUI settings.");
