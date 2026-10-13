import openai from "../config/openai.js";
import Board from "../models/Board.js";
import sharp from "sharp";
import fs from "fs";

const MODEL = process.env.OPENAI_BILL_MODEL || "gpt-4o";

const MESES = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Set", "Oct", "Nov", "Dic"];

const num = (v) => {
  if (typeof v === "string") v = v.replace(/,/g, "");
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};
const round2 = (n) => (n == null ? null : Math.round(n * 100) / 100);

// "30/04/2026" -> Date (UTC)
const parseDMY = (s) => {
  const m = String(s || "").match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
  return Number.isNaN(d.getTime()) ? null : d;
};
const diffDays = (a, b) => {
  const d1 = parseDMY(a);
  const d2 = parseDMY(b);
  if (!d1 || !d2) return null;
  const days = Math.round(Math.abs(d1 - d2) / 86400000);
  return days >= 20 && days <= 40 ? days : null;
};
const daysInMonth = (year, monthIdx) => new Date(Date.UTC(year, monthIdx + 1, 0)).getUTCDate();

// ── Llamada a visión (JSON estricto) ──
const callVision = async (base64Data, prompt) => {
  const response = await openai.chat.completions.create({
    model: MODEL,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: base64Data, detail: "high" } },
        ],
      },
    ],
    response_format: { type: "json_object" },
    temperature: 0,
  });
  return JSON.parse(response.choices[0]?.message?.content || "{}");
};

const MAIN_PROMPT = `Eres un extractor de datos de recibos de luz peruanos (Luz del Sur / Enel).
Copia los números TAL CUAL aparecen, sin calcular ni redondear. Quita solo las comas de miles.
Distingue siempre kWh (cantidad) de S/. (importe en soles): son columnas distintas.

A) En "DETALLE DE LOS IMPORTES FACTURADOS" hay una tabla con columnas
   Descripción | Precio Unitario | Consumo | Importe. Extrae de las filas:
   - "Consumo de Energía Hora Punta": precio unitario (tarifaHP), Consumo en kWh (kwhHP) e Importe en soles (importeHP)
   - "Consumo de Energía Fuera Punta": precio unitario (tarifaFP), Consumo en kWh (kwhFP) e Importe en soles (importeFP)
   NO uses la fila de energía reactiva ni las de potencia.

B) En "Energía Activa (kW.h)" busca las fechas de "Lectura Actual" y "Lectura Anterior"
   (formato DD/MM/AAAA) y devuélvelas en fechaLecturaActual y fechaLecturaAnterior.

C) Abajo del recibo hay una tabla pequeña "Historia de Consumos y Demandas" con una
   columna por mes (My, Jn, Jl, Ag, Se, Oc, Nv, Di, En, Fe, Mr, Ab). Tiene la fila "kW.h - FP"
   y la fila "kW.h - HP" (son kWh, NO soles). Devuelve cada fila como una lista con TODOS
   sus valores de izquierda a derecha (normalmente 12), sin saltarte ninguno.

Devuelve ÚNICAMENTE este JSON:
{
  "tarifaHP": 0.2846,
  "tarifaFP": 0.2452,
  "actual": {
    "kwhHP": 13602.60,
    "kwhFP": 80365.26,
    "importeHP": 3871.30,
    "importeFP": 19705.56,
    "fechaLecturaActual": "30/04/2026",
    "fechaLecturaAnterior": "30/03/2026"
  },
  "historialFP": [60332, 61198, 56650, 52446, 54836, 54273, 58258, 65045, 73798, 88541, 81327, 80365],
  "historialHP": [11418, 11803, 11033, 9838, 11253, 11940, 12421, 12160, 12971, 15499, 13630, 13603]
}
Los números de historialFP e historialHP del ejemplo son solo de formato: copia los del recibo.
Si un dato no se ve, ponlo en null. No inventes valores.`;

// Segundo intento: solo la tabla, RECORTADA y ampliada. Se pide por columna (mes + fp + hp)
// para que la IA no pueda saltarse columnas y rellenar con null al final.
const HISTORY_PROMPT = `Esta imagen es un recorte de la tabla "Historia de Consumos y Demandas" de un recibo de luz peruano.
Tiene una columna por mes (12 columnas) y las filas "kW.h - FP", "kW.h - HP" y "Max - kW".
Lee SOLO "kW.h - FP" y "kW.h - HP", columna por columna, de izquierda a derecha, SIN omitir ni repetir ninguna.
Los valores son números enteros de 4 o 5 cifras (kWh). Si un valor no se ve con claridad, pon null; no lo adivines.
Devuelve ÚNICAMENTE este JSON, con una entrada por cada columna que veas (normalmente 12):
{ "columnas": [ { "mes": "My", "fp": 0, "hp": 0 } ] }`;

