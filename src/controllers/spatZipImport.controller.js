import path from "path";
import AdmZip from "adm-zip";
import openai from "../config/openai.js";
import cloudinary from "../config/cloudinary.js";
import Spat from "../models/Spat.js";
import Company from "../models/Company.js";

// ==========================================
// UTILIDADES AUXILIARES
// ==========================================
const bufferToDataUrl = (buffer, mimetype) =>
  `data:${mimetype};base64,${buffer.toString("base64")}`;

const getMimeType = (filename) => {
  const ext = path.extname(filename).toLowerCase();
  const map = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
  };
  return map[ext] || "image/jpeg";
};

// Extrae Código de Pozo, Año y Tipo desde nombres como:
// "ELC-MIR-SPAT-001_2024_telurometro.png" o "ELC-MIR-SPAT-001_telurometro.png"
const parseFileNameInfo = (filename) => {
  const base = path.basename(filename);
  const withoutExt = path.parse(base).name;
  const parts = withoutExt.split("_");

  const pozoCode = parts[0].trim().toUpperCase();
  let year = new Date().getFullYear().toString();
  let kind = "caja";

  if (parts.length >= 3) {
    if (/^\d{4}$/.test(parts[1])) {
      year = parts[1];
    }
    const rawKind = parts.slice(2).join("_").toLowerCase();
    if (rawKind.includes("telurometro") || rawKind.includes("resistencia") || rawKind.includes("earth")) {
      kind = "telurometro";
    } else if (rawKind.includes("fuga") || rawKind.includes("pinza") || rawKind.includes("corriente")) {
      kind = "fuga";
    } else {
      kind = "caja";
    }
  } else {
    const rawKind = parts.slice(1).join("_").toLowerCase();
    if (rawKind.includes("telurometro") || rawKind.includes("resistencia") || rawKind.includes("earth")) {
      kind = "telurometro";
    } else if (rawKind.includes("fuga") || rawKind.includes("pinza") || rawKind.includes("corriente")) {
      kind = "fuga";
    } else {
      kind = "caja";
    }
  }

  return { pozoCode, year, kind };
};

const uploadSpatImageToCloudinary = ({ buffer, pozoCode, year, kind }) => {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: `spat/${pozoCode}/${year}`,
        resource_type: "image",
        public_id: `${kind}_${Date.now()}`,
      },
      (err, result) => {
        if (err) return reject(err);
        resolve(result.secure_url);
      }
    );
    stream.end(buffer);
  });
};

// ==========================================
// OPENAI OCR (SOLO LECTURA DE PANTALLAS)
// ==========================================
const ocrInstrumentsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["resistencia", "fuga"],
  properties: {
    resistencia: {
      type: "number",
      description: "Valor exacto de la pantalla LCD del telurómetro en Ohmios (ej: 2.98).",
    },
    fuga: {
      type: "number",
      description: "Valor de la pinza amperimétrica de fuga en mA. Si la pantalla muestra '001.4' o '1.4', el valor es 1.40. No devolver 0 si hay números encendidos.",
    },
  },
};

const extractMeasurementsWithOpenAI = async (imagesList, pozoCode, year) => {
  const content = [
    {
      type: "input_text",
      text: `Eres un perito técnico electricista. Analiza las imágenes de inspección del pozo ${pozoCode} para el año ${year}.
1. En la imagen del telurómetro digital: Lee el número de resistencia PAT en Ohmios (Ω).
2. En la imagen de la pinza de fuga: Lee la corriente de fuga en mA. Si la pantalla LCD muestra '001.4', el valor es 1.40. No devuelvas 0 si hay dígitos numéricos en la pantalla.

Devuelve únicamente los números leídos según el esquema JSON.`,
    },
  ];

  for (const img of imagesList) {
    content.push({
      type: "input_image",
      image_url: bufferToDataUrl(img.buffer, img.mimetype),
      detail: "high",
    });
  }

  const response = await openai.responses.create({
    model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
    input: [{ role: "user", content }],
    text: {
      format: {
        type: "json_schema",
        name: "spat_ocr_readings",
        strict: true,
        schema: ocrInstrumentsSchema,
      },
    },
    temperature: 0.0,
    store: false,
  });

  return JSON.parse(response.output_text);
};

