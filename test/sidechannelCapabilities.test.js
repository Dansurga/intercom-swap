import test from 'node:test';
import assert from 'node:assert/strict';
import b4a from 'b4a';
import PeerWallet from 'trac-wallet';

import {
  createSignedInvite,
  createSignedWelcome,
  encodePayloadForSigning,
  normalizeInvitePayload,
  normalizeWelcomePayload,
  signPayloadHex,
} from '../src/sidechannel/capabilities.js';

test('sidechannel capabilities: welcome + invite signatures verify', async () => {
  const wallet = new PeerWallet();
  await wallet.ready;
  await wallet.generateKeyPair();

  const pubHex = b4a.toString(wallet.publicKey, 'hex');
  const secHex = b4a.toString(wallet.secretKey, 'hex');

  const signHex = (payload) => signPayloadHex(payload, secHex);

  const welcome = createSignedWelcome(
    { channel: 'c1', ownerPubKey: pubHex, text: 'hi', issuedAt: 1, version: 1 },
    signHex
  );
  const wPayload = normalizeWelcomePayload(welcome.payload);
  const wMsg = encodePayloadForSigning(wPayload);
  const wOk = PeerWallet.verify(
    b4a.from(welcome.sig, 'hex'),
    b4a.from(wMsg),
    b4a.from(pubHex, 'hex')
  );
  assert.equal(wOk, true);

  const invite = createSignedInvite(
    {
      channel: 'c1',
      inviteePubKey: pubHex,
      inviterPubKey: pubHex,
      issuedAt: 1,
      ttlMs: 1000,
      version: 1,
    },
    signHex,
    { welcome }
  );
  const iPayload = normalizeInvitePayload(invite.payload);
  const iMsg = encodePayloadForSigning(iPayload);
  const iOk = PeerWallet.verify(
    b4a.from(invite.sig, 'hex'),
    b4a.from(iMsg),
    b4a.from(pubHex, 'hex')
  );
  assert.equal(iOk, true);
});

