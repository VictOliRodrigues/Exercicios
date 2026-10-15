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

declare module 'express-session' {
  interface SessionData {
    userId?: string;
    role?: Role;
    sessionVersion?: number;
    flash?: FlashMessage[];
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
