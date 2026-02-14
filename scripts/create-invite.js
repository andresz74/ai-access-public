#!/usr/bin/env node
const crypto = require('crypto');
const firebaseAdmin = require('firebase-admin');
const { hashInviteCode } = require('../lib/invite-signup');

const parseArgs = () => {
  const args = process.argv.slice(2);
  const parsed = {
    code: '',
    expiresDays: 7,
    maxUses: 1,
    active: true,
    overwrite: false,
  };

  for (let idx = 0; idx < args.length; idx += 1) {
    const token = args[idx];
    if (token === '--code') {
      parsed.code = String(args[idx + 1] || '').trim();
      idx += 1;
      continue;
    }
    if (token === '--expires-days') {
      const value = Number(args[idx + 1]);
      if (Number.isFinite(value) && value >= 0) parsed.expiresDays = value;
      idx += 1;
      continue;
    }
    if (token === '--max-uses') {
      const value = Number(args[idx + 1]);
      if (Number.isFinite(value) && value > 0)
        parsed.maxUses = Math.floor(value);
      idx += 1;
      continue;
    }
    if (token === '--inactive') {
      parsed.active = false;
      continue;
    }
    if (token === '--overwrite') {
      parsed.overwrite = true;
      continue;
    }
  }

  return parsed;
};

const decodeServiceAccount = () => {
  const encoded = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!encoded) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is required.');
  }
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf-8'));
};

const generateCode = () =>
  `INV-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;

const main = async () => {
  const options = parseArgs();
  const inviteCode = options.code || generateCode();
  const inviteSecret = process.env.INVITE_CODE_SECRET || '';
  const inviteHash = hashInviteCode(inviteCode, inviteSecret);

  if (!inviteHash) {
    throw new Error('Could not hash invite code. Check invite input.');
  }

  const serviceAccount = decodeServiceAccount();
  if (firebaseAdmin.apps.length === 0) {
    firebaseAdmin.initializeApp({
      credential: firebaseAdmin.credential.cert(serviceAccount),
    });
  }
  const db = firebaseAdmin.firestore();
  const inviteRef = db.collection('invites').doc(inviteHash);
  const existing = await inviteRef.get();

  if (existing.exists && !options.overwrite) {
    throw new Error(
      'Invite already exists. Use --overwrite to replace the existing invite document.',
    );
  }

  const now = new Date();
  const payload = {
    active: options.active,
    uses: 0,
    maxUses: options.maxUses,
    createdBy: 'scripts/create-invite.js',
    updatedAt: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
    createdAt: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
  };

  if (options.expiresDays > 0) {
    const expiresAtDate = new Date(
      now.getTime() + options.expiresDays * 24 * 60 * 60 * 1000,
    );
    payload.expiresAt =
      firebaseAdmin.firestore.Timestamp.fromDate(expiresAtDate);
  }

  await inviteRef.set(payload, { merge: false });

  const result = {
    inviteCode,
    inviteHash,
    active: options.active,
    maxUses: options.maxUses,
    expiresDays: options.expiresDays,
    docPath: `invites/${inviteHash}`,
  };

  console.log(JSON.stringify(result, null, 2));
};

main().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});
