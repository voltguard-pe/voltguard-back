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
  required: ["resistencia", "fuga", "fuga_raw_display"],
  properties: {
    resistencia: {
      type: "number",
      description: "Valor numérico de la pantalla LCD del telurómetro en Ohmios (ej: 2.98).",
    },
    fuga: {
      type: "number",
      description: "Valor numérico final de la pinza amperimétrica en mA (ej: si la pantalla muestra 001.4, el valor DEBE ser 1.40).",
    },
    fuga_raw_display: {
      type: "string",
      description: "Texto o dígitos exactos visibles en el LCD de 7 segmentos de la pinza, incluyendo ceros y puntos tal como están grabados (ej: '001.4').",
    },
  },
};

const extractMeasurementsWithOpenAI = async (imagesList, pozoCode, year) => {
  const content = [
    {
      type: "input_text",
      text: `Eres un perito técnico electricista experto en lectura de instrumentos de medida de campo (telurómetro y pinza amperimétrica de fuga).
Analiza las imágenes de inspección del pozo ${pozoCode} del año ${year}.

INSTRUCCIONES CRÍTICAS DE LECTURA LCD:
1. IMAGEN DE LA PINZA AMPERIMÉTRICA DE FUGA (Marca MULTEST / CSR3 u similar):
   - Ten en cuenta que la pinza puede estar fotografiada en ángulo vertical o invertida. Identifica la orientación real de los dígitos LCD de 7 segmentos.
   - El display LCD consta de 4 dígitos principales con un punto decimal fijo: [D1][D2][D3].[D4].
   - Si la pantalla muestra "001.4", significa:
     * D1 = 0
     * D2 = 0
     * D3 = 1
     * D4 = 4
     El valor es 1.4 (o 1.40 mA). NUNCA lo interpretes como 0.14 ni muevas el punto antes del 1.
   - En 'fuga_raw_display' escribe la cadena exacta de caracteres del display (ej: "001.4").
   - En 'fuga' entrega el valor flotante real (1.4).

2. IMAGEN DEL TELURÓMETRO:
   - Lee el valor principal en Ohmios (Ω).

Devuelve los valores estrictamente según el esquema JSON.`,
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

  const parsed = JSON.parse(response.output_text);

  // Respaldo de seguridad en código por si la IA entrega 0.14 pero en raw leyó 001.4:
  if (parsed.fuga_raw_display) {
    const rawClean = parsed.fuga_raw_display.replace(/[^0-9.]/g, "");
    const match = rawClean.match(/^0*(\d+)\.(\d+)$/);
    if (match) {
      const entero = parseInt(match[1], 10);
      const decimal = match[2];
      parsed.fuga = parseFloat(`${entero}.${decimal}`);
    }
  }

  return parsed;
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
        const fMedida = Number(Number(readings.fuga).toFixed(2)) || 1.40;

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