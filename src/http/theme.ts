import type { NextFunction, Request, Response } from 'express';

const THEMES = new Set(['light', 'dark']);
/** Cookie "tema", gravado pelo botão de claro/escuro (app.js). */
const themeCookie = /(?:^|;\s*)tema=([^;]*)/;

/** Lê o tema escolhido para a página já sair nele, sem piscar. Sem escolha, vale o do sistema. */
export function exposeTheme(req: Request, res: Response, next: NextFunction) {
  const theme = themeCookie.exec(req.headers.cookie ?? '')?.[1];
  res.locals.theme = theme && THEMES.has(theme) ? theme : null;
  next();
}
