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

test('POST /api/compare returns 400 when prompt is missing', async () => {
  const mod = loadAppWithMocks();
  const { compareHandler } = mod.testHandlers;
  const res = await invokeHandlers([compareHandler], {
    method: 'POST',
    path: '/api/compare',
    url: '/api/compare',
    body: { providers: ['openai'] },
    headers: {},
    query: {},
  });

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, {
    error: '"prompt" is required and must be a non-empty string.',
    unsupportedProviders: [],
  });
});

test('POST /api/compare supports partial success when one provider key is missing', async () => {
  mockAxios.post = async () => ({
    data: {
      output: [
        {
          content: [{ type: 'output_text', text: 'OpenAI response body' }],
        },
      ],
    },
  });

  const mod = loadAppWithMocks({ env: { DEEPSEEK_API_KEY: '' } });
  const { compareHandler } = mod.testHandlers;
  const res = await invokeHandlers([compareHandler], {
    method: 'POST',
    path: '/api/compare',
    url: '/api/compare',
    body: {
      prompt: 'Compare this answer',
      providers: ['openai', 'deepseek'],
    },
    headers: {},
    query: {},
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.request.prompt, 'Compare this answer');
  assert.deepEqual(res.body.request.providers, ['openai', 'deepseek']);
  assert.equal(res.body.results.length, 2);
  assert.equal(res.body.results[0].provider, 'openai');
  assert.equal(res.body.results[0].status, 'success');
  assert.equal(res.body.results[0].text, 'OpenAI response body');
  assert.equal(typeof res.body.results[0].model, 'string');
  assert.ok(res.body.results[0].model.length > 0);
  assert.equal(typeof res.body.results[0].latencyMs, 'number');
  assert.deepEqual(res.body.results[1], {
    provider: 'deepseek',
    status: 'error',
    latencyMs: 0,
    error: 'deepseek API key is not configured',
  });
});

test('POST /api/compare returns 400 when imageUrl is invalid', async () => {
  const mod = loadAppWithMocks();
  const { compareHandler } = mod.testHandlers;
  const res = await invokeHandlers([compareHandler], {
    method: 'POST',
    path: '/api/compare',
    url: '/api/compare',
    body: { prompt: 'Describe this image', imageUrl: '' },
    headers: {},
    query: {},
  });

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, {
    error: '"imageUrl" must be a non-empty string when provided.',
    unsupportedProviders: [],
  });
});

test('POST /api/compare forwards imageUrl to OpenAI responses payload', async () => {
  let capturedPayload;
  mockAxios.post = async (url, payload) => {
    capturedPayload = payload;
    return {
      data: {
        output: [
          {
            content: [{ type: 'output_text', text: 'Image summary' }],
          },
        ],
      },
    };
  };

  const mod = loadAppWithMocks();
  const { compareHandler } = mod.testHandlers;
  const res = await invokeHandlers([compareHandler], {
    method: 'POST',
    path: '/api/compare',
    url: '/api/compare',
    body: {
      prompt: 'Describe this image briefly',
      imageUrl: 'https://example.com/cat.png',
      providers: ['openai'],
    },
    headers: {},
    query: {},
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.results.length, 1);
  assert.equal(res.body.results[0].status, 'success');
  assert.equal(res.body.results[0].text, 'Image summary');
  assert.equal(capturedPayload.input[0].role, 'user');
  assert.deepEqual(capturedPayload.input[0].content, [
    { type: 'input_text', text: 'Describe this image briefly' },
    { type: 'input_image', image_url: 'https://example.com/cat.png' },
  ]);
});

test('POST /api/compare returns explicit unsupported error for DeepSeek image input', async () => {
  const mod = loadAppWithMocks();
  const { compareHandler } = mod.testHandlers;
  const res = await invokeHandlers([compareHandler], {
    method: 'POST',
    path: '/api/compare',
    url: '/api/compare',
    body: {
      prompt: 'What is in this image?',
      imageUrl: 'https://example.com/image.jpg',
      providers: ['deepseek'],
    },
    headers: {},
    query: {},
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.results, [
    {
      provider: 'deepseek',
      status: 'error',
      latencyMs: 0,
      error:
        'Image input is not supported for the configured DeepSeek text model.',
    },
  ]);
});
