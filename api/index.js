// Import required packages
const { Anthropic } = require('@anthropic-ai/sdk');
const axios = require('axios');
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { Configuration, OpenAIApi } = require('openai'); // Correct import for OpenAI SDK v4.0
const { resolvePrompt } = require('./prompts');
const { registerRoutes } = require('./routes');

// Load environment variables before any process.env reads.
dotenv.config();

const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const configuredLogLevel = (process.env.LOG_LEVEL || 'info').toLowerCase();
const activeLogLevel = Object.prototype.hasOwnProperty.call(
  LOG_LEVELS,
  configuredLogLevel,
)
  ? configuredLogLevel
  : 'info';
const LOG_METHODS = {
  error: 'error',
  warn: 'warn',
  info: 'info',
  debug: 'log',
};

const shouldLog = (level) => LOG_LEVELS[level] <= LOG_LEVELS[activeLogLevel];
const logAt = (level, ...args) => {
  if (!shouldLog(level)) return;
  console[LOG_METHODS[level]](...args);
};

const logger = {
  error: (...args) => logAt('error', ...args),
  warn: (...args) => logAt('warn', ...args),
  info: (...args) => logAt('info', ...args),
  debug: (...args) => logAt('debug', ...args),
};

const isProduction = process.env.NODE_ENV === 'production';
const productionErrorDetails =
  'Upstream provider request failed. Check server logs for details.';
const extractUpstreamErrorMessage = (error) => {
  if (!error) return null;
  if (error.code === 'timeout' && error.message) return error.message;

  const data = error?.response?.data;
  if (!data) return null;

  if (typeof data === 'string' && data.trim()) return data.trim();
  if (typeof data?.error === 'string' && data.error.trim()) {
    return data.error.trim();
  }
  if (typeof data?.message === 'string' && data.message.trim()) {
    return data.message.trim();
  }
  if (typeof data?.error?.message === 'string' && data.error.message.trim()) {
    return data.error.message.trim();
  }

  return null;
};

const getClientErrorDetails = (error) => {
  if (isProduction) {
    const upstreamMessage = extractUpstreamErrorMessage(error);
    if (upstreamMessage) return upstreamMessage;
    return productionErrorDetails;
  }
  if (error?.response?.data)
    return JSON.stringify(error.response.data, null, 2);
  return error?.message || 'Unknown error';
};

const logProviderError = (context, error) => {
  const status = error?.response?.status || 'no-status';
  logger.error(`${context}:`, status, error?.message || 'Unknown error');
  if (error?.response?.data) {
    logger.error(`${context} providerDetails:`, error.response.data);
  }
  if (error?.stack) {
    logger.debug(`${context} stack:`, error.stack);
  }
};

const buildInternalErrorResponse = (error) => {
  if (isProduction) {
    return { error: 'An internal server error occurred.' };
  }
  return {
    error: 'An internal server error occurred.',
    details: error?.message || 'Unknown error',
  };
};

logger.info('API process starting');
logger.info('Active LOG_LEVEL:', activeLogLevel);

const configuredPromptVersions = {
  transcriptSummary: process.env.PROMPT_VERSION_TRANSCRIPT_SUMMARY || 'v1',
  transcriptSummaryV2: process.env.PROMPT_VERSION_TRANSCRIPT_SUMMARY_V2 || 'v1',
  transcriptTags: process.env.PROMPT_VERSION_TRANSCRIPT_TAGS || 'v1',
};
const {
  prompt: transcriptSummaryPrompt,
  version: activeTranscriptSummaryVersion,
} = resolvePrompt(
  'transcript_summary',
  configuredPromptVersions.transcriptSummary,
  logger,
);
const {
  prompt: transcriptSummaryPromptV2,
  version: activeTranscriptSummaryV2Version,
} = resolvePrompt(
  'transcript_summary_v2',
  configuredPromptVersions.transcriptSummaryV2,
  logger,
);
const { prompt: transcriptTagsPrompt, version: activeTranscriptTagsVersion } =
  resolvePrompt(
    'transcript_tags',
    configuredPromptVersions.transcriptTags,
    logger,
  );
logger.info('Active prompt versions:', {
  transcript_summary: activeTranscriptSummaryVersion,
  transcript_summary_v2: activeTranscriptSummaryV2Version,
  transcript_tags: activeTranscriptTagsVersion,
});

