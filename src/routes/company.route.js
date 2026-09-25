import { Router } from "express";
import {
  createCompany,
  getCompanies,
  getCompanyByCode,
  updateCompany,
  deleteCompany,
  publicGetCompanies,
  getBoardsByCompanyCode,
} from "../controllers/company.controller.js";
import { authMiddleware, requireRole } from "../middlewares/auth.middleware.js";

const router = Router();

// 🌐 1. Rutas Públicas (QR, accesos sin login)
router.get("/public", publicGetCompanies);
router.get("/public/:code/boards", getBoardsByCompanyCode);

// 🔒 2. Rutas que requieren estar autenticado (SUPERADMIN y ADMIN pueden leer)
router.get("/", authMiddleware, getCompanies);
router.get("/:publicCode", authMiddleware, getCompanyByCode);

// 🛡️ 3. Rutas exclusivas de mutación administrativa (Solo SUPERADMIN)
router.post("/", authMiddleware, requireRole("SUPERADMIN"), createCompany);
router.put("/:publicCode", authMiddleware, requireRole("SUPERADMIN"), updateCompany);
router.delete("/:publicCode", authMiddleware, requireRole("SUPERADMIN"), deleteCompany);

export default router;