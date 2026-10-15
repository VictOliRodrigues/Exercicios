import type { Role } from '../modules/users/users.service.js';

export interface CurrentUser {
  id: string;
  role: Role;
  name: string;
  mustChangePassword: boolean;
}

export interface FlashMessage {
  type: 'success' | 'error' | 'info';
  message: string;
}

/** Resultado da última importação, mostrado uma vez na página do simulado. Só números e avisos. */
export interface ImportResult {
  bankId: string;
  questionCount: number;
  warnings: string[];
}

declare module 'express-session' {
  interface SessionData {
    userId?: string;
    role?: Role;
    sessionVersion?: number;
    flash?: FlashMessage[];
    importResult?: ImportResult;
  }
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      currentUser?: CurrentUser;
    }
  }
}