// Initialize Firebase Admin
const firebaseAdmin = require('firebase-admin');
const initializeFirestore = () => {
  const encodedServiceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!encodedServiceAccount) {
    logger.warn(
      'Firebase initialization skipped: FIREBASE_SERVICE_ACCOUNT_JSON is not set.',
    );
    return null;
  }

  try {
    const decodedServiceAccount = Buffer.from(
      encodedServiceAccount,
      'base64',
    ).toString('utf-8');
    const serviceAccount = JSON.parse(decodedServiceAccount);

    firebaseAdmin.initializeApp({
      credential: firebaseAdmin.credential.cert(serviceAccount),
    });

    logger.info('Firebase initialized successfully.');
    return firebaseAdmin.firestore();
  } catch (error) {
    logger.error('Firebase initialization failed:', error.message);
    logger.debug('Firebase initialization stack:', error.stack);
    return null;
  }
};

const db = initializeFirestore();

// Initialize the Express app
const app = express();
const port = process.env.PORT || 3001;

// Restore original path when Vercel rewrites to /api/index?path=...
app.use((req, res, next) => {
  const pathParam = req.query?.path;
  if (pathParam !== undefined) {
    const pathValue = Array.isArray(pathParam)
      ? pathParam.join('/')
      : pathParam;
    const query = { ...req.query };
    delete query.path;
    const params = new URLSearchParams();
    Object.entries(query).forEach(([key, value]) => {
      if (Array.isArray(value)) {
        value.forEach((v) => params.append(key, String(v)));
      } else if (value !== undefined) {
        params.append(key, String(value));
      }
    });
    const search = params.toString();
    const normalizedPath = pathValue ? `/${pathValue}` : '/';
    req.url = `${normalizedPath}${search ? `?${search}` : ''}`;
  }
  next();
});

// Set up CORS options - avoid '*' in production
const corsOptions = {
  origin: (incomingOrigin, callback) => {
    const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
      .split(',')
      .map((o) => o.trim().toLowerCase()); // normalize all allowed origins

    const originToCheck = (incomingOrigin || '').toLowerCase();

    if (!originToCheck || allowedOrigins.includes(originToCheck)) {
      callback(null, true);
    } else {
      callback(new Error(`Origin ${originToCheck} not allowed by CORS`));
    }
  },
  optionsSuccessStatus: 200,
  credentials: true,
};
app.use(cors(corsOptions));

// Enable JSON support
app.use(express.json());

// OpenAI API key and model
const openApiKey = process.env.OPENAI_API_KEY;
const openAiModel = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const openAiReasoningEffort = process.env.OPENAI_REASONING_EFFORT || 'low';
const deepSeekModel = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
const anthropicModel = process.env.ANTHROPIC_MODEL || 'claude-3-5-haiku-latest';

const buildResponsesPayload = (modelMessages, maxOutputTokens) => ({
  model: openAiModel,
  input: modelMessages,
  max_output_tokens: maxOutputTokens,
  reasoning: { effort: openAiReasoningEffort },
  text: { format: { type: 'text' } },
});

const extractResponsesText = (responseData) => {
  const outputItems = Array.isArray(responseData?.output)
    ? responseData.output
    : [];
  const texts = [];
  const debugParts = [];

  outputItems.forEach((item) => {
    const content = Array.isArray(item?.content) ? item.content : [];
    content.forEach((part) => {
      const partType = part?.type;
      const partText = part?.text;
      debugParts.push({
        itemType: item?.type,
        partType: partType || 'none',
        hasText: Boolean(partText),
        textLength: partText ? partText.length : 0,
      });
      if (!partText) return;
      if (partType === 'output_text' || partType === 'text' || !partType) {
        texts.push(partText);
      }
    });
  });

  return { text: texts.join('\n'), debugParts };
};
logger.info('Using OpenAI model:', openAiModel);
// Initialize OpenAI SDK v4.0
const configuration = new Configuration({
  apiKey: openApiKey, // Ensure the API key is loaded from your environment
});
const openai = new OpenAIApi(configuration);

const requireApiKey = (apiKey, label) => (req, res, next) => {
  if (!apiKey) {
    return res
      .status(500)
      .json({ error: `${label} API key is not set in environment variables` });
  }
  next();
};

const requireOpenAiKey = requireApiKey(openApiKey, 'OpenAI');
const requireAnthropicKey = requireApiKey(
  process.env.ANTHROPIC_API_KEY,
  'Anthropic',
);
const deepSeekKey = process.env.DEEPSEEK_API_KEY;
const requireDeepSeekKey = requireApiKey(deepSeekKey, 'DeepSeek');
const providerAvailability = {
  openai: Boolean(openApiKey),
  deepseek: Boolean(deepSeekKey),
  anthropic: Boolean(process.env.ANTHROPIC_API_KEY),
};

