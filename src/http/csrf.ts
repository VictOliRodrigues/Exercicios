import { csrfSync } from 'csrf-sync';

export const CSRF_ERROR_CODE = 'EBADCSRFTOKEN';

// O token vem no campo _csrf dos formulários ou no cabeçalho X-CSRF-Token dos fetch.
export const { csrfSynchronisedProtection, generateToken } = csrfSync({
  getTokenFromRequest: (req) => {
    const fromBody: unknown = req.body?._csrf;
    if (typeof fromBody === 'string') return fromBody;
    const fromHeader = req.headers['x-csrf-token'];
    return typeof fromHeader === 'string' ? fromHeader : undefined;
  },
  errorConfig: { statusCode: 403, message: 'Token CSRF inválido', code: CSRF_ERROR_CODE },
});
