import express from "express";
import { 
    uploadDocuments,
    getDocumentsByCompany,
    updateDocumentData,
    deleteDocument,
    getDocumentById
} from "../controllers/document.controller.js";
import { upload } from "../middlewares/upload.middleware.js"; // Tu archivo de configuración de Multer

const router = express.Router();

// Prefijo base asumido en tu app.js: /api/documents
// router.post("/", upload.single("file"), uploadDocument); 
router.post("/", upload.array("files", 5), uploadDocuments); 
router.get("/company/:companyPublicCode", getDocumentsByCompany);
router.put("/:id", updateDocumentData);
router.delete("/:id", deleteDocument);
router.get("/:id", getDocumentById);

export default router;