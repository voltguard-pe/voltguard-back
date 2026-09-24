import express from "express";
import { extractElectricityRates } from "../controllers/bill.controller.js";
import { upload } from "../middlewares/upload.middleware.js";

const router = express.Router();

// Endpoint: POST /api/v1/bill/:boardId/extract-rates
router.post("/:boardId/extract-rates", upload.single("receiptFile"), extractElectricityRates);

export default router;