// Recorta la zona de la tabla (parte baja-izquierda del recibo), la amplía y la deja en alto contraste.
// Las proporciones valen para el formato Luz del Sur; si cambia el formato, ajusta estos 4 números.
const RECORTE = { left: 0.02, top: 0.72, width: 0.5, height: 0.1 };
const recortarTabla = async (buffer) => {
  const base = await sharp(buffer).rotate().toBuffer(); // respeta la orientación EXIF del celular
  const { width, height } = await sharp(base).metadata();
  const w = Math.round(width * RECORTE.width);
  const out = await sharp(base)
    .extract({
      left: Math.round(width * RECORTE.left),
      top: Math.round(height * RECORTE.top),
      width: w,
      height: Math.round(height * RECORTE.height),
    })
    .resize({ width: w * 4, kernel: "lanczos3" })
    .grayscale()
    .normalise()
    .sharpen()
    .png()
    .toBuffer();
  if (process.env.DEBUG_RECIBO) fs.writeFileSync("debug-tabla.png", out); // para ver qué recorta
  return `data:image/png;base64,${out.toString("base64")}`;
};

const tablaDesdeColumnas = (cols) => ({
  fp: Array.isArray(cols) ? cols.map((c) => c?.fp) : [],
  hp: Array.isArray(cols) ? cols.map((c) => c?.hp) : [],
});

// ── Valida la tabla de 12 meses contra el mes facturado ──
// Devuelve { ok, motivo, fpArr, hpArr }. No lanza errores: el motivo sirve para el log.
const validarTabla = (rawFP, rawHP, kwhFPActual, kwhHPActual) => {
  const listFP = Array.isArray(rawFP) ? rawFP.map(num) : [];
  const listHP = Array.isArray(rawHP) ? rawHP.map(num) : [];
  const n = Math.min(listFP.length, listHP.length, 12);

  if (n < 2) return { ok: false, motivo: `tabla muy corta (FP=${listFP.length}, HP=${listHP.length})` };

  // Se alinea desde el final: la última columna es el mes facturado
  const fpArr = listFP.slice(listFP.length - n);
  const hpArr = listHP.slice(listHP.length - n);

  if (fpArr.some((v) => v == null) || hpArr.some((v) => v == null)) {
    return { ok: false, motivo: "hay meses ilegibles (null o 0)", fpArr, hpArr };
  }

  const totalActual = kwhHPActual + kwhFPActual;
  const cercano = (x, ref, tol) => Math.abs(x - ref) / ref <= tol;

  if (!cercano(fpArr[n - 1], kwhFPActual, 0.1) || !cercano(hpArr[n - 1], kwhHPActual, 0.1)) {
    return {
      ok: false,
      motivo: `el último mes de la tabla (FP ${fpArr[n - 1]}, HP ${hpArr[n - 1]}) no coincide con el facturado (FP ${kwhFPActual}, HP ${kwhHPActual})`,
      fpArr,
      hpArr,
    };
  }

  const fuera = fpArr
    .map((fp, i) => ({ i, t: fp + hpArr[i] }))
    .filter(({ t }) => t < totalActual * 0.2 || t > totalActual * 5);
  if (fuera.length > 0) {
    return { ok: false, motivo: `meses fuera de rango plausible (posiciones ${fuera.map((f) => f.i).join(", ")})`, fpArr, hpArr };
  }

  return { ok: true, motivo: "ok", fpArr, hpArr };
};

