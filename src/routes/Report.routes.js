import { Router } from "express";
import multer from "multer";
// ⚠️ Ajusta la ruta/nombre a tu middleware de autenticación
import { authMiddleware } from "../middlewares/auth.middleware.js";
import {
  deleteReport,
  getReportById,
  getReportsByCompany,
  uploadReport,
} from "../controllers/Report.controller.js";

const router = Router();

// Archivo en memoria, solo PDF, máximo 20 MB
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) =>
    file.mimetype === "application/pdf" ? cb(null, true) : cb(new Error("Solo se permiten archivos PDF")),
});

router.use(authMiddleware);

router.post("/", upload.single("file"), uploadReport);
router.get("/company/:publicCode", getReportsByCompany);
router.get("/:id", getReportById);
router.delete("/:id", deleteReport);

export default router;

// En tu app/server (junto a la de documents):
// import reportRoutes from "./routes/report.routes.js";
// app.use("/api/reports", reportRoutes);
