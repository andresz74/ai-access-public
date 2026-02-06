const test = require('node:test');
const assert = require('node:assert/strict');

const originalEnv = { ...process.env };
let firestoreGetMock = async () => ({ exists: false, data: () => ({}) });

const mockAxios = {
  post: async () => {
    throw new Error('mockAxios.post not configured for this test');
  },
};

const mockFirebaseAdmin = {
  credential: {
    cert: () => ({}),
  },
  initializeApp: () => {},
  firestore: () => ({
    collection: () => ({
      doc: () => ({
        get: async () => firestoreGetMock(),
      }),
    }),
  }),
};

const axiosPath = require.resolve('axios');
const firebasePath = require.resolve('firebase-admin');

const loadAppWithMocks = (overrides = {}) => {
  const envOverrides = overrides.env || {};
  const {
    FIREBASE_SERVICE_ACCOUNT_JSON = Buffer.from('{}').toString('base64'),
    OPENAI_API_KEY = 'test-openai-key',
    DEEPSEEK_API_KEY = 'test-deepseek-key',
    ANTHROPIC_API_KEY = 'test-anthropic-key',
  } = envOverrides;

  process.env = {
    ...originalEnv,
    NODE_ENV: 'production',
    LOG_LEVEL: 'error',
    VERCEL: '1',
    OPENAI_API_KEY,
    DEEPSEEK_API_KEY,
    ANTHROPIC_API_KEY,
    FIREBASE_SERVICE_ACCOUNT_JSON,
    ...envOverrides,
  };

  delete require.cache[require.resolve('../api/index')];
  require.cache[axiosPath] = {
    id: axiosPath,
    filename: axiosPath,
    loaded: true,
    exports: mockAxios,
  };
  require.cache[firebasePath] = {
    id: firebasePath,
    filename: firebasePath,
    loaded: true,
    exports: mockFirebaseAdmin,
  };

  return require('../api/index');
};

test.afterEach(() => {
  firestoreGetMock = async () => ({ exists: false, data: () => ({}) });
  mockAxios.post = async () => {
    throw new Error('mockAxios.post not configured for this test');
  };
});

test.after(() => {
  process.env = originalEnv;
});

const createMockResponse = () => ({
  statusCode: 200,
  body: undefined,
  text: undefined,
  headers: {},
  sent: false,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(payload) {
    this.body = payload;
    this.sent = true;
    return this;
  },
  send(payload) {
    this.text = payload;
    this.sent = true;
    return this;
  },
  setHeader(key, value) {
    this.headers[String(key).toLowerCase()] = value;
  },
  getHeader(key) {
    return this.headers[String(key).toLowerCase()];
  },
});

const invokeHandlers = async (handlers, req) => {
  const res = createMockResponse();

  let idx = 0;
  while (idx < handlers.length && !res.sent) {
    const handler = handlers[idx++];
    await new Promise((resolve, reject) => {
      const next = (err) => (err ? reject(err) : resolve());
      try {
        const out = handler(req, res, next);
        if (out && typeof out.then === 'function') {
          out.then(resolve).catch(reject);
          return;
        }
        if (res.sent) {
          resolve();
          return;
        }
        if (handler.length < 3) {
          resolve();
        }
      } catch (err) {
        reject(err);
      }
    });
  }

  return res;
};

test('GET /health returns OK', async () => {
  const mod = loadAppWithMocks();
  const { healthHandler } = mod.testHandlers;
  const res = await invokeHandlers([healthHandler], {
    method: 'GET',
    path: '/health',
    url: '/health',
    body: {},
    headers: {},
    query: {},
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.text, 'OK');
});

test('POST /api/openai-chat returns sanitized provider failure in production', async () => {
  mockAxios.post = async () => {
    const err = new Error('Rate limited');
    err.response = {
      status: 429,
      data: { error: { message: 'upstream internal detail' } },
    };
    throw err;
  };

  const mod = loadAppWithMocks();
  const { requireOpenAiKey, openAiChatHandler } = mod.testHandlers;
  const res = await invokeHandlers([requireOpenAiKey, openAiChatHandler], {
    method: 'POST',
    path: '/api/openai-chat',
    url: '/api/openai-chat',
    body: { modelMessages: [{ role: 'user', content: 'Hello' }] },
    headers: {},
    query: {},
  });

  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, {
    error: 'An error occurred while communicating with the OpenAI API',
    details: 'Upstream provider request failed. Check server logs for details.',
  });
});

