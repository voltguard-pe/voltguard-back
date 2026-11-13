import fs from "node:fs/promises";
import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.OPENAI_MODEL || "gpt-4.1";

// Nombres canónicos que espera el frontend para cruzar base vs actual
export const COST_NAMES = [
  "Energía fuera de punta",
  "Potencia distribución",
  "Potencia generación",
  "IGV",
  "Energía hora punta",
  "Alumbrado público",
  "Electrificación rural",
  "Reactiva capacitiva",
  "Cargos fijos",
  "Otros",
];

const nullableNum = { type: ["number", "null"] };

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "distributor",
    "supplyNumber",
    "periodMonth",
    "contractedKw",
    "kwhFp",
    "kwhHp",
    "totalKwh",
    "maxKw",
    "totalBill",
    "costItems",
    "historyRows",
  ],
  properties: {
    distributor: { type: ["string", "null"] },
    supplyNumber: { type: ["string", "null"] },
    periodMonth: {
      type: "string",
      description: "Mes de consumo facturado en formato YYYY-MM",
    },
    contractedKw: nullableNum,
    kwhFp: {
      type: ["number", "null"],
      description:
        "Consumo de Energía Fuera Punta del mes actual con sus decimales exactos (el consumo mayor)",
    },
    kwhHp: {
      type: ["number", "null"],
      description:
        "Consumo de Energía Hora Punta del mes actual con sus decimales exactos (el consumo menor)",
    },
    totalKwh: {
      type: ["number", "null"],
      description:
        "Consumo total del mes en kWh con decimales (leído de la columna Consumo en 'Electrificación Rural Ley N° 28749')",
    },
    maxKw: {
      type: ["number", "null"],
      description:
        "Potencia Registrada máxima del mes en kW (coincide con Consumo de 'Potencia Generación Fuera de Punta')",
    },
    totalBill: nullableNum,
    costItems: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "value"],
        properties: {
          name: { type: "string", enum: COST_NAMES },
          value: { type: "number" },
        },
      },
    },
    historyRows: {
      type: "object",
      additionalProperties: false,
      description:
        "Lectura horizontal de izquierda a derecha de las 3 filas de la tabla 'Historia de Consumos y Demandas' usando las páginas con ZOOM (exactamente 12 números por fila)",
      required: ["kwhFpRow", "kwhHpRow", "maxKwRow"],
      properties: {
        kwhFpRow: {
          type: "array",
          description: "Los 12 números enteros de izquierda a derecha de la fila 'kW.h-FP'",
          items: { type: "number" },
        },
        kwhHpRow: {
          type: "array",
          description: "Los 12 números enteros de izquierda a derecha de la fila 'kW.h-HP'",
          items: { type: "number" },
        },
        maxKwRow: {
          type: "array",
          description: "Los 12 números con 2 decimales de izquierda a derecha de la fila 'Max-kW'",
          items: { type: "number" },
        },
      },
    },
  },
};