export const extractElectricityRates = async (req, res) => {
  try {
    const { boardId } = req.params;
    const file = req.file;

    if (!file || !file.buffer) {
      return res.status(400).json({ error: "Debes adjuntar una imagen del recibo de luz." });
    }

    const mime = file.mimetype || "image/jpeg";
    if (!mime.startsWith("image/")) {
      return res.status(400).json({
        error: "Formato no compatible. Por favor sube una imagen (JPG, PNG o WEBP) de tu recibo de luz.",
      });
    }

    const base64Data = `data:${mime};base64,${file.buffer.toString("base64")}`;

    const parsed = await callVision(base64Data, MAIN_PROMPT);
    console.log("[recibo] respuesta de la IA:", JSON.stringify(parsed));

    const tarifaHP = num(parsed.tarifaHP);
    const tarifaFP = num(parsed.tarifaFP);

    if (!tarifaHP || !tarifaFP) {
      return res.status(422).json({
        error: "No se pudieron extraer los datos del recibo. Asegúrate de que los importes facturados sean legibles.",
      });
    }

    // ── Mes actual, con validación cruzada: kWh ≈ importe ÷ tarifa ──
    const a = parsed.actual || {};
    const importeHP = num(a.importeHP);
    const importeFP = num(a.importeFP);
    const esperadoHP = importeHP ? importeHP / tarifaHP : null;
    const esperadoFP = importeFP ? importeFP / tarifaFP : null;

    const reconcile = (leido, esperado) => {
      if (leido && esperado) {
        return Math.abs(leido - esperado) / esperado > 0.05 ? esperado : leido;
      }
      return leido ?? esperado ?? null;
    };

    const kwhHPActual = reconcile(num(a.kwhHP), esperadoHP);
    const kwhFPActual = reconcile(num(a.kwhFP), esperadoFP);

    if (kwhHPActual == null || kwhFPActual == null) {
      return res.status(422).json({
        error: "No se pudieron leer los kWh del recibo. Sube una imagen más nítida.",
      });
    }

    // ── Últimos 12 meses (tabla pequeña) ──
    let tabla = validarTabla(parsed.historialFP, parsed.historialHP, kwhFPActual, kwhHPActual);

    if (!tabla.ok) {
      console.warn("[recibo] tabla descartada en el 1er intento:", tabla.motivo, {
        historialFP: parsed.historialFP,
        historialHP: parsed.historialHP,
      });
      try {
        const recorte = await recortarTabla(file.buffer);
        const retry = await callVision(recorte, HISTORY_PROMPT);
        console.log("[recibo] 2do intento (tabla recortada):", JSON.stringify(retry));
        const { fp, hp } = tablaDesdeColumnas(retry.columnas);
        tabla = validarTabla(fp, hp, kwhFPActual, kwhHPActual);
        if (!tabla.ok) console.warn("[recibo] tabla descartada en el 2do intento:", tabla.motivo);
      } catch (e) {
        console.warn("[recibo] falló el 2do intento:", e.message);
      }
    }

    let n, fpArr, hpArr, warning = null;
    if (tabla.ok) {
      n = tabla.fpArr.length;
      fpArr = [...tabla.fpArr];
      hpArr = [...tabla.hpArr];
      // El último mes se toma del detalle de importes (más fiable)
      fpArr[n - 1] = kwhFPActual;
      hpArr[n - 1] = kwhHPActual;
      if (n < 12) {
        warning = `Solo se pudieron leer ${n} de 12 meses del historial. La proyección usará el promedio disponible.`;
      }
    } else {
      n = 1;
      fpArr = [kwhFPActual];
      hpArr = [kwhHPActual];
      warning =
        "No se pudo leer el historial de 12 meses del recibo (" + tabla.motivo + "). " +
        "Se muestra solo el mes facturado; sube una imagen más nítida para ver el consumo anual real.";
    }

    // ── Etiquetas de mes calculadas desde la fecha de lectura (no dependen de la IA) ──
    const fechaActual = parseDMY(a.fechaLecturaActual);
    const history = [];
    for (let i = 0; i < n; i++) {
      const back = n - 1 - i;
      let period = back === 0 ? "Actual" : `Mes -${back}`;
      let dias = 30;
      if (fechaActual) {
        const total = fechaActual.getUTCFullYear() * 12 + fechaActual.getUTCMonth() - back;
        const y = Math.floor(total / 12);
        const m = total % 12;
        period = `${MESES[m]} ${String(y).slice(-2)}`;
        dias = daysInMonth(y, m);
      }
      if (back === 0) {
        dias = diffDays(a.fechaLecturaActual, a.fechaLecturaAnterior) ?? dias;
      }
      const hp = hpArr[i];
      const fp = fpArr[i];
      history.push({
        period,
        dias,
        kwhHP: round2(hp),
        kwhFP: round2(fp),
        kwhTotal: round2(hp + fp),
        costoHP: back === 0 ? importeHP : null,
        costoFP: back === 0 ? importeFP : null,
        costoTotal: back === 0 && importeHP && importeFP ? round2(importeHP + importeFP) : null,
      });
    }

    if (boardId) {
      await Board.findByIdAndUpdate(boardId, {
        $set: {
          "energyRates.tarifaHP": tarifaHP,
          "energyRates.tarifaFP": tarifaFP,
          "energyRates.history": history,
          "energyRates.updatedAt": new Date(),
        },
      });
    }

    return res.status(200).json({
      success: true,
      message: "Recibo analizado y guardado exitosamente.",
      data: { tarifaHP, tarifaFP, history, historyOk: tabla.ok && n >= 12, warning },
    });
  } catch (error) {
    console.error("Error al procesar recibo en OpenAI:", error);
    return res.status(500).json({
      error: "Error interno al analizar el recibo de luz: " + error.message,
    });
  }
};

/*
  Schema de Board (models/Board.js): energyRates.history debe declarar
  period, dias, kwhHP, kwhFP, kwhTotal, costoHP, costoFP, costoTotal.
*/
