import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { ChainAuth } from '../../src/chain/auth.js';

let auth: ChainAuth;
let kp: nacl.SignKeyPair;
let pub: string;
beforeEach(() => {
  auth = new ChainAuth(new Database(':memory:'));
  kp = nacl.sign.keyPair();
  pub = bs58.encode(kp.publicKey);
});

function sign(message: string) {
  return Buffer.from(nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey)).toString('base64');
}

describe('signature login', () => {
  it('verifies a signed nonce and issues a session', () => {
    const nonce = auth.issueNonce(pub);
    const session = auth.verify(pub, sign(`Skyharbour docking clearance: ${nonce}`));
    expect(auth.walletFor(session)).toBe(pub);
  });
  it('bad attempts do not consume the nonce; success does', () => {
    const nonce = auth.issueNonce(pub);
    expect(() => auth.verify(pub, sign('wrong'))).toThrow(/rejected/);
    const good = sign(`Skyharbour docking clearance: ${nonce}`);
    const session = auth.verify(pub, good);
    expect(auth.walletFor(session)).toBe(pub);
    expect(() => auth.verify(pub, good)).toThrow(/rejected/); // replay after success fails
  });
  it('rejects reserved names outright', () => {
    expect(() => auth.issueNonce('harbour')).toThrow(/reserved/);
  });
  it('unknown session maps to nobody', () => {
    expect(auth.walletFor('deadbeef')).toBeUndefined();
  });
});
