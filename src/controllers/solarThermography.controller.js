import zlib from "zlib";
import cloudinary from "../config/cloudinary.js";
import SolarThermography from "../models/SolarThermography.js";

// ── Subida de imágenes a Cloudinary (igual que en SPAT)
const uploadToCloudinary = (buffer, folder, publicId) => {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: `solar/${folder}`, resource_type: "image", public_id: publicId },
      (err, result) => {
        if (err) return reject(err);
        resolve(result.secure_url);
      }
    );
    stream.end(buffer);
  });
};

export const uploadSolarPackage = async (req, res) => {
  try {
    const { companyCode, title, solarCode } = req.body;
    const files = req.files || {};

    const csvFile = files["csvFile"]?.[0];
    const thermalImageFile = files["thermalImage"]?.[0];
    const visualImageFile = files["visualImage"]?.[0];

    if (!companyCode) {
      return res.status(400).json({ ok: false, success: false, error: "Debes enviar companyCode." });
    }
    if (!csvFile || !csvFile.buffer) {
      return res.status(400).json({ ok: false, success: false, error: "El archivo CSV de temperaturas es obligatorio." });
    }

    // 1. Asignar código de subarreglo (autoincrementable si viene vacío)
    let finalSolarCode = solarCode ? solarCode.trim().toUpperCase() : null;
    if (!finalSolarCode) {
      const count = await SolarThermography.countDocuments({ companyPublicCode: companyCode });
      finalSolarCode = `SOLAR-${String(count + 1).padStart(3, "0")}`;
    }

    const finalTitle = title?.trim() || `Auditoría ${finalSolarCode}`;

    // Buscar si ya existe para no borrar fotos previas si no se reenvían
    const existingRecord = await SolarThermography.findOne({
      companyPublicCode: companyCode,
      solarCode: finalSolarCode,
    });

    // 2. Subir imágenes a Cloudinary
    let thermalImageUrl = existingRecord?.thermalImageUrl || null;
    let visualImageUrl = existingRecord?.visualImageUrl || null;

    if (thermalImageFile?.buffer) {
      thermalImageUrl = await uploadToCloudinary(
        thermalImageFile.buffer,
        companyCode,
        `thermal_${finalSolarCode}_${Date.now()}`
      );
    }
    if (visualImageFile?.buffer) {
      visualImageUrl = await uploadToCloudinary(
        visualImageFile.buffer,
        companyCode,
        `visual_${finalSolarCode}_${Date.now()}`
      );
    }

    // 3. Procesar archivo CSV
    let csvText = csvFile.buffer.toString("utf-8").replace(/^\ufeff/, "");
    const lines = csvText.trim().split(/\r?\n/).filter((l) => l.trim().length > 0);
    
    if (lines.length < 5) {
      return res.status(400).json({ ok: false, success: false, error: "El archivo CSV no contiene suficientes datos térmicos." });
    }

    const rows = lines.length;
    const delimiter = lines[0].includes(";") ? ";" : ",";
    const cols = lines[0].split(delimiter).length;

    const floatArray = new Float32Array(rows * cols);
    let min = Infinity, max = -Infinity, sum = 0, count = 0;

    for (let r = 0; r < rows; r++) {
      const parts = lines[r].split(delimiter);
      for (let c = 0; c < cols; c++) {
        const val = parseFloat(parts[c]?.replace(",", "."));
        const idx = r * cols + c;
        floatArray[idx] = isNaN(val) ? 0 : val;
        if (!isNaN(val)) {
          if (val > max) max = val;
          if (val < min) min = val;
          sum += val;
          count++;
        }
      }
    }

    const avg = count > 0 ? sum / count : 0;
    const deltaTMax = max - avg;

    // 4. Extraer celdas calientes según IEC 62446-3 (Máximos locales con ΔT >= 10°C)
    const hotspots = [];
    const visited = new Uint8Array(rows * cols);
    let hsIdx = 1;

    for (let r = 2; r < rows - 2; r++) {
      for (let c = 2; c < cols - 2; c++) {
        const val = floatArray[r * cols + c];
        const deltaT = val - avg;

        if (deltaT >= 10.0 && !visited[r * cols + c]) {
          let isMax = true;
          for (let dr = -2; dr <= 2; dr++) {
            for (let dc = -2; dc <= 2; dc++) {
              if (dr === 0 && dc === 0) continue;
              if (floatArray[(r + dr) * cols + (c + dc)] > val) {
                isMax = false;
                break;
              }
            }
            if (!isMax) break;
          }

          if (isMax) {
            // Marcar radio de influencia como visitado para evitar hotspots duplicados sobre la misma celda
            for (let dr = -5; dr <= 5; dr++) {
              for (let dc = -5; dc <= 5; dc++) {
                const nr = r + dr, nc = c + dc;
                if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) {
                  visited[nr * cols + nc] = 1;
                }
              }
            }

            const isCritical = deltaT >= 15.0;
            hotspots.push({
              id: `HS-${String(hsIdx).padStart(2, "0")}`,
              panelId: `P-${r < rows / 2 ? "A1" : "A2"}-${String(Math.floor((c / cols) * 10) + 1).padStart(2, "0")}`,
              cellLocation: `Fila ${Math.floor((r / rows) * 6) + 1}, Celda ${Math.floor((c / cols) * 10) + 1}`,
              x: Number(((c / cols) * 100).toFixed(1)),
              y: Number(((r / rows) * 100).toFixed(1)),
              tSpot: Number(val.toFixed(1)),
              tNormal: Number(avg.toFixed(1)),
              deltaT: Number(deltaT.toFixed(1)),
              status: isCritical ? "CRITICAL" : "WARNING",
              visualCause: isCritical 
                ? "Sobrecalentamiento severo en celda fotovoltaica (polarización inversa)" 
                : "Depósito de polución concentrada en superficie",
              action: isCritical ? "CAMBIO INTEGRAL DEL PANEL" : "PRE-CAMBIO / LIMPIEZA",
            });
            hsIdx++;
          }
        }
      }
    }

    hotspots.sort((a, b) => b.tSpot - a.tSpot);

    // 5. Comprimir matriz térmica en zlib
    const compressedData = zlib.deflateSync(Buffer.from(floatArray.buffer));

    const criticalCount = hotspots.filter((h) => h.status === "CRITICAL").length;
    const warningCount = hotspots.filter((h) => h.status === "WARNING").length;
    const panelsToReplace = new Set(hotspots.filter((h) => h.status === "CRITICAL").map((h) => h.panelId)).size;

    const technicalDiagnosis = criticalCount > 0
      ? `Se detectaron ${criticalCount} celdas en condición crítica irreversible (ΔT ≥ 15 °C).\nReemplazo obligatorio de ${panelsToReplace} panel(es) completo(s) con especificación Trina Solar 455 Wp o equivalente.`
      : `Arreglo fotovoltaico en condición admisible con ${warningCount} celda(s) bajo observación.\nProceder con lavado técnico programado y reevaluación térmica.`;

    const solarData = {
      companyPublicCode: companyCode,
      solarCode: finalSolarCode,
      title: finalTitle,
      rows,
      cols,
      thermalImageUrl,
      visualImageUrl,
      technicalDiagnosis,
      stats: {
        min: Number(min.toFixed(1)),
        max: Number(max.toFixed(1)),
        avg: Number(avg.toFixed(1)),
        deltaTMax: Number(deltaTMax.toFixed(1)),
        criticalHotspotsCount: criticalCount,
        warningHotspotsCount: warningCount,
        panelsToReplaceCount: panelsToReplace,
      },
      hotspots,
      compressedData,
      createdBy: req.user?._id || null,
    };

    let record = await SolarThermography.findOneAndUpdate(
      { companyPublicCode: companyCode, solarCode: finalSolarCode },
      solarData,
      { new: true, upsert: true }
    );

    return res.status(201).json({
      ok: true,
      success: true,
      data: {
        id: record._id,
        solarCode: record.solarCode,
        title: record.title,
      },
    });
  } catch (error) {
    console.error("Error importando inspección solar:", error);
    return res.status(500).json({ ok: false, success: false, error: error.message || "Error procesando inspección solar." });
  }
};

