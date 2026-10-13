import express from "express";
import { extractElectricityRates, updateAhorroMeta } from "../controllers/bill.controller.js";
import { upload } from "../middlewares/upload.middleware.js";

const router = express.Router();

// Endpoint: POST /api/v1/bill/:boardId/extract-rates
router.post("/:boardId/extract-rates", upload.single("receiptFile"), extractElectricityRates);

// Endpoint: PATCH o POST /api/v1/bill/:boardId/ahorro-meta
// Se aceptan ambos métodos para que no falle si el frontend usa uno distinto.
router
  .route("/:boardId/ahorro-meta")
  .patch(updateAhorroMeta)
  .post(updateAhorroMeta);

export default router;