const createProviderErrorResponse = (res, providerLabel, routePath, error) => {
  logProviderError(`${providerLabel} API Error at ${routePath}`, error);
  return res.status(500).json({
    error: `An error occurred while communicating with the ${providerLabel} API`,
    details: getClientErrorDetails(error),
  });
};

const getValidModelMessages = (res, modelMessages) => {
  if (!modelMessages || !Array.isArray(modelMessages)) {
    res.status(400).json({ error: 'Invalid modelMessages format' });
    return null;
  }
  return modelMessages;
};

const getTranscriptOrRespond = async (res, videoID) => {
  if (!videoID) {
    res.status(400).json({ error: 'Invalid video ID' });
    return null;
  }

  if (!db) {
    res.status(503).json({
      error: 'Transcript service is unavailable. Firebase is not configured.',
    });
    return null;
  }

  try {
    const doc = await db.collection('transcripts').doc(videoID).get();
    if (!doc.exists) {
      res.status(404).json({ error: 'Transcript not found for this video.' });
      return null;
    }

    const transcript = doc.data()?.transcript;
    if (!transcript || transcript.length === 0) {
      res.status(404).json({ error: 'No transcript was found.' });
      return null;
    }
    return transcript;
  } catch (error) {
    logger.error('Firestore transcript lookup failed:', error.message);
    logger.debug('Firestore transcript lookup stack:', error.stack);
    res
      .status(503)
      .json({ error: 'Transcript service is temporarily unavailable.' });
    return null;
  }
};

const openAiResponsesUrl = 'https://api.openai.com/v1/responses';
const openAiRequestConfig = {
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${openApiKey}`,
  },
  timeout: 60000,
};

const callOpenAiResponses = async (modelMessages, maxOutputTokens) =>
  axios.post(
    openAiResponsesUrl,
    buildResponsesPayload(modelMessages, maxOutputTokens),
    openAiRequestConfig,
  );

const deepSeekChatUrl = 'https://api.deepseek.com/chat/completions';
const buildDeepSeekChatPayload = (modelMessages, maxTokens = 1024) => ({
  messages: modelMessages,
  model: deepSeekModel,
  frequency_penalty: 0,
  max_tokens: maxTokens,
  presence_penalty: 0,
  response_format: { type: 'text' },
  stop: null,
  stream: false,
  stream_options: null,
  temperature: 0.5,
  top_p: 1,
  tools: null,
  tool_choice: 'none',
  logprobs: false,
  top_logprobs: null,
});

const callDeepSeekChatAxios = async (modelMessages, maxTokens = 1024) =>
  axios({
    method: 'post',
    url: deepSeekChatUrl,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${deepSeekKey}`,
    },
    data: JSON.stringify(buildDeepSeekChatPayload(modelMessages, maxTokens)),
  });

const createAnthropicClient = (timeout) =>
  new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    ...(timeout ? { timeout } : {}),
  });
// Initialize DeepSeek OpenAI-compatible client
const configurationDeepseek = new Configuration({
  baseURL: 'https://api.deepseek.com',
  apiKey: deepSeekKey, // Ensure the API key is loaded from your environment
});
const deepseekAi = new OpenAIApi(configurationDeepseek);

const {
  healthHandler,
  openAiChatHandler,
  openAiChatYoutubeTranscriptHandler,
  compareHandler,
} = registerRoutes(app, {
  logger,
  vercelRegion: process.env.VERCEL_REGION,
  requireOpenAiKey,
  requireDeepSeekKey,
  requireAnthropicKey,
  getValidModelMessages,
  getTranscriptOrRespond,
  callOpenAiResponses,
  extractResponsesText,
  createProviderErrorResponse,
  callDeepSeekChatAxios,
  deepseekAi,
  createAnthropicClient,
  transcriptSummaryPrompt,
  transcriptSummaryPromptV2,
  transcriptTagsPrompt,
  providerAvailability,
  getClientErrorDetails,
  openAiModel,
  deepSeekModel,
  anthropicModel,
});

// Global error handler should be registered after routes.
app.use((err, req, res, next) => {
  logger.error('Global Error Handler:', err.stack);
  res.status(500).json(buildInternalErrorResponse(err));
});

// Start the server locally; Vercel provides the HTTP server in production.
if (!process.env.VERCEL) {
  const server = app.listen(port, () => {
    logger.info(`Server is running on http://localhost:${port}`);
  });

  // Set the server timeout to 30 seconds
  server.timeout = 30000; // Set the timeout to 30 seconds (30000 ms)
}

module.exports = app;
module.exports.testHandlers = {
  healthHandler,
  openAiChatHandler,
  openAiChatYoutubeTranscriptHandler,
  compareHandler,
  requireOpenAiKey,
  requireDeepSeekKey,
  requireAnthropicKey,
};