test('OpenAI key middleware returns 500 when key is missing', async () => {
  const mod = loadAppWithMocks({ env: { OPENAI_API_KEY: '' } });
  const { requireOpenAiKey } = mod.testHandlers;
  const res = await invokeHandlers([requireOpenAiKey], {
    method: 'POST',
    path: '/api/openai-chat',
    url: '/api/openai-chat',
    body: {},
    headers: {},
    query: {},
  });

  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, {
    error: 'OpenAI API key is not set in environment variables',
  });
});

test('DeepSeek key middleware returns 500 when key is missing', async () => {
  const mod = loadAppWithMocks({ env: { DEEPSEEK_API_KEY: '' } });
  const { requireDeepSeekKey } = mod.testHandlers;
  const res = await invokeHandlers([requireDeepSeekKey], {
    method: 'POST',
    path: '/api/deepseek-chat',
    url: '/api/deepseek-chat',
    body: {},
    headers: {},
    query: {},
  });

  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, {
    error: 'DeepSeek API key is not set in environment variables',
  });
});

test('Anthropic key middleware returns 500 when key is missing', async () => {
  const mod = loadAppWithMocks({ env: { ANTHROPIC_API_KEY: '' } });
  const { requireAnthropicKey } = mod.testHandlers;
  const res = await invokeHandlers([requireAnthropicKey], {
    method: 'POST',
    path: '/api/anthropic-chat',
    url: '/api/anthropic-chat',
    body: {},
    headers: {},
    query: {},
  });

  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, {
    error: 'Anthropic API key is not set in environment variables',
  });
});

test('Transcript route returns 400 when videoID is missing', async () => {
  const mod = loadAppWithMocks();
  const { requireOpenAiKey, openAiChatYoutubeTranscriptHandler } =
    mod.testHandlers;
  const res = await invokeHandlers(
    [requireOpenAiKey, openAiChatYoutubeTranscriptHandler],
    {
      method: 'POST',
      path: '/api/openai-chat-youtube-transcript',
      url: '/api/openai-chat-youtube-transcript',
      body: {},
      headers: {},
      query: {},
    },
  );

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: 'Invalid video ID' });
});

test('Transcript route returns 503 when Firebase is not configured', async () => {
  const mod = loadAppWithMocks({ env: { FIREBASE_SERVICE_ACCOUNT_JSON: '' } });
  const { requireOpenAiKey, openAiChatYoutubeTranscriptHandler } =
    mod.testHandlers;
  const res = await invokeHandlers(
    [requireOpenAiKey, openAiChatYoutubeTranscriptHandler],
    {
      method: 'POST',
      path: '/api/openai-chat-youtube-transcript',
      url: '/api/openai-chat-youtube-transcript',
      body: { videoID: 'abc123' },
      headers: {},
      query: {},
    },
  );

  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, {
    error: 'Transcript service is unavailable. Firebase is not configured.',
  });
});

test('Transcript route returns 404 when transcript is not found', async () => {
  firestoreGetMock = async () => ({ exists: false, data: () => ({}) });
  const mod = loadAppWithMocks();
  const { requireOpenAiKey, openAiChatYoutubeTranscriptHandler } =
    mod.testHandlers;
  const res = await invokeHandlers(
    [requireOpenAiKey, openAiChatYoutubeTranscriptHandler],
    {
      method: 'POST',
      path: '/api/openai-chat-youtube-transcript',
      url: '/api/openai-chat-youtube-transcript',
      body: { videoID: 'abc123' },
      headers: {},
      query: {},
    },
  );

  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { error: 'Transcript not found for this video.' });
});

test('Transcript route returns 404 when transcript is empty', async () => {
  firestoreGetMock = async () => ({
    exists: true,
    data: () => ({ transcript: '' }),
  });
  const mod = loadAppWithMocks();
  const { requireOpenAiKey, openAiChatYoutubeTranscriptHandler } =
    mod.testHandlers;
  const res = await invokeHandlers(
    [requireOpenAiKey, openAiChatYoutubeTranscriptHandler],
    {
      method: 'POST',
      path: '/api/openai-chat-youtube-transcript',
      url: '/api/openai-chat-youtube-transcript',
      body: { videoID: 'abc123' },
      headers: {},
      query: {},
    },
  );

  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { error: 'No transcript was found.' });
});
