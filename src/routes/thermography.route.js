import express from "express";
import multer from "multer";
import {
  uploadThermographyPackage,
  getThermographyByBoard,
  getThermographyMatrix,
} from "../controllers/thermography.controller.js";

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 30 * 1024 * 1024,
    fieldSize: 30 * 1024 * 1024,
  },
});

// POST: Subida unificada de CSV + Foto JPG
router.post(
  "/:boardId/upload",
  upload.fields([
    { name: "csvFile", maxCount: 1 },
    { name: "thermalImage", maxCount: 1 },
    { name: "visualImage", maxCount: 1 },
  ]),
  uploadThermographyPackage
);

// GET: Obtener metadatos y KPIs (Punto caliente, Delta T, severidad)
router.get("/:boardId", getThermographyByBoard);

// GET: Descarga directa de la matriz binaria para el Canvas
router.get("/:boardId/matrix", getThermographyMatrix);

export default router;