const PROMPT = `Eres un extractor experto de datos de recibos de luz peruanos (Luz del Sur, Enel / Pluz Energía).
El PDF adjunto incluye la vista completa en la Página 1 y acercamientos de ALTA RESOLUCIÓN (ZOOM) en las Páginas 2, 3, 4 y 5 para que leas cada dígito con nitidez perfecta. Devuelve SOLO el JSON del esquema.

REGLAS CRÍTICAS:
1. periodMonth: Mes de CONSUMO facturado (no fecha de vencimiento), en formato YYYY-MM, obtenido de la fecha de "Lectura Actual" o "FECHA EMISIÓN".
2. kwhFp, kwhHp y totalKwh del mes actual (USA LA PÁGINA 2 CON ZOOM Y CONSERVA LOS DECIMALES EXACTOS):
   - En la tabla de importes, "Consumo de Energía Hora Punta" aparece ARRIBA y "Consumo de Energía Fuera Punta" aparece ABAJO. ¡NUNCA los inviertas!
   - "kwhFp": Valor exacto con decimales de la columna Consumo en "Consumo de Energía Fuera Punta" (el consumo mayor, ~85% del total).
   - "kwhHp": Valor exacto con decimales de la columna Consumo en "Consumo de Energía Hora Punta" (el consumo menor, ~15% del total).
   - "totalKwh": Valor exacto con decimales de la columna Consumo en "Electrificación Rural (Ley N° 28749)".
   - Verifica matemáticamente que kwhFp + kwhHp === totalKwh.
3. maxKw:
   - Es el mayor valor de "Potencia Registrada" en el cuadro "Demanda (kW)", que coincide siempre con la columna Consumo de "Potencia Generación Fuera de Punta" y con el 12° valor de la fila "Max-kW".
   - ¡PROHIBIDO usar el valor de "Potencia Distribución Fuera de Punta"!
4. contractedKw: Potencia contratada en kW.
5. totalBill: Total a pagar del mes en soles con IGV.
6. costItems: Cada concepto facturado en soles mapeado al nombre canónico más cercano. No incluyas subtotales, totales, ni la nota informativa al pie sobre FOSE.
7. historyRows (USA LAS PÁGINAS 3, 4 Y 5 CON SUPER-ZOOM SOBRE LA TABLA "Historia de Consumos y Demandas"):
   - La Página 3 muestra el zoom de la tabla completa de 12 columnas; la Página 4 muestra con macro-zoom las primeras columnas (izquierda) y la Página 5 las últimas columnas (derecha).
   - Lee FILA POR FILA de izquierda a derecha los 12 valores exactos (sin desplazar columnas ni inventar dígitos):
     * "kwhFpRow": Los 12 enteros de la primera fila "kW.h-FP". Revisa cada dígito en el macro-zoom de las Páginas 4 y 5: distingue con precisión el "5" del "6", el "6" del "2", el "8" del "0" y el "4" del "7". El 12° número coincide con kwhFp redondeado a entero.
     * "kwhHpRow": Los 12 enteros de la segunda fila "kW.h-HP". Revisa cada dígito en las Páginas 4 y 5: distingue con precisión el "6" del "0" y el "7" del "5". El 12° número coincide con kwhHp redondeado a entero.
     * "maxKwRow": Los 12 decimales de la tercera fila "Max-kW" (todos tienen 2 decimales). El 12° número coincide exactamente con maxKw.
8. Devuelve todos los números como número JS puro sin separador de miles (1234.56).`;

const httpError = (status, message) => Object.assign(new Error(message), { status });
const round2 = (n) => Math.round(n * 100) / 100;
const YM = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * Extrae las dimensiones (width, height, components) de un buffer JPEG
 * leyendo sus marcadores SOF0 / SOF1 / SOF2 (0xFFC0..0xFFC2).
 */
function parseJpegDimensions(jpegBuf) {
  let i = 2;
  const n = jpegBuf.length;
  while (i < n - 9) {
    if (jpegBuf[i] !== 0xff) {
      i++;
      continue;
    }
    while (i < n && jpegBuf[i] === 0xff) i++;
    if (i >= n) break;
    const marker = jpegBuf[i++];
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (i + 2 > n) break;
    const len = jpegBuf.readUInt16BE(i);
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      if (i + 8 > n) break;
      const height = jpegBuf.readUInt16BE(i + 3);
      const width = jpegBuf.readUInt16BE(i + 5);
      const components = jpegBuf[i + 7];
      return { width, height, components };
    }
    i += len;
  }
  return null;
}

/**
 * Si el PDF contiene una imagen escaneada JPEG de página completa, genera en memoria
 * un PDF de 5 páginas reutilizando el mismo stream JPEG (sin aumentar el peso),
 * donde las páginas 2 a 5 son acercamientos ópticos (Super-Zoom) de las tablas.
 */
