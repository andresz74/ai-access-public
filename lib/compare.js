const SUPPORTED_PROVIDERS = ['openai', 'deepseek', 'anthropic'];
const DEFAULT_COMPARE_TIMEOUT_MS = 45000;

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

const runProviderTask = async ({
  provider,
  prompt,
  imageUrl,
  providerOptions,
  providerAvailability,
  providerExecutors,
  timeoutMs,
  getClientErrorDetails,
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
  if (provider === 'deepseek' && typeof imageUrl === 'string' && imageUrl) {
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
        ...(imageUrl ? { imageUrl } : {}),
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
    const modelMessages =
      typeof options.imageUrl === 'string' && options.imageUrl
        ? [
            {
              role: 'user',
              content: [
                { type: 'input_text', text: prompt },
                { type: 'input_image', image_url: options.imageUrl },
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
    const maxTokens = toIntegerOrDefault(options.maxTokens, 1024);
    const anthropic = createAnthropicClient();
    const userContent =
      typeof options.imageUrl === 'string' && options.imageUrl
        ? [
            { type: 'text', text: prompt },
            {
              type: 'image',
              source: {
                type: 'url',
                url: options.imageUrl,
              },
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

  const providerExecutors = createProviderExecutors(deps);
  const tasks = request.providers.map((provider) =>
    runProviderTask({
      provider,
      prompt: request.prompt,
      imageUrl: request.imageUrl,
      providerOptions: request.providerOptions,
      providerAvailability: deps.providerAvailability,
      providerExecutors,
      timeoutMs,
      getClientErrorDetails: deps.getClientErrorDetails,
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
