import express from "express";
import {
  uploadSolarPackage,
  getCompanySolarList,
  getSolarDetails,
  getSolarMatrixBuffer,
} from "../controllers/solarThermography.controller.js";
import { upload } from "../middlewares/upload.middleware.js";

const router = express.Router();

router.post(
  "/upload",
  upload.fields([
    { name: "csvFile", maxCount: 1 },
    { name: "thermalImage", maxCount: 1 },
    { name: "visualImage", maxCount: 1 },
    { name: "zipFile", maxCount: 1 }, // 👈 Añadido para soportar también el archivo ZIP masivo
  ]),
  uploadSolarPackage
);

router.get("/company/:companyCode", getCompanySolarList);
router.get("/:companyCode", getSolarDetails);
router.get("/:companyCode/:solarCode", getSolarDetails);
router.get("/:companyCode/matrix", getSolarMatrixBuffer);
router.get("/:companyCode/:solarCode/matrix", getSolarMatrixBuffer);

export default router;