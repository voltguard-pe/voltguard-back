import AdmZip from "adm-zip";
import XLSX from "xlsx";
import fs from "fs";
import path from "path";
import Board from "../models/Board.js";
import cloudinary from "../config/cloudinary.js";
import { v4 as uuidv4 } from "uuid";

const extractPath = "./uploads/extracted";

// =========================
// 🧠 HELPERS LIMPIOS
// =========================
const parseNumber = (value) => {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return isNaN(n) ? null : n;
};

const parseString = (value) => {
  if (value === undefined || value === null || value === "") return null;
  return String(value).trim();
};

const parseBoolean = (value) => {
  if (value === true || value === "TRUE" || value === "true") return true;
  if (value === false || value === "FALSE" || value === "false") return false;
  return null;
};

const parseCircuitType = (value) => {
  if (value === undefined || value === null || value === "") return null;

  const text = String(value)
    .trim()
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  if (
    text === "MONOFÁSICO" ||
    text === "1F" ||
    text === "BIFÁSICO"
  ) {
    return "MONOFÁSICO";
  }

  if (
    text === "TRIFÁSICO" ||
    text === "3F"
  ) {
    return "TRIFÁSICO";
  }

  return null;
};

// 🧹 limpiar nulls
const cleanObject = (obj) => {
  return Object.fromEntries(
    Object.entries(obj)
      .filter(([_, v]) => v !== null && v !== undefined)
      .map(([k, v]) => [
        k,
        typeof v === "object" && !Array.isArray(v)
          ? cleanObject(v)
          : v,
      ])
  );
};

// =========================
// 🧹 CLEANUP FILES
// =========================
const cleanupFiles = (filePath) => {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    if (fs.existsSync(extractPath)) {
      fs.rmSync(extractPath, { recursive: true, force: true });
    }
  } catch (err) {
    console.error("Error limpiando archivos:", err);
  }
};

// =========================
// 🔍 BUSCAR EXCEL
// =========================
const findExcelFile = (dir) => {
  const files = fs.readdirSync(dir);

  for (const file of files) {
    const fullPath = path.join(dir, file);

    if (fs.statSync(fullPath).isDirectory()) {
      const found = findExcelFile(fullPath);
      if (found) return found;
    } else if (file.endsWith(".xlsx")) {
      return fullPath;
    }
  }

  return null;
};

// =========================
// ✅ VALIDACIÓN
// =========================
export const validateImport = async (req, res) => {
  try {
    if (!req.file.originalname.endsWith(".zip")) {
      return res.status(400).json({ error: "Solo .zip permitido" });
    }

    const zip = new AdmZip(req.file.path);

    if (!fs.existsSync(extractPath)) {
      fs.mkdirSync(extractPath, { recursive: true });
    }

    zip.extractAllTo(extractPath, true);

    const excelPath = findExcelFile(extractPath);

    if (!excelPath) {
      return res.json({ ok: false, errors: ["No hay Excel"] });
    }

    const workbook = XLSX.readFile(excelPath);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(sheet);

    const errors = [];

    for (const row of data) {
      const boardCode = row.tablero_id;

      if (!boardCode) {
        errors.push("Fila sin tablero_id");
        continue;
      }

      const imgDir = path.join(extractPath, "imagenes");

      const imgs = fs.existsSync(imgDir)
        ? fs.readdirSync(imgDir).filter((f) => f.includes(boardCode))
        : [];

      const hasUnifilar = imgs.some((f) =>
        f.toLowerCase().includes("unifilar")
      );

      if (!hasUnifilar) {
        errors.push(`Falta unifilar ${boardCode}`);
      }

      if (imgs.length === 0) {
        errors.push(`Faltan imágenes ${boardCode}`);
      }
    }

    res.json({
      ok: errors.length === 0,
      errors,
      total: data.length,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error validando" });
  } finally {
    cleanupFiles(req.file?.path);
  }
};

// =========================
// 🚀 IMPORT COMPLETO
// =========================
export const runImport = async (req, res) => {
  try {
    const zip = new AdmZip(req.file.path);
    zip.extractAllTo(extractPath, true);

    const excelPath = findExcelFile(extractPath);
    if (!excelPath) {
      return res.status(400).json({ error: "No se encontró Excel" });
    }

    const workbook = XLSX.readFile(excelPath);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(sheet);

    const companyPublicCode =
      req.body.company_code || data[0]?.company_code || "DEFAULT";

    const boardsMap = {};

    // =========================
    // 🧠 AGRUPAR TABLEROS
    // =========================
    for (const row of data) {
      const id = row.tablero_id;
      if (!id) continue;

      if (!boardsMap[id]) {
        boardsMap[id] = {
          code: uuidv4(),
          boardCode: id,

          name: parseString(row.tablero_nombre),
          type: parseString(row.tipo_tablero),

          tensionNominal: parseNumber(row.tension_nominal),
          numeroFases: parseNumber(row.numero_fases),
          incluyeNeutro: parseBoolean(row.incluye_neutro),

          sistema: parseString(row.sistema),
          location: parseString(row.ubicacion),
          description: parseString(row.descripcion),
          estadoGeneral: parseString(row.estado_general),

          circuits: [],

          images: {
            tablero: [],
            unifilar: [],
            termografia: [],
          },

          // mainBreaker: {
          //   amperaje: parseNumber(row.interruptor_amperaje),
          //   polos: parseNumber(row.interruptor_polos),
          //   marca: parseString(row.interruptor_marca),
          //   modelo: parseString(row.interruptor_modelo),
          // },

          // proteccion: {
          //   sobretension: parseBoolean(row.proteccion_sobretension),
          //   marca: parseString(row.proteccion_marca),
          //   modelo: parseString(row.proteccion_modelo),
          // },
        };
      }

      // =========================
      // ⚡ CIRCUITOS
      // =========================
      boardsMap[id].circuits.push({
        circuito: parseString(row.circuito),
        descripcion: parseString(row.circuito_descripcion),
        tipo: parseCircuitType(row.circuito_tipo),
      });
    }

    // =========================
    // 🖼 IMÁGENES
    // =========================
    const imgDir = path.join(extractPath, "imagenes");

    if (fs.existsSync(imgDir)) {
      const files = fs.readdirSync(imgDir);

      for (const file of files) {
        const fullPath = path.join(imgDir, file);

        if (!fs.statSync(fullPath).isFile()) continue;

        const boardCode = file.split("_")[0];
        const board = boardsMap[boardCode];
        if (!board) continue;

        const upload = await cloudinary.uploader.upload(fullPath, {
          folder: `boards/${boardCode}`,
        });

        const name = file.toLowerCase();

        if (name.includes("unifilar")) {
          board.images.unifilar.push(upload.secure_url);
        } else if (
          name.includes("termica") ||
          name.includes("termografia")
        ) {
          board.images.termografia.push(upload.secure_url);
        } else {
          board.images.tablero.push(upload.secure_url);
        }
      }
    }

    // =========================
    // 💾 GUARDAR
    // =========================
    for (const board of Object.values(boardsMap)) {
      await Board.findOneAndUpdate(
        {
          boardCode: board.boardCode,
          companyPublicCode,
        },
        {
          ...cleanObject(board),
          companyPublicCode,
          createdBy: req.user._id,
        },
        {
          upsert: true,
          new: true,
        }
      );
    }

    return res.json({
      message: "Importación completada correctamente",
      total: Object.keys(boardsMap).length,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      error: "Error importando archivo",
      details: err.message,
    });
  } finally {
    cleanupFiles(req.file?.path);
  }
};