import { Router } from 'express';
import type { AppDeps } from '../../app.js';
import { homePathFor, userOnly } from '../../http/session.js';
import { listAttemptsOfUser, settleExpiredAttempts } from '../attempts/attempts.service.js';
import { loadPanel } from '../banks/banks.service.js';
import { listGroupsOfUser } from '../groups/groups.service.js';

export function homeRoutes({ db, crypto }: AppDeps): Router {
  const router = Router();

  router.get('/', (req, res, next) => {
    const user = req.currentUser;
    if (!user) return res.redirect('/login');
    if (user.role === 'admin' && !user.mustChangePassword) {
      return res.redirect(homePathFor(user.role));
    }
    next();
  });

  router.get('/', ...userOnly, async (req, res) => {
    const user = req.currentUser!;
    const myGroups = await listGroupsOfUser(db, crypto, user.id);
    // Tentativa vencida com o navegador fechado: finaliza antes de montar o painel.
    await settleExpiredAttempts(db, crypto, user.id);
    res.render('painel', {
      title: 'Painel',
      firstName: user.name.split(/\s+/)[0],
      panel: await loadPanel(db, crypto, user.id, myGroups),
      attempts: await listAttemptsOfUser(db, crypto, user.id),
    });
  });

  return router;
}
