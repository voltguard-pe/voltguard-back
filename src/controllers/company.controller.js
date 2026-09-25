import Company from "../models/Company.js";
import Board from "../models/Board.js";
import { v4 as uuidv4 } from "uuid";

// ✅ Crear empresa (SUPERADMIN)
export const createCompany = async (req, res) => {
  try {
    const { name, ruc } = req.body;

    if (!name?.trim()) {
      return res.status(400).json({ message: "El nombre es obligatorio" });
    }

    const company = await Company.create({
      name: name.trim(),
      ruc: ruc?.trim() || "",
      publicCode: uuidv4(),
    });

    return res.status(201).json(company);
  } catch (error) {
    console.log("CREATE COMPANY ERROR:", error.message);
    return res.status(500).json({ message: error.message });
  }
};

// ✅ Listar empresas (SUPERADMIN)
export const getCompanies = async (req, res) => {
  try {
    // Si es ADMIN, solo devolver su propia empresa
    if (req.user.role === "ADMIN" || req.user.role === "USER") {
      const company = await Company.find({ publicCode: req.user.companyPublicCode });
      return res.status(200).json(company);
    }

    const companies = await Company.find().sort({ createdAt: -1 });
    return res.json(companies);
  } catch (error) {
    console.log("GET COMPANIES ERROR:", error.message);
    return res.status(500).json({ message: error.message });
  }
};

// ✅ Obtener empresa por publicCode
export const getCompanyByCode = async (req, res) => {
  try {
    const company = await Company.findOne({ publicCode: req.params.publicCode });

    if (!company) {
      return res.status(404).json({ message: "Empresa no encontrada" });
    }

    return res.json(company);
  } catch (error) {
    console.log("GET COMPANY BY CODE ERROR:", error.message);
    return res.status(500).json({ message: error.message });
  }
};

// ✅ Actualizar empresa por publicCode (SUPERADMIN)
export const updateCompany = async (req, res) => {
  try {
    const { name, ruc } = req.body;

    const company = await Company.findOne({ publicCode: req.params.publicCode });

    if (!company) {
      return res.status(404).json({ message: "Empresa no encontrada" });
    }

    if (name !== undefined) company.name = name.trim();
    if (ruc !== undefined) company.ruc = ruc.trim();

    await company.save();

    return res.json({
      message: "Empresa actualizada correctamente",
      company,
    });
  } catch (error) {
    console.log("UPDATE COMPANY ERROR:", error.message);
    return res.status(500).json({ message: error.message });
  }
};

// ✅ Eliminar empresa por publicCode (SUPERADMIN)
export const deleteCompany = async (req, res) => {
  try {
    const company = await Company.findOneAndDelete({
      publicCode: req.params.publicCode,
    });

    if (!company) {
      return res.status(404).json({ message: "Empresa no encontrada" });
    }

    return res.json({ message: "Empresa eliminada correctamente" });
  } catch (error) {
    console.log("DELETE COMPANY ERROR:", error.message);
    return res.status(500).json({ message: error.message });
  }
};

// ✅ Listar empresas públicas (USER)
export const publicGetCompanies = async (req, res) => {
  try {
    const companies = await Company.find()
      .select("name publicCode")
      .sort({ name: 1 });

    return res.json(companies);
  } catch (error) {
    console.log("PUBLIC GET COMPANIES ERROR:", error.message);
    return res.status(500).json({ message: error.message });
  }
};

// ✅ Obtener boards por publicCode de empresa
export const getBoardsByCompanyCode = async (req, res) => {
  try {
    const company = await Company.findOne({
      publicCode: req.params.code,
    });

    if (!company) {
      return res.status(404).json({ message: "Empresa no encontrada" });
    }

    const boards = await Board.find({ company: company._id });

    return res.json({
      company: {
        name: company.name,
        publicCode: company.publicCode,
      },
      boards,
    });
  } catch (error) {
    console.log("GET BOARDS BY COMPANY CODE ERROR:", error.message);
    return res.status(500).json({ message: error.message });
  }
};