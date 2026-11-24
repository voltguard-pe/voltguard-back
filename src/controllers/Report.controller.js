import { v2 as cloudinary } from "cloudinary";
import ReportModel from "../models/Report.model.js";
// ⚠️ Ajusta la ruta/nombre a tu modelo de empresa (debe tener el campo publicCode)
import Company from "../models/Company.js";

// Sube el PDF (en memoria) a Cloudinary. Asume que cloudinary.config() ya se hace en otro archivo.
const uploadToCloudinary = (buffer, folder) =>
  new Promise((resolve, reject) => {
    cloudinary.uploader
      .upload_stream({ folder, resource_type: "auto" }, (err, result) =>
        err || !result ? reject(err) : resolve(result)
      )
      .end(buffer);
  });

// POST /reports   (multipart: file, title, companyPublicCode)
export const uploadReport = async (req, res) => {
  try {
    const { title, companyPublicCode } = req.body;

    if (!req.file) return res.status(400).json({ error: "Falta el archivo PDF" });
    if (!title?.trim()) return res.status(400).json({ error: "Falta el título" });
    if (!companyPublicCode) return res.status(400).json({ error: "Falta la empresa" });

    const company = await Company.findOne({ publicCode: companyPublicCode });
    if (!company) return res.status(404).json({ error: "Empresa no encontrada" });

    const uploaded = await uploadToCloudinary(req.file.buffer, `voltguard/informes/${companyPublicCode}`);

    const report = await ReportModel.create({
      title: title.trim(),
      cloudinaryUrl: uploaded.secure_url,
      cloudinaryPublicId: uploaded.public_id,
      cloudinaryResourceType: uploaded.resource_type,
      company: company._id,
      companyPublicCode,
    });

    return res.status(201).json(report);
  } catch (err) {
    console.error("Error subiendo informe:", err);
    return res.status(500).json({ error: err.message || "Error subiendo informe" });
  }
};

// GET /reports/company/:publicCode
export const getReportsByCompany = async (req, res) => {
  try {
    const reports = await ReportModel.find({ companyPublicCode: req.params.publicCode }).sort({
      createdAt: -1,
    });
    return res.json(reports);
  } catch (err) {
    console.error("Error listando informes:", err);
    return res.status(500).json({ error: err.message || "Error listando informes" });
  }
};

// GET /reports/:id
export const getReportById = async (req, res) => {
  try {
    const report = await ReportModel.findById(req.params.id);
    if (!report) return res.status(404).json({ error: "Informe no encontrado" });
    return res.json(report);
  } catch {
    return res.status(400).json({ error: "Id inválido" });
  }
};

// DELETE /reports/:id
export const deleteReport = async (req, res) => {
  try {
    const report = await ReportModel.findById(req.params.id);
    if (!report) return res.status(404).json({ error: "Informe no encontrado" });

    // Borra el archivo en Cloudinary; si falla, igual se elimina el registro
    try {
      await cloudinary.uploader.destroy(report.cloudinaryPublicId, {
        resource_type: report.cloudinaryResourceType || "image",
      });
    } catch (e) {
      console.warn("No se pudo borrar en Cloudinary:", e);
    }

    await report.deleteOne();
    return res.json({ message: "Informe eliminado" });
  } catch (err) {
    console.error("Error eliminando informe:", err);
    return res.status(500).json({ error: err.message || "Error eliminando informe" });
  }
};
