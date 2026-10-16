import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import express, { type ErrorRequestHandler } from 'express';
import session from 'express-session';
import helmet from 'helmet';
import { isCookieSecure, type Env } from './config/env.js';
import type { CryptoService } from './crypto/index.js';
import type { FileStore } from './crypto/file-store.js';
import type { Database } from './db/client.js';
import { CSRF_ERROR_CODE, csrfSynchronisedProtection, generateToken } from './http/csrf.js';
import { viewHelpers } from './http/format.js';
import { exposeFlash, loadCurrentUser, renderNotFound, SESSION_COOKIE } from './http/session.js';
import { exposeTheme } from './http/theme.js';
import './http/types.js';
import { adminGroupsRoutes } from './modules/admin-groups/admin-groups.routes.js';
import { adminUsersRoutes } from './modules/admin-users/admin-users.routes.js';
import { attemptRoutes } from './modules/attempts/attempts.routes.js';
import { authRoutes } from './modules/auth/auth.routes.js';
import { bankRoutes, bankUploadParser } from './modules/banks/banks.routes.js';
import { homeRoutes } from './modules/home/home.routes.js';

export interface AppDeps {
  env: Env;
  db: Database;
  crypto: CryptoService;
  fileStore: FileStore;
  sessionStore: session.Store;
}

export function createApp(deps: AppDeps) {
  const { env, db, crypto } = deps;
  const production = env.NODE_ENV === 'production';
  const app = express();

  app.set('trust proxy', env.TRUST_PROXY);
  app.disable('x-powered-by');
  app.set('view engine', 'ejs');
  app.set('views', path.join(import.meta.dirname, 'views'));
  app.locals.appName = 'Sabatina';
  Object.assign(app.locals, viewHelpers);

  // O padrão do helmet já traz default-src 'self', script-src 'self', img-src 'self' data: e HSTS.
  // Nenhuma página é feita para ser aberta dentro de outro site: frame-ancestors 'none'.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          styleSrc: ["'self'"],
          fontSrc: ["'self'"],
          frameAncestors: ["'none'"],
          upgradeInsecureRequests: production ? [] : null,
        },
      },
      frameguard: { action: 'deny' },
    }),
  );
  app.use(
    express.static(path.join(import.meta.dirname, 'public'), {
      index: false,
      maxAge: production ? '1h' : 0,
    }),
  );

  app.get('/health', async (_req, res) => {
    try {
      await db.execute(sql`select 1`);
      res.json({ status: 'ok' });
    } catch {
      res.status(503).json({ status: 'indisponivel' });
    }
  });

  // Páginas com dados do usuário nunca ficam em cache (nem no botão Voltar depois de sair).
  app.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.use(exposeTheme);
  app.use(express.urlencoded({ extended: false, limit: '50kb' }));
  app.use(express.json({ limit: '50kb' }));
  app.use(
    session({
      name: SESSION_COOKIE,
      secret: env.SESSION_SECRET,
      store: deps.sessionStore,
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: isCookieSecure(env),
        maxAge: env.SESSION_IDLE_HOURS * 60 * 60_000,
      },
    }),
  );
  app.use(loadCurrentUser(db, crypto));
  app.use((req, res, next) => {
    res.locals.csrfToken = () => generateToken(req);
    res.locals.currentPath = req.path;
    next();
  });
  // O upload é multipart: o token CSRF só existe depois que o multer lê o formulário.
  app.post('/bancos', bankUploadParser(env));
  app.use(csrfSynchronisedProtection);
  app.use(exposeFlash);

  app.use(homeRoutes(deps));
  app.use(authRoutes(deps));
  app.use(bankRoutes(deps));
  app.use(attemptRoutes(deps));
  app.use('/admin', adminUsersRoutes(deps));
  app.use('/admin', adminGroupsRoutes(deps));

  app.use(renderNotFound);

  const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
    if (error?.code === CSRF_ERROR_CODE) {
      return res.status(403).render('errors/sessao-expirada', { title: 'Sessão expirada' });
    }
    const hex = randomBytes(4).toString('hex').toUpperCase();
    const reference = `${hex.slice(0, 4)}-${hex.slice(4)}`;
    console.error(`[erro ${reference}]`, error);
    if (res.headersSent) return;
    const status = error?.status >= 400 && error?.status < 500 ? error.status : 500;
    res.status(status).render('errors/500', { title: 'Algo deu errado', reference, status });
  };
  app.use(errorHandler);

  return app;
}
