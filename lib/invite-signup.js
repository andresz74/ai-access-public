const crypto = require('crypto');

const INVITE_COLLECTION = 'invites';

const toSafeString = (value) => (typeof value === 'string' ? value.trim() : '');

const normalizeInviteCode = (code) => toSafeString(code).toUpperCase();

const hashInviteCode = (inviteCode, secret) => {
  const normalized = normalizeInviteCode(inviteCode);
  if (!normalized) return '';

  if (secret) {
    return crypto.createHmac('sha256', secret).update(normalized).digest('hex');
  }

  return crypto.createHash('sha256').update(normalized).digest('hex');
};

const mapFirebaseAuthErrorCode = (error) => {
  const code = toSafeString(error?.code);
  const normalizedCode = code || 'unknown';
  switch (code) {
    case 'auth/configuration-not-found':
      return {
        status: 500,
        code: 'AUTH_CONFIGURATION_NOT_FOUND',
        message:
          'Firebase Auth configuration was not found for this project. Verify FIREBASE_SERVICE_ACCOUNT_JSON points to the same Firebase project used by the frontend, and ensure Authentication (Email/Password) is enabled for that project.',
      };
    case 'auth/email-already-exists':
      return {
        status: 409,
        code: 'EMAIL_IN_USE',
        message: 'Email is already in use.',
      };
    case 'auth/invalid-email':
      return {
        status: 400,
        code: 'INVALID_EMAIL',
        message: 'Enter a valid email address.',
      };
    case 'auth/invalid-password':
    case 'auth/weak-password':
      return {
        status: 400,
        code: 'WEAK_PASSWORD',
        message: 'Password should be at least 6 characters.',
      };
    case 'auth/insufficient-permission':
      return {
        status: 500,
        code: 'AUTH_ADMIN_PERMISSION_ERROR',
        message:
          'Backend Firebase service account lacks Auth admin permission. Update FIREBASE_SERVICE_ACCOUNT_JSON with a project service account that can manage users.',
      };
    case 'auth/project-not-found':
      return {
        status: 500,
        code: 'AUTH_PROJECT_MISMATCH',
        message:
          'Backend Firebase project is misconfigured. Verify FIREBASE_SERVICE_ACCOUNT_JSON matches the frontend Firebase project.',
      };
    default:
      return {
        status: 500,
        code: 'AUTH_CREATE_FAILED',
        message: `Could not create user account (provider: ${normalizedCode}).`,
      };
  }
};

const createClientError = (status, code, message) => {
  const err = new Error(message);
  err.status = status;
  err.clientCode = code;
  err.clientMessage = message;
  return err;
};

const validateSignupPayload = (payload) => {
  const email = toSafeString(payload?.email).toLowerCase();
  const password =
    typeof payload?.password === 'string' ? payload.password : '';
  const inviteCode = toSafeString(payload?.inviteCode);

  if (!email || !password || !inviteCode) {
    throw createClientError(
      400,
      'REQUEST_INVALID',
      'email, password, and inviteCode are required.',
    );
  }

  if (password.length < 6) {
    throw createClientError(
      400,
      'WEAK_PASSWORD',
      'Password should be at least 6 characters.',
    );
  }

  return { email, password, inviteCode };
};

const redeemInviteOrThrow = async ({ db, inviteHash, uid, email }) => {
  const inviteRef = db.collection(INVITE_COLLECTION).doc(inviteHash);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(inviteRef);
    if (!snap.exists) {
      throw createClientError(
        400,
        'INVITE_INVALID',
        'Invitation code is invalid.',
      );
    }

    const data = snap.data() || {};
    if (data.active === false) {
      throw createClientError(
        400,
        'INVITE_INVALID',
        'Invitation code is invalid.',
      );
    }

    const expiresAtMs = data?.expiresAt?.toMillis?.();
    if (typeof expiresAtMs === 'number' && expiresAtMs <= Date.now()) {
      throw createClientError(
        410,
        'INVITE_EXPIRED',
        'Invitation code has expired.',
      );
    }

    const maxUses =
      Number.isFinite(data.maxUses) && Number(data.maxUses) > 0
        ? Number(data.maxUses)
        : 1;
    const uses = Number.isFinite(data.uses) ? Number(data.uses) : 0;
    if (uses >= maxUses) {
      throw createClientError(
        409,
        'INVITE_USED',
        'Invitation code has already been used.',
      );
    }

    tx.set(
      inviteRef,
      {
        uses: uses + 1,
        updatedAt: new Date(),
        lastUsedAt: new Date(),
        lastUsedByUid: uid,
        lastUsedByEmail: email,
      },
      { merge: true },
    );
  });
};

const signupWithInvite = async ({
  db,
  firebaseAdmin,
  logger,
  email,
  password,
  inviteCode,
  inviteSecret,
}) => {
  const inviteHash = hashInviteCode(inviteCode, inviteSecret);
  if (!inviteHash) {
    throw createClientError(
      400,
      'INVITE_INVALID',
      'Invitation code is invalid.',
    );
  }

  let createdUser = null;
  try {
    if (!firebaseAdmin || typeof firebaseAdmin.auth !== 'function') {
      throw createClientError(
        503,
        'AUTH_ADMIN_NOT_CONFIGURED',
        'Backend Firebase Admin SDK is not configured. Set FIREBASE_SERVICE_ACCOUNT_JSON on the API service.',
      );
    }

    createdUser = await firebaseAdmin.auth().createUser({
      email,
      password,
    });
  } catch (error) {
    logger?.error?.(
      'Firebase Auth createUser failed during invite signup:',
      JSON.stringify({
        code: toSafeString(error?.code) || 'unknown',
        message: toSafeString(error?.message) || 'unknown',
      }),
    );
    logger?.debug?.(
      'Firebase Auth createUser stack:',
      error?.stack || 'no-stack',
    );
    const mapped = mapFirebaseAuthErrorCode(error);
    throw createClientError(mapped.status, mapped.code, mapped.message);
  }

  try {
    await redeemInviteOrThrow({
      db,
      inviteHash,
      uid: createdUser.uid,
      email,
    });
  } catch (error) {
    try {
      await firebaseAdmin.auth().deleteUser(createdUser.uid);
    } catch (rollbackError) {
      logger?.error?.(
        'Failed to rollback Firebase Auth user after invite redemption failure:',
        rollbackError?.message || rollbackError,
      );
      logger?.debug?.(
        'Rollback error stack:',
        rollbackError?.stack || 'no-stack',
      );
    }
    throw error;
  }

  return {
    ok: true,
    uid: createdUser.uid,
    email,
  };
};

module.exports = {
  INVITE_COLLECTION,
  normalizeInviteCode,
  hashInviteCode,
  validateSignupPayload,
  signupWithInvite,
};