function buildZoomedPdfForOpenAI(pdfBuf) {
  const soi = pdfBuf.indexOf(Buffer.from([0xff, 0xd8, 0xff]));
  const eoi = pdfBuf.lastIndexOf(Buffer.from([0xff, 0xd9]));
  if (soi === -1 || eoi === -1 || eoi <= soi) return pdfBuf;

  const jpegBuf = pdfBuf.subarray(soi, eoi + 2);
  const dims = parseJpegDimensions(jpegBuf);
  if (!dims || dims.width < 800 || dims.height < 800) return pdfBuf;

  const { width, height, components } = dims;
  const colorSpace = components === 1 ? "/DeviceGray" : "/DeviceRGB";

  // Vistas normalizadas: [xMinFrac, xMaxFrac, yTopMinFrac, yTopMaxFrac]
  const views = [
    [0.0, 1.0, 0.0, 1.0],       // Página 1: Recibo completo
    [0.0, 1.0, 0.24, 0.72],     // Página 2: Zoom 2x en Detalle de Importes + Lecturas y Demanda
    [0.02, 0.52, 0.71, 0.83],   // Página 3: Zoom 5x en tabla completa "Historia de Consumos y Demandas"
    [0.02, 0.30, 0.72, 0.825],  // Página 4: Macro-Zoom 8x en mitad IZQUIERDA de la tabla histórica (cols 1-6)
    [0.24, 0.51, 0.72, 0.825],  // Página 5: Macro-Zoom 8x en mitad DERECHA de la tabla histórica (cols 6-12)
  ];

  const objects = new Map();
  const pageRefs = views.map((_, idx) => `${4 + idx * 2} 0 R`).join(" ");

  objects.set(1, Buffer.from("<< /Type /Catalog /Pages 2 0 R >>", "ascii"));
  objects.set(
    2,
    Buffer.from(`<< /Type /Pages /Kids [${pageRefs}] /Count ${views.length} >>`, "ascii")
  );

  const imgHeader = Buffer.from(
    `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} ` +
      `/ColorSpace ${colorSpace} /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBuf.length} >>\nstream\n`,
    "ascii"
  );
  objects.set(3, Buffer.concat([imgHeader, jpegBuf, Buffer.from("\nendstream", "ascii")]));

  views.forEach(([x0f, x1f, yt0f, yt1f], idx) => {
    const pageObjId = 4 + idx * 2;
    const contentObjId = 5 + idx * 2;

    const yb0f = 1.0 - yt1f;
    const yb1f = 1.0 - yt0f;
    const cropW = (x1f - x0f) * width;
    const cropH = (yb1f - yb0f) * height;

    // Escalar el MediaBox a 900 puntos de ancho para que el rasterizador PDF de OpenAI
    // renderice el recorte a máxima resolución sin pérdida de píxeles
    const targetW = 900.0;
    const scale = targetW / cropW;
    const pageW = round2(targetW);
    const pageH = round2(cropH * scale);
    const drawW = round2(width * scale);
    const drawH = round2(height * scale);
    const tx = round2(-x0f * width * scale);
    const ty = round2(-yb0f * height * scale);

    const contentStream = Buffer.from(
      `q\n${drawW} 0 0 ${drawH} ${tx} ${ty} cm\n/Im1 Do\nQ\n`,
      "ascii"
    );
    objects.set(
      contentObjId,
      Buffer.concat([
        Buffer.from(`<< /Length ${contentStream.length} >>\nstream\n`, "ascii"),
        contentStream,
        Buffer.from("endstream", "ascii"),
      ])
    );

    objects.set(
      pageObjId,
      Buffer.from(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] ` +
          `/Resources << /XObject << /Im1 3 0 R >> >> /Contents ${contentObjId} 0 R >>`,
        "ascii"
      )
    );
  });

  const chunks = [Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "binary")];
  let currentOffset = chunks[0].length;
  const offsets = new Map();
  const maxId = 3 + views.length * 2;

  for (let oid = 1; oid <= maxId; oid++) {
    offsets.set(oid, currentOffset);
    const prefix = Buffer.from(`${oid} 0 obj\n`, "ascii");
    const body = objects.get(oid);
    const suffix = Buffer.from("\nendobj\n", "ascii");
    chunks.push(prefix, body, suffix);
    currentOffset += prefix.length + body.length + suffix.length;
  }

  const xrefOffset = currentOffset;
  let xrefStr = `xref\n0 ${maxId + 1}\n0000000000 65535 f \n`;
  for (let oid = 1; oid <= maxId; oid++) {
    xrefStr += `${String(offsets.get(oid)).padStart(10, "0")} 00000 n \n`;
  }
  xrefStr += `trailer\n<< /Size ${maxId + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  chunks.push(Buffer.from(xrefStr, "ascii"));

  return Buffer.concat(chunks);
}

/**
 * Genera los 12 meses consecutivos (YYYY-MM) de la tabla histórica:
 * índice 0 = (periodMonth - 11 meses) ... índice 11 = periodMonth.
 */
function getExpectedHistoryMonths(periodMonth) {
  const [year, month] = periodMonth.split("-").map(Number);
  const result = [];
  for (let offset = 11; offset >= 0; offset--) {
    const totalMonths = year * 12 + (month - 1) - offset;
    const y = Math.floor(totalMonths / 12);
    const m = (totalMonths % 12) + 1;
    result.push(`${y}-${String(m).padStart(2, "0")}`);
  }
  return result;
}

function isDigitTransposition(a, b) {
  if (a == null || b == null) return false;
  const sa = String(Math.round(a)).split("").sort().join("");
  const sb = String(Math.round(b)).split("").sort().join("");
  return sa.length > 1 && sa === sb && Math.round(a) !== Math.round(b);
}

function takeLast12(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.length > 12 ? arr.slice(arr.length - 12) : arr;
}

/**
 * Corrige transposiciones de los dos primeros dígitos en kwhFp del historial
 * cuando un valor rompe la relación mediana FP/HP del suministro.
 */
function sanitizeHistoryFpOutliers(history) {
  const ratios = history
    .filter((h) => h.kwhFp > 0 && h.kwhHp > 0)
    .map((h) => h.kwhFp / h.kwhHp)
    .sort((a, b) => a - b);

  if (ratios.length < 6) return;
  const medianRatio = ratios[Math.floor(ratios.length / 2)];

  for (const h of history) {
    if (!h.kwhFp || !h.kwhHp) continue;
    const currentRatio = h.kwhFp / h.kwhHp;

    if (Math.abs(currentRatio - medianRatio) / medianRatio > 0.35) {
      const s = String(Math.round(h.kwhFp));
      if (s.length === 4) {
        const swappedPrefix = Number(s[1] + s[0] + s.slice(2));
        const swappedRatio = swappedPrefix / h.kwhHp;
        if (Math.abs(swappedRatio - medianRatio) / medianRatio < 0.15) {
          h.kwhFp = swappedPrefix;
        }
      }
    }
  }
}

export function normalizeBill(raw) {
  if (!YM.test(raw.periodMonth)) {
    throw httpError(422, "No se pudo identificar el mes facturado de uno de los recibos.");
  }
  if (raw.kwhFp == null && raw.kwhHp == null) {
    throw httpError(422, `No se pudo leer el consumo en kWh del recibo ${raw.periodMonth}.`);
  }

  const warnings = [];
  const expectedMonths = getExpectedHistoryMonths(raw.periodMonth);

  // 1. Construir `history` desde las 3 filas horizontales
  let history = [];
  if (raw.historyRows) {
    const fpRow = takeLast12(raw.historyRows.kwhFpRow);
    const hpRow = takeLast12(raw.historyRows.kwhHpRow);
    const kwRow = takeLast12(raw.historyRows.maxKwRow);
    const len = Math.min(12, Math.max(fpRow.length, hpRow.length, kwRow.length));
    const monthSlice = expectedMonths.slice(12 - len);

    history = monthSlice.map((month, idx) => ({
      month,
      kwhFp: fpRow[idx] != null ? round2(fpRow[idx]) : null,
      kwhHp: hpRow[idx] != null ? round2(hpRow[idx]) : null,
      maxKw: kwRow[idx] != null ? round2(kwRow[idx]) : null,
    }));
  } else if (Array.isArray(raw.history)) {
    const expectedSet = new Set(expectedMonths);
    history = raw.history.filter((h) => YM.test(h.month) && expectedSet.has(h.month));
  }

  sanitizeHistoryFpOutliers(history);

  const lastHist = history.length > 0 ? history[history.length - 1] : null;

  // 2. Validar kwhFp y kwhHp del mes actual (conservando decimales exactos)
  let kwhFp = raw.kwhFp != null ? round2(raw.kwhFp) : null;
  let kwhHp = raw.kwhHp != null ? round2(raw.kwhHp) : null;
  const totalKwh = raw.totalKwh != null ? round2(raw.totalKwh) : null;

  if (kwhFp != null && kwhHp != null) {
    const swappedVsHist =
      lastHist &&
      lastHist.kwhFp != null &&
      lastHist.kwhHp != null &&
      Math.abs(Math.round(kwhFp) - Math.round(lastHist.kwhHp)) <= 2 &&
      Math.abs(Math.round(kwhHp) - Math.round(lastHist.kwhFp)) <= 2 &&
      Math.round(kwhFp) !== Math.round(kwhHp);

    const histFpAlwaysGreater =
      history.length >= 6 &&
      history.every((h) => h.kwhFp == null || h.kwhHp == null || h.kwhFp >= h.kwhHp);

    if (swappedVsHist || (histFpAlwaysGreater && kwhFp < kwhHp)) {
      [kwhFp, kwhHp] = [kwhHp, kwhFp];
    }
  }

  if (totalKwh != null && kwhFp != null && kwhHp != null) {
    const sumKwh = round2(kwhFp + kwhHp);
    if (Math.abs(sumKwh - totalKwh) > 0.05) {
      const derivedFp = round2(totalKwh - kwhHp);
      const derivedHp = round2(totalKwh - kwhFp);

      if (
        (lastHist?.kwhFp != null && Math.abs(Math.round(derivedFp) - Math.round(lastHist.kwhFp)) <= 1) ||
        isDigitTransposition(kwhFp, derivedFp)
      ) {
        kwhFp = derivedFp;
      } else if (
        (lastHist?.kwhHp != null && Math.abs(Math.round(derivedHp) - Math.round(lastHist.kwhHp)) <= 1) ||
        isDigitTransposition(kwhHp, derivedHp)
      ) {
        kwhHp = derivedHp;
      }
    }
  }

  // 3. Validar maxKw del mes actual
  let maxKw = raw.maxKw != null ? round2(raw.maxKw) : null;
  if (maxKw == null && lastHist?.maxKw != null && lastHist.month === raw.periodMonth) {
    maxKw = lastHist.maxKw;
  }

  // 4. Sincronizar el mes actual (columna 12) en `history` conservando los decimales exactos
  if (lastHist && lastHist.month === raw.periodMonth) {
    if (kwhFp != null) lastHist.kwhFp = kwhFp;
    if (kwhHp != null) lastHist.kwhHp = kwhHp;
    if (maxKw != null) lastHist.maxKw = maxKw;
  }

  // 5. Consolidar costos y validar suma contra totalBill
  const costs = {};
  for (const it of raw.costItems) {
    costs[it.name] = round2((costs[it.name] || 0) + it.value);
  }

  const sum = Object.values(costs).reduce((s, v) => s + v, 0);
  if (raw.totalBill && Math.abs(sum - raw.totalBill) / raw.totalBill > 0.02) {
    warnings.push(
      `Recibo ${raw.periodMonth}: los conceptos suman S/ ${round2(sum)} y el total leído es S/ ${raw.totalBill}. Revisa la lectura.`
    );
  }

  const { totalKwh: _omitTotal, historyRows: _omitRows, ...restRaw } = raw;

  return {
    ...restRaw,
    kwhFp,
    kwhHp,
    maxKw,
    costs,
    history,
    warnings,
  };
}

/**
 * Acepta un Buffer con el PDF (recomendado, sin tocar disco)
 * o una ruta de archivo (compatibilidad).
 */
export async function extractBill(input) {
  const rawPdfBuf = Buffer.isBuffer(input) ? input : await fs.readFile(input);
  // Generamos el PDF con páginas de Super-Zoom para que OpenAI lea la tabla sin pérdida de resolución
  const enhancedPdfBuf = buildZoomedPdfForOpenAI(rawPdfBuf);
  const b64 = enhancedPdfBuf.toString("base64");

  let res;
  try {
    res = await client.responses.create({
      model: MODEL,
      temperature: 0,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_file",
              filename: "recibo.pdf",
              file_data: `data:application/pdf;base64,${b64}`,
            },
            { type: "input_text", text: PROMPT },
          ],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "recibo_luz",
          strict: true,
          schema: SCHEMA,
        },
      },
    });
  } catch (e) {
    throw httpError(502, `OpenAI no pudo procesar el PDF: ${e.message}`);
  }

  let raw;
  try {
    raw = JSON.parse(res.output_text);
  } catch {
    throw httpError(502, "OpenAI devolvió una respuesta que no es JSON válido.");
  }
  return normalizeBill(raw);
}