import { Router } from 'express';
import { adminOnly } from '../../http/session.js';

export function adminUsersRoutes(): Router {
  const router = Router();
  router.use(...adminOnly);

  // A gestão de usuários e grupos chega na entrega 2.
  router.get('/usuarios', (_req, res) => {
    res.render('admin/usuarios', { title: 'Usuários' });
  });

  return router;
}
