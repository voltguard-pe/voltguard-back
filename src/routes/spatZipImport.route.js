import express from "express";
import {
  importSpatFromZip,
  getCompanyPozosList,
  getPozoDetails,
} from "../controllers/spatZipImport.controller.js";
import { upload } from "../middlewares/upload.middleware.js";

const router = express.Router();

// 1. Importación masiva por ZIP
router.post("/import-zip", upload.single("file"), importSpatFromZip);

// 2. Listar todos los pozos de una empresa
router.get("/:companyPublicCode/list", getCompanyPozosList);

// 3. Obtener el historial completo de un pozo específico
router.get("/:companyPublicCode/:pozoCode", getPozoDetails);

export default router;