// ── Lista de subarreglos para el Sidebar y Selector
export const getCompanySolarList = async (req, res) => {
  try {
    const { companyCode } = req.params;
    const records = await SolarThermography.find({ companyPublicCode: companyCode })
      .select("solarCode title")
      .sort({ solarCode: 1 });

    return res.status(200).json({ ok: true, success: true, data: records });
  } catch (error) {
    return res.status(500).json({ ok: false, success: false, error: error.message });
  }
};

// ── Detalle completo
export const getSolarDetails = async (req, res) => {
  try {
    const { companyCode, solarCode } = req.params;
    const query = { companyPublicCode: companyCode };
    if (solarCode) query.solarCode = solarCode;

    // Si no envían solarCode, trae el más reciente de esa empresa
    const record = await SolarThermography.findOne(query)
      .sort({ createdAt: -1 })
      .select("-compressedData")
      .lean();

    if (!record) {
      return res.status(200).json({ ok: true, success: true, data: null });
    }

    return res.status(200).json({ ok: true, success: true, data: record });
  } catch (error) {
    return res.status(500).json({ ok: false, success: false, error: error.message });
  }
};

// ── Matriz binaria para hover sobre el canvas
export const getSolarMatrixBuffer = async (req, res) => {
  try {
    const { companyCode, solarCode } = req.params;
    const query = { companyPublicCode: companyCode };
    if (solarCode) query.solarCode = solarCode;

    const record = await SolarThermography.findOne(query).sort({ createdAt: -1 });
    if (!record?.compressedData) {
      return res.status(404).json({ ok: false, success: false, error: "Sin datos binarios disponibles." });
    }

    const decompressed = zlib.inflateSync(record.compressedData);
    
    res.setHeader("Access-Control-Expose-Headers", "X-Rows, X-Cols, X-Max-Temp, X-Min-Temp, X-Avg-Temp");
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("X-Rows", record.rows.toString());
    res.setHeader("X-Cols", record.cols.toString());
    res.setHeader("X-Max-Temp", record.stats.max.toString());
    res.setHeader("X-Min-Temp", record.stats.min.toString());
    res.setHeader("X-Avg-Temp", record.stats.avg.toString());

    return res.send(decompressed);
  } catch (error) {
    return res.status(500).json({ ok: false, success: false, error: error.message });
  }
};