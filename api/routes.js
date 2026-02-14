const { parseCompareRequest, runCompare } = require('../lib/compare');
const {
  validateSignupPayload,
  signupWithInvite,
} = require('../lib/invite-signup');

const registerRoutes = (app, deps) => {
  const {
    logger,
    vercelRegion,
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
    requireApiAccess,
    providerRateLimiter,
    db,
    firebaseAdmin,
    inviteSecret,
  } = deps;

  const healthHandler = (req, res) => {
    res.send('OK');
  };

  const debugHandler = (req, res) => {
    res.json({
      ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
      region: vercelRegion || 'local',
    });
  };

  const openAiChatHandler = async (req, res) => {
    logger.info('Received request at /api/openai-chat');

    const modelMessages = getValidModelMessages(res, req.body.modelMessages);
    if (!modelMessages) return;

    try {
      const response = await callOpenAiResponses(modelMessages, 1536);

      const { text, debugParts } = extractResponsesText(response.data);
      logger.debug(
        'openai-chat textLength',
        text.length,
        'partsCount',
        debugParts.length,
      );
      res.json({ ...response.data, text });
    } catch (error) {
      return createProviderErrorResponse(
        res,
        'OpenAI',
        '/api/openai-chat',
        error,
      );
    }
  };

  app.get(['/health', '/api/health'], healthHandler);
  app.get(['/debug', '/api/debug'], debugHandler);

  const signupWithInviteHandler = async (req, res) => {
    logger.info('Received request at /api/signup-with-invite');

    if (!db || !firebaseAdmin || typeof firebaseAdmin.auth !== 'function') {
      return res.status(503).json({
        ok: false,
        code: 'AUTH_SERVICE_UNAVAILABLE',
        message:
          'Authentication service is temporarily unavailable. Verify Firestore and Firebase Admin credentials are configured on the API service.',
      });
    }

    let payload;
    try {
      payload = validateSignupPayload(req.body);
    } catch (error) {
      return res.status(error.status || 400).json({
        ok: false,
        code: error.clientCode || 'REQUEST_INVALID',
        message: error.clientMessage || 'Invalid request payload.',
      });
    }

    try {
      const response = await signupWithInvite({
        db,
        firebaseAdmin,
        logger,
        email: payload.email,
        password: payload.password,
        inviteCode: payload.inviteCode,
        inviteSecret,
      });
      return res.status(201).json(response);
    } catch (error) {
      logger.error(
        'Invite signup rejected:',
        JSON.stringify({
          code: error.clientCode || 'UNKNOWN',
          status: error.status || 500,
          message: error.clientMessage || error.message || 'unknown',
        }),
      );
      if (error?.stack) {
        logger.error('Invite signup stack:', error.stack);
      }
      return res.status(error.status || 500).json({
        ok: false,
        code: error.clientCode || 'SIGNUP_FAILED',
        message: error.clientMessage || 'Could not complete signup.',
      });
    }
  };

  const compareHandler = async (req, res) => {
    logger.info('Received request at /api/compare');
    const parsedRequest = parseCompareRequest(req.body);
    if (parsedRequest.error) {
      return res.status(400).json({
        error: parsedRequest.error,
        unsupportedProviders: parsedRequest.unsupportedProviders || [],
      });
    }

    const compareResponse = await runCompare(parsedRequest, {
      callOpenAiResponses,
      callDeepSeekChatAxios,
      createAnthropicClient,
      extractResponsesText,
      providerAvailability,
      getClientErrorDetails,
      logger,
      openAiModel,
      deepSeekModel,
      anthropicModel,
    });

    return res.json(compareResponse);
  };

  app.post(
    '/api/compare',
    requireApiAccess,
    providerRateLimiter,
    compareHandler,
  );

  app.post(
    '/api/signup-with-invite',
    requireApiAccess,
    signupWithInviteHandler,
  );

  app.post(
    '/api/openai-chat',
    requireApiAccess,
    providerRateLimiter,
    requireOpenAiKey,
    openAiChatHandler,
  );

  app.post(
    '/api/openai-chat-axios',
    requireApiAccess,
    providerRateLimiter,
    requireOpenAiKey,
    async (req, res) => {
      logger.info('Received request at /api/openai-chat-axios');

      const modelMessages = getValidModelMessages(res, req.body.modelMessages);
      if (!modelMessages) return;

      try {
        const openaiResponse = await callOpenAiResponses(modelMessages, 1024);

        const { text, debugParts } = extractResponsesText(openaiResponse.data);
        logger.debug(
          'openai-chat-axios textLength',
          text.length,
          'partsCount',
          debugParts.length,
        );
        res.json({ ...openaiResponse.data, text });
      } catch (error) {
        return createProviderErrorResponse(
          res,
          'OpenAI',
          '/api/openai-chat-axios',
          error,
        );
      }
    },
  );

  const openAiChatYoutubeTranscriptHandler = async (req, res) => {
    logger.info('Received request at /api/openai-chat-youtube-transcript');

    try {
      const transcript = await getTranscriptOrRespond(res, req.body.videoID);
      if (!transcript) return;

      const systemMessage = {
        role: 'system',
        content: transcriptSummaryPrompt,
      };

      const userMessage = {
        role: 'user',
        content: `${transcript}`,
      };

      const modelMessages = [systemMessage, userMessage];
      const response = await callOpenAiResponses(modelMessages, 1024);

      const { text, debugParts } = extractResponsesText(response.data);
      logger.debug(
        'openai-chat-youtube-transcript textLength',
        text.length,
        'partsCount',
        debugParts.length,
      );
      res.json({ ...response.data, text });
    } catch (error) {
      return createProviderErrorResponse(
        res,
        'OpenAI',
        '/api/openai-chat-youtube-transcript',
        error,
      );
    }
  };

  app.post(
    '/api/openai-chat-youtube-transcript',
    requireApiAccess,
    providerRateLimiter,
    requireOpenAiKey,
    openAiChatYoutubeTranscriptHandler,
  );

  app.post(
    [
      '/api/openai-chat-youtube-transcript-v2',
      '/openai-chat-youtube-transcript-v2',
    ],
    requireApiAccess,
    providerRateLimiter,
    requireOpenAiKey,
    async (req, res) => {
      logger.info('Received request at /api/openai-chat-youtube-transcript-v2');

      try {
        const transcript = await getTranscriptOrRespond(res, req.body.videoID);
        if (!transcript) return;
        logger.debug(
          'Loaded transcript length',
          transcript ? transcript.length : 0,
        );

        const summarySystemMessage = {
          role: 'system',
          content: transcriptSummaryPromptV2,
        };

        const tagsSystemMessage = {
          role: 'system',
          content: transcriptTagsPrompt,
        };

        const userMessage = {
          role: 'user',
          content: transcript,
        };

        const modelMessagesSummary = [summarySystemMessage, userMessage];
        const modelMessagesTags = [tagsSystemMessage, userMessage];

        const [summaryResponse, tagsResponse] = await Promise.all([
          callOpenAiResponses(modelMessagesSummary, 1536),
          callOpenAiResponses(modelMessagesTags, 256),
        ]);

        const summary = summaryResponse.data;
        const summaryExtracted = extractResponsesText(summaryResponse.data);
        logger.debug(
          'summaryTextLength',
          summaryExtracted.text.length,
          'summaryPartsCount',
          summaryExtracted.debugParts.length,
        );
        const tagsExtracted = extractResponsesText(tagsResponse.data);
        const rawTags = tagsExtracted.text || '[]';

        let tags;
        try {
          tags = JSON.parse(rawTags);
        } catch (e) {
          logger.warn('Tag parsing failed, using raw string array fallback');
          tags = rawTags
            .split('\n')
            .map((tag) => tag.replace(/^- /, '').trim())
            .filter(Boolean);
        }

        const summaryText = summaryExtracted.text;
        res.json({ summary, summaryText, text: summaryText, tags });
      } catch (error) {
        return createProviderErrorResponse(
          res,
          'OpenAI',
          '/api/openai-chat-youtube-transcript-v2',
          error,
        );
      }
    },
  );

  app.post(
    '/api/deepseek-chat',
    requireApiAccess,
    providerRateLimiter,
    requireDeepSeekKey,
    async (req, res) => {
      logger.info('Received request at /api/deepseek-chat');

      const modelMessages = getValidModelMessages(res, req.body.modelMessages);
      if (!modelMessages) return;

      try {
        logger.debug('deepseek-chat messagesCount', modelMessages.length);
        const response = await deepseekAi.chat.completions.create({
          messages: modelMessages,
          model: deepSeekModel,
          max_tokens: 1024,
          temperature: 0.5,
        });

        logger.debug('deepseek-chat response received');
        res.json(response.data);
      } catch (error) {
        return createProviderErrorResponse(
          res,
          'DeepSeek',
          '/api/deepseek-chat',
          error,
        );
      }
    },
  );

  app.post(
    '/api/deepseek-chat-axios',
    requireApiAccess,
    providerRateLimiter,
    requireDeepSeekKey,
    async (req, res) => {
      logger.info('Received request at /api/deepseek-chat-axios');

      const modelMessages = getValidModelMessages(res, req.body.modelMessages);
      if (!modelMessages) return;

      try {
        const response = await callDeepSeekChatAxios(modelMessages, 1024);
        res.json(response.data);
      } catch (error) {
        return createProviderErrorResponse(
          res,
          'DeepSeek',
          '/api/deepseek-chat-axios',
          error,
        );
      }
    },
  );

  app.post(
    '/api/deepseek-chat-axios-youtube-transcript',
    requireApiAccess,
    providerRateLimiter,
    requireDeepSeekKey,
    async (req, res) => {
      logger.info(
        'Received request at /api/deepseek-chat-axios-youtube-transcript',
      );

      try {
        const transcript = await getTranscriptOrRespond(res, req.body.videoID);
        if (!transcript) return;

        const systemMessage = {
          role: 'system',
          content: transcriptSummaryPrompt,
        };

        const userMessage = {
          role: 'user',
          content: `${transcript}`,
        };

        const modelMessages = [systemMessage, userMessage];
        const response = await callDeepSeekChatAxios(modelMessages, 1024);

        res.json(response.data);
      } catch (error) {
        return createProviderErrorResponse(
          res,
          'DeepSeek',
          '/api/deepseek-chat-axios-youtube-transcript',
          error,
        );
      }
    },
  );

  app.post(
    '/api/anthropic-chat',
    requireApiAccess,
    providerRateLimiter,
    requireAnthropicKey,
    async (req, res) => {
      logger.info('Received request at /api/anthropic-chat');

      const modelMessages = getValidModelMessages(res, req.body.modelMessages);
      if (!modelMessages) return;
      logger.debug(
        'anthropic-chat messagesCount',
        Array.isArray(modelMessages) ? modelMessages.length : 0,
      );

      try {
        const anthropic = createAnthropicClient();
        const response = await anthropic.messages.create({
          model: anthropicModel,
          max_tokens: 1024,
          temperature: 0.5,
          messages: modelMessages,
        });

        res.json(response);
      } catch (error) {
        return createProviderErrorResponse(
          res,
          'Anthropic',
          '/api/anthropic-chat',
          error,
        );
      }
    },
  );

  app.post(
    '/api/anthropic-chat-youtube-transcript',
    requireApiAccess,
    providerRateLimiter,
    requireAnthropicKey,
    async (req, res) => {
      logger.info('Received request at /api/anthropic-chat-youtube-transcript');

      try {
        const transcript = await getTranscriptOrRespond(res, req.body.videoID);
        if (!transcript) return;

        const userMessage = [
          {
            role: 'user',
            content: `${transcript}`,
          },
        ];

        const anthropic = createAnthropicClient(30000);
        const response = await anthropic.messages.create({
          model: anthropicModel,
          max_tokens: 1024,
          temperature: 0.5,
          system: transcriptSummaryPrompt,
          messages: userMessage,
        });

        res.json(response);
      } catch (error) {
        return createProviderErrorResponse(
          res,
          'Anthropic',
          '/api/anthropic-chat-youtube-transcript',
          error,
        );
      }
    },
  );

  return {
    healthHandler,
    openAiChatHandler,
    openAiChatYoutubeTranscriptHandler,
    compareHandler,
    signupWithInviteHandler,
  };
};

module.exports = {
  registerRoutes,
};
