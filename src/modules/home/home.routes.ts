import { Router } from 'express';
import { homePathFor, userOnly } from '../../http/session.js';

export function homeRoutes(): Router {
  const router = Router();

  router.get('/', (req, res, next) => {
    const user = req.currentUser;
    if (!user) return res.redirect('/login');
    if (user.role === 'admin' && !user.mustChangePassword) {
      return res.redirect(homePathFor(user.role));
    }
    next();
  });

  router.get('/', ...userOnly, (req, res) => {
    res.render('painel', {
      title: 'Painel',
      firstName: req.currentUser!.name.split(/\s+/)[0],
    });
  });

  return router;
}
