import crypto from 'node:crypto';
export function requestSessionKey(item) {
  return item.sessionId ? crypto.createHash('sha256').update(item.provider + ':' + item.sessionId).digest('hex').slice(0,32) : '';
}
export function requestLive(item, now=Date.now()) {
  return Boolean(item && item.status==='pending' && (item.continuous || Date.parse(item.expiresAt)>now) && (!item.lease || item.receiverUntil>now));
}
