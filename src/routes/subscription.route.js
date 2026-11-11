import { Router } from 'express';
import {
  getSalesDashboardData,
  activateOrRenewSubscription,
  getSubscriptionDetail,
} from '../controllers/subscription.controller.js';
// Importa tus middlewares de autenticación habituales
// import { requireAuth, requireSuperAdmin } from '../middlewares/auth.middleware.js';

const router = Router();

// Rutas protegidas para SuperAdmin / Asesora de Ventas
router.get('/', getSalesDashboardData);
router.get('/:companyId/subscription', getSubscriptionDetail);
router.post('/:companyId/activate', activateOrRenewSubscription);

export default router;