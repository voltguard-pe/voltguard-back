import zlib from "zlib";
import Thermography from "../models/Thermography.js";

const calculateSeverity = (deltaT) => {
  if (deltaT >= 40) return "CRITICO";
  if (deltaT >= 20) return "INTERVENCION_PROXIMA";
  if (deltaT >= 10) return "MONITOREO";
  return "NORMAL";
};

export const uploadThermographyPackage = async (req, res) => {
  try {
    const { boardId } = req.params;
    const files = req.files || {};

    const csvFile = files["csvFile"]?.[0];
    const thermalImageFile = files["thermalImage"]?.[0];
    const visualImageFile = files["visualImage"]?.[0];

    if (!csvFile || !csvFile.buffer) {
      return res.status(400).json({ error: "El archivo CSV de la matriz es obligatorio." });
    }

    // 1. Convertir imágenes a Base64 (Data URLs)
    let thermalImageUrl = null;
    if (thermalImageFile?.buffer) {
      const mime = thermalImageFile.mimetype || "image/jpeg";
      thermalImageUrl = `data:${mime};base64,${thermalImageFile.buffer.toString("base64")}`;
    }

    let originalImageUrl = null;
    if (visualImageFile?.buffer) {
      const mime = visualImageFile.mimetype || "image/jpeg";
      originalImageUrl = `data:${mime};base64,${visualImageFile.buffer.toString("base64")}`;
    }

    // 2. Procesar CSV Radiométrico
    let csvText = csvFile.buffer.toString("utf-8");
    if (csvText.includes("\ufeff")) {
      csvText = csvText.replace("\ufeff", "");
    }

    const lines = csvText.trim().split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (!lines.length) {
      return res.status(400).json({ error: "El archivo CSV está vacío." });
    }

    const rows = lines.length;
    const delimiter = lines[0].includes(";") ? ";" : ",";
    const cols = lines[0].split(delimiter).length;

    const floatArray = new Float32Array(rows * cols);
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    let count = 0;
    let maxR = 0, maxC = 0, minR = 0, minC = 0;

    for (let r = 0; r < rows; r++) {
      const rowParts = lines[r].split(delimiter);
      for (let c = 0; c < cols; c++) {
        const val = parseFloat(rowParts[c]?.replace(",", "."));
        const idx = r * cols + c;
        floatArray[idx] = isNaN(val) ? 0 : val;

        if (!isNaN(val)) {
          if (val > max) { max = val; maxR = r; maxC = c; }
          if (val < min) { min = val; minR = r; minC = c; }
          sum += val;
          count++;
        }
      }
    }

    const avg = count > 0 ? sum / count : 0;
    const deltaT = max - min;
    const severity = calculateSeverity(deltaT);

    // 3. Comprimir matriz térmica en binario ligero
    const rawBuffer = Buffer.from(floatArray.buffer);
    const compressedData = zlib.deflateSync(rawBuffer);

    let record = await Thermography.findOne({ boardId });

    const dataToSave = {
      boardId,
      rows,
      cols,
      thermalImageUrl: thermalImageUrl || record?.thermalImageUrl || null,
      originalImageUrl: originalImageUrl || record?.originalImageUrl || null,
      stats: {
        min: Number(min.toFixed(2)),
        max: Number(max.toFixed(2)),
        avg: Number(avg.toFixed(2)),
        deltaT: Number(deltaT.toFixed(2)),
        maxPos: [maxR, maxC],
        minPos: [minR, minC],
        severity,
      },
      compressedData,
    };

    if (record) {
      record = await Thermography.findByIdAndUpdate(record._id, dataToSave, { new: true });
    } else {
      record = await Thermography.create(dataToSave);
    }

    return res.status(200).json({
      success: true,
      message: "Inspección guardada correctamente.",
      data: {
        id: record._id,
        rows: record.rows,
        cols: record.cols,
        stats: record.stats,
        thermalImageUrl: record.thermalImageUrl,
        originalImageUrl: record.originalImageUrl,
      },
    });
  } catch (error) {
    console.error("Error al procesar termografía:", error);
    return res.status(500).json({ error: error.message });
  }
};

// ── OBTENER METADATOS Y STATS DE TERMOGRAFÍA ──
export const getThermographyByBoard = async (req, res) => {
    try {
        const { boardId } = req.params;

        const record = await Thermography.findOne({ boardId }).select("-compressedData").lean();

        if (!record) {
            return res.status(200).json({ success: true, data: null });
        }

        return res.status(200).json({
            success: true,
            data: record,
        });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
};

// ── DESCARGAR LA MATRIZ FLOTANTE DIRECTA AL CANVAS (RÁPIDA Y DESCOMPRIMIDA) ──
export const getThermographyMatrix = async (req, res) => {
    try {
        const { boardId } = req.params;
        const record = await Thermography.findOne({ boardId });

        if (!record || !record.compressedData) {
            return res.status(404).json({ error: "No hay matriz térmica para este tablero." });
        }

        // Descomprimir el Buffer crudo
        const decompressed = zlib.inflateSync(record.compressedData);

        // Exponer encabezados para que el frontend pueda leer X-Rows y X-Cols
        res.setHeader("Access-Control-Expose-Headers", "X-Rows, X-Cols, X-Max-Temp, X-Min-Temp");
        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader("X-Rows", record.rows.toString());
        res.setHeader("X-Cols", record.cols.toString());
        res.setHeader("X-Max-Temp", record.stats.max.toString());
        res.setHeader("X-Min-Temp", record.stats.min.toString());
        return res.send(decompressed);
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
};