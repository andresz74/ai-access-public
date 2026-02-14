const axios = require('axios');

const SUPPORTED_PROVIDERS = ['openai', 'deepseek', 'anthropic'];
const DEFAULT_COMPARE_TIMEOUT_MS = 45000;
const IMAGE_FETCH_TIMEOUT_MS = 20000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const isObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const normalizeProvidersInput = (providers) => {
  if (providers === undefined) {
    return {
      providers: [...SUPPORTED_PROVIDERS],
      unsupportedProviders: [],
    };
  }

  if (!Array.isArray(providers)) {
    return {
      providers: null,
      unsupportedProviders: [],
      validationError: '"providers" must be an array when provided.',
    };
  }

  const normalized = [];
  const unsupportedProviders = [];

  providers.forEach((provider) => {
    if (typeof provider !== 'string') {
      unsupportedProviders.push(String(provider));
      return;
    }

    const key = provider.toLowerCase().trim();
    if (!key) return;

    if (!SUPPORTED_PROVIDERS.includes(key)) {
      unsupportedProviders.push(provider);
      return;
    }

    if (!normalized.includes(key)) {
      normalized.push(key);
    }
  });

  if (normalized.length === 0) {
    return {
      providers: null,
      unsupportedProviders,
      validationError:
        'At least one supported provider is required in "providers".',
    };
  }

  return { providers: normalized, unsupportedProviders };
};

const parseCompareRequest = (body) => {
  const prompt = body?.prompt;
  if (typeof prompt !== 'string' || !prompt.trim()) {
    return {
      error: '"prompt" is required and must be a non-empty string.',
    };
  }

  const providerSelection = normalizeProvidersInput(body?.providers);
  if (providerSelection.validationError) {
    return {
      error: providerSelection.validationError,
      unsupportedProviders: providerSelection.unsupportedProviders,
    };
  }

  const providerOptions = isObject(body?.providerOptions)
    ? body.providerOptions
    : {};
  const imageUrl = body?.imageUrl;
  if (
    imageUrl !== undefined &&
    (typeof imageUrl !== 'string' || !imageUrl.trim())
  ) {
    return {
      error: '"imageUrl" must be a non-empty string when provided.',
      unsupportedProviders: providerSelection.unsupportedProviders,
    };
  }

  return {
    prompt: prompt.trim(),
    imageUrl: imageUrl ? imageUrl.trim() : undefined,
    providers: providerSelection.providers,
    unsupportedProviders: providerSelection.unsupportedProviders,
    providerOptions,
  };
};

const toIntegerOrDefault = (value, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
};

const withTimeout = async (promise, timeoutMs, provider) => {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const err = new Error(
        `${provider} request timed out after ${timeoutMs}ms`,
      );
      err.code = 'timeout';
      reject(err);
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId);
  }
};

const extractDeepSeekText = (responseData) => {
  if (!Array.isArray(responseData?.choices)) return '';

  return responseData.choices
    .map((choice) => choice?.message?.content)
    .filter((part) => typeof part === 'string' && part.length > 0)
    .join('\n')
    .trim();
};

const extractAnthropicText = (responseData) => {
  if (!Array.isArray(responseData?.content)) return '';

  return responseData.content
    .filter(
      (block) => block?.type === 'text' && typeof block?.text === 'string',
    )
    .map((block) => block.text)
    .join('\n')
    .trim();
};

const parseDataUrlImage = (value) => {
  if (typeof value !== 'string') return null;
  const match = value.match(/^data:([^;,]+);base64,([\s\S]+)$/i);
  if (!match) return null;
  const mediaType = match[1].toLowerCase().trim();
  const data = match[2].trim();
  if (!mediaType.startsWith('image/')) {
    throw new Error('imageUrl data URL must contain an image media type.');
  }
  if (!data) {
    throw new Error('imageUrl data URL is missing base64 image data.');
  }
  return { mediaType, data };
};

const fetchRemoteImageAsBase64 = async (imageUrl) => {
  const response = await axios.get(imageUrl, {
    responseType: 'arraybuffer',
    timeout: IMAGE_FETCH_TIMEOUT_MS,
    maxBodyLength: MAX_IMAGE_BYTES,
    maxContentLength: MAX_IMAGE_BYTES,
    validateStatus: (status) => status >= 200 && status < 300,
  });

  const rawContentType = response.headers?.['content-type'];
  const mediaType = (
    Array.isArray(rawContentType) ? rawContentType[0] : rawContentType || ''
  )
    .split(';')[0]
    .trim()
    .toLowerCase();

  if (!mediaType.startsWith('image/')) {
    throw new Error('imageUrl must point to an image resource.');
  }

  const bytes = Buffer.from(response.data);
  if (!bytes.length) {
    throw new Error('imageUrl resource is empty.');
  }

  return {
    mediaType,
    data: bytes.toString('base64'),
  };
};

const prepareImagePayloads = async (imageUrl) => {
  if (typeof imageUrl !== 'string' || !imageUrl) return null;

  const parsed = parseDataUrlImage(imageUrl);
  const image = parsed || (await fetchRemoteImageAsBase64(imageUrl));

  return {
    openAiImageUrl: `data:${image.mediaType};base64,${image.data}`,
    anthropicImageSource: {
      type: 'base64',
      media_type: image.mediaType,
      data: image.data,
    },
  };
};

const runProviderTask = async ({
  provider,
  prompt,
  imageRequested,
  imagePayload,
  providerOptions,
  providerAvailability,
  providerExecutors,
  timeoutMs,
  getClientErrorDetails,
  logger,
}) => {
  const startedAt = Date.now();
  if (!providerAvailability[provider]) {
    return {
      provider,
      status: 'error',
      latencyMs: 0,
      error: `${provider} API key is not configured`,
    };
  }
  if (provider === 'deepseek' && imageRequested) {
    return {
      provider,
      status: 'error',
      latencyMs: 0,
      error:
        'Image input is not supported for the configured DeepSeek text model.',
    };
  }

  try {
    const payload = await withTimeout(
      providerExecutors[provider](prompt, {
        ...(providerOptions[provider] || {}),
        ...(imagePayload ? { imagePayload } : {}),
      }),
      timeoutMs,
      provider,
    );

    return {
      provider,
      status: 'success',
      latencyMs: Date.now() - startedAt,
      ...payload,
    };
  } catch (error) {
    logger?.error?.(
      `Compare provider error (${provider})`,
      error?.response?.status || 'no-status',
      error?.message || 'Unknown error',
    );
    if (error?.response?.data) {
      logger?.error?.(
        `Compare provider details (${provider})`,
        error.response.data,
      );
    }
    if (error?.stack) {
      logger?.debug?.(`Compare provider stack (${provider})`, error.stack);
    }

    return {
      provider,
      status: 'error',
      latencyMs: Date.now() - startedAt,
      error: getClientErrorDetails(error),
    };
  }
};

const createProviderExecutors = ({
  callOpenAiResponses,
  callDeepSeekChatAxios,
  createAnthropicClient,
  extractResponsesText,
  openAiModel,
  deepSeekModel,
  anthropicModel,
}) => ({
  openai: async (prompt, options) => {
    const imagePayload = options.imagePayload;
    const modelMessages = imagePayload
      ? [
          {
            role: 'user',
            content: [
              { type: 'input_text', text: prompt },
              { type: 'input_image', image_url: imagePayload.openAiImageUrl },
            ],
          },
        ]
      : [{ role: 'user', content: prompt }];
    const maxOutputTokens = toIntegerOrDefault(options.maxOutputTokens, 1024);
    const response = await callOpenAiResponses(modelMessages, maxOutputTokens);
    const extracted = extractResponsesText(response.data);

    return {
      model: openAiModel,
      text: extracted.text,
    };
  },
  deepseek: async (prompt, options) => {
    const modelMessages = [{ role: 'user', content: prompt }];
    const maxTokens = toIntegerOrDefault(options.maxTokens, 1024);
    const response = await callDeepSeekChatAxios(modelMessages, maxTokens);

    return {
      model: deepSeekModel,
      text: extractDeepSeekText(response.data),
    };
  },
  anthropic: async (prompt, options) => {
    const imagePayload = options.imagePayload;
    const maxTokens = toIntegerOrDefault(options.maxTokens, 1024);
    const anthropic = createAnthropicClient();
    const userContent = imagePayload
      ? [
          { type: 'text', text: prompt },
          {
            type: 'image',
            source: imagePayload.anthropicImageSource,
          },
        ]
      : prompt;

    const response = await anthropic.messages.create({
      model: anthropicModel,
      max_tokens: maxTokens,
      temperature: 0.5,
      messages: [{ role: 'user', content: userContent }],
    });

    return {
      model: anthropicModel,
      text: extractAnthropicText(response),
    };
  },
});

const runCompare = async (request, deps) => {
  const timeoutMs = toIntegerOrDefault(
    request?.providerOptions?.timeoutMs,
    DEFAULT_COMPARE_TIMEOUT_MS,
  );

  let imagePayload = null;
  let imagePreparationError = null;
  const needsPreparedImage =
    typeof request.imageUrl === 'string' &&
    request.imageUrl &&
    request.providers.some(
      (provider) => provider === 'openai' || provider === 'anthropic',
    );

  if (needsPreparedImage) {
    try {
      imagePayload = await prepareImagePayloads(request.imageUrl);
    } catch (error) {
      imagePreparationError = error;
      deps.logger?.error?.(
        'Compare image preparation failed',
        error?.response?.status || 'no-status',
        error?.message || 'Unknown error',
      );
      if (error?.response?.data) {
        deps.logger?.error?.(
          'Compare image preparation details',
          error.response.data,
        );
      }
      if (error?.stack) {
        deps.logger?.debug?.('Compare image preparation stack', error.stack);
      }
    }
  }

  const providerExecutors = createProviderExecutors(deps);
  const tasks = request.providers.map((provider) =>
    imagePreparationError && (provider === 'openai' || provider === 'anthropic')
      ? Promise.resolve({
          provider,
          status: 'error',
          latencyMs: 0,
          error: deps.getClientErrorDetails(imagePreparationError),
        })
      : runProviderTask({
          provider,
          prompt: request.prompt,
          imageRequested: Boolean(request.imageUrl),
          imagePayload,
          providerOptions: request.providerOptions,
          providerAvailability: deps.providerAvailability,
          providerExecutors,
          timeoutMs,
          getClientErrorDetails: deps.getClientErrorDetails,
          logger: deps.logger,
        }),
  );

  const results = await Promise.all(tasks);
  return {
    request: {
      prompt: request.prompt,
      imageUrl: request.imageUrl,
      providers: request.providers,
      timeoutMs,
      unsupportedProviders: request.unsupportedProviders,
    },
    results,
  };
};

module.exports = {
  SUPPORTED_PROVIDERS,
  parseCompareRequest,
  runCompare,
};
