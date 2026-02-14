const toPositiveInt = (value, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
};

const parseAccessKeys = (value) =>
  String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

const getRequestIp = (req) => {
  const forwarded = req.headers?.['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || 'unknown';
};

const createApiAccessMiddleware = ({ keys, logger }) => {
  const allowList = Array.isArray(keys) ? keys.filter(Boolean) : [];
  if (allowList.length === 0) {
    return (req, res, next) => next();
  }

  return (req, res, next) => {
    const headerKey = req.headers?.['x-api-key'];
    const authHeader = req.headers?.authorization;
    const bearerToken =
      typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
        ? authHeader.slice(7).trim()
        : '';
    const suppliedKey = String(headerKey || bearerToken || '').trim();

    if (!suppliedKey) {
      return res.status(401).json({
        error: 'Missing API access key',
        details: 'Provide X-API-Key or Authorization: Bearer <token>.',
      });
    }

    if (!allowList.includes(suppliedKey)) {
      logger?.warn?.('Rejected request with invalid API access key');
      return res.status(403).json({
        error: 'Invalid API access key',
      });
    }

    return next();
  };
};

const createIpRateLimiter = ({
  windowMs,
  maxRequests,
  logger,
  label = 'api',
}) => {
  const windowDurationMs = toPositiveInt(windowMs, 60_000);
  const requestLimit = toPositiveInt(maxRequests, 60);
  const entries = new Map();

  return (req, res, next) => {
    const now = Date.now();
    const ip = getRequestIp(req);
    const existing = entries.get(ip);

    if (!existing || now >= existing.resetAt) {
      entries.set(ip, { count: 1, resetAt: now + windowDurationMs });
    } else {
      existing.count += 1;
    }

    const state = entries.get(ip);
    const remaining = Math.max(requestLimit - state.count, 0);
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((state.resetAt - now) / 1000),
    );

    res.setHeader('X-RateLimit-Limit', String(requestLimit));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    res.setHeader('X-RateLimit-Reset', String(retryAfterSeconds));

    if (state.count > requestLimit) {
      logger?.warn?.(
        `Rate limit exceeded (${label})`,
        JSON.stringify({ ip, path: req.path, method: req.method }),
      );
      res.setHeader('Retry-After', String(retryAfterSeconds));
      return res.status(429).json({
        error: 'Rate limit exceeded',
        details: `Too many requests. Retry in ${retryAfterSeconds} seconds.`,
      });
    }

    return next();
  };
};

module.exports = {
  parseAccessKeys,
  createApiAccessMiddleware,
  createIpRateLimiter,
};