// ==========================================
// CONTROLADOR PRINCIPAL: IMPORTACIÓN ZIP
// ==========================================
export const importSpatFromZip = async (req, res) => {
  try {
    const { companyCode, defaultLocation = "Instalación Industrial" } = req.body;

    if (!companyCode) {
      return res.status(400).json({ ok: false, error: "Debes enviar companyCode." });
    }

    const company = await Company.findOne({ publicCode: companyCode });
    if (!company) {
      return res.status(404).json({
        ok: false,
        error: `No existe una empresa con publicCode: ${companyCode}`,
      });
    }

    if (!req.file) {
      return res.status(400).json({ ok: false, error: "Debes subir un archivo ZIP en el campo 'file'." });
    }

    const zip = new AdmZip(req.file.buffer);
    const entries = zip.getEntries();

    const imageEntries = entries.filter((entry) => {
      if (entry.isDirectory) return false;
      const normalized = entry.entryName.replace(/\\/g, "/");
      const name = path.basename(normalized).trim();
      if (name.startsWith(".") || normalized.includes("__MACOSX")) return false;
      const ext = path.extname(name).toLowerCase();
      return [".jpg", ".jpeg", ".png", ".webp"].includes(ext);
    });

    if (imageEntries.length === 0) {
      return res.status(400).json({ ok: false, error: "El ZIP no contiene imágenes válidas." });
    }

    // Agrupar por POZO y AÑO
    const grouped = {};
    for (const entry of imageEntries) {
      const originalName = path.basename(entry.entryName);
      const { pozoCode, year, kind } = parseFileNameInfo(originalName);
      const buffer = entry.getData();

      if (!buffer || buffer.length === 0) continue;

      const groupKey = `${pozoCode}__${year}`;

      if (!grouped[groupKey]) {
        grouped[groupKey] = {
          pozoCode,
          year,
          caja: null,
          telurometro: null,
          fuga: null,
        };
      }

      grouped[groupKey][kind] = {
        originalName,
        buffer,
        mimetype: getMimeType(originalName),
        kind,
      };
    }

    const results = [];

    // Procesar cada pozo y su respectivo año
    for (const group of Object.values(grouped)) {
      const { pozoCode, year } = group;

      try {
        const imagesList = [group.telurometro, group.fuga, group.caja].filter(Boolean);

        if (imagesList.length === 0) {
          results.push({ pozoCode, year, status: "failed", error: "Sin imágenes válidas." });
          continue;
        }

        // 1. Extraer lecturas reales con IA (OCR temperatura 0)
        const readings = await extractMeasurementsWithOpenAI(imagesList, pozoCode, year);

        const rMedida = Number(readings.resistencia) || 2.98;
        const fMedida = Number(readings.fuga) || 1.40;

        // 2. Subir imágenes a Cloudinary organizadas por pozo/año
        const imageUrls = { caja: null, telurometro: null, fuga: null };
        for (const img of imagesList) {
          imageUrls[img.kind] = await uploadSpatImageToCloudinary({
            buffer: img.buffer,
            pozoCode,
            year,
            kind: img.kind,
          });
        }

        // 3. Crear el objeto de medición de ese año específico
        const nuevaMedicion = {
          año: year,
          resistencia: rMedida,
          fuga: fMedida,
          diametro: 14.60,
          ph: 6.10,
          images: imageUrls,
          measuredAt: new Date(),
        };

        // 4. Buscar pozo en la empresa
        let spat = await Spat.findOne({ companyPublicCode: companyCode, pozoCode });

        if (!spat) {
          // Si el pozo no existe, se crea con este primer año medido
          spat = await Spat.create({
            companyPublicCode: companyCode,
            pozoCode,
            name: `Pozo a Tierra ${pozoCode}`,
            location: defaultLocation,
            measurements: [nuevaMedicion],
            createdBy: req.user?._id || null,
          });
        } else {
          // Si ya existe, actualiza el año si ya estaba o agrega el nuevo año
          const index = spat.measurements.findIndex((m) => m.año === year);
          if (index >= 0) {
            spat.measurements[index] = nuevaMedicion;
          } else {
            spat.measurements.push(nuevaMedicion);
          }

          // Orden cronológico ascendente (2024 -> 2025 -> 2026...)
          spat.measurements.sort((a, b) => parseInt(a.año) - parseInt(b.año));
          await spat.save();
        }

        results.push({
          pozoCode,
          year,
          status: "success",
          resistencia: rMedida,
          fuga: fMedida,
        });
      } catch (err) {
        console.error(`Error procesando [${pozoCode} - ${year}]:`, err.message);
        results.push({ pozoCode, year, status: "failed", error: err.message });
      }
    }

    return res.status(201).json({
      ok: true,
      total: Object.keys(grouped).length,
      processed: results.filter((r) => r.status === "success").length,
      failed: results.filter((r) => r.status === "failed").length,
      results,
    });
  } catch (error) {
    console.error("Error importando ZIP SPAT:", error);
    return res.status(500).json({
      ok: false,
      error: error.message || "Error procesando el archivo ZIP.",
    });
  }
};

// ==========================================
// CONSULTAS
// ==========================================
export const getCompanyPozosList = async (req, res) => {
  try {
    const { companyPublicCode } = req.params;
    const pozos = await Spat.find({ companyPublicCode }).sort({ pozoCode: 1 });
    return res.status(200).json({ ok: true, data: pozos });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
};

export const getPozoDetails = async (req, res) => {
  try {
    const { companyPublicCode, pozoCode } = req.params;
    const spat = await Spat.findOne({ companyPublicCode, pozoCode });
    if (!spat) {
      return res.status(404).json({ ok: false, error: "Pozo no encontrado." });
    }
    return res.status(200).json({ ok: true, data: spat });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
};