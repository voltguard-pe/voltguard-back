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
    "distributor", "supplyNumber", "periodMonth", "contractedKw",
    "kwhFp", "kwhHp", "maxKw", "totalBill", "costItems", "history",
  ],
  properties: {
    distributor: { type: ["string", "null"] },
    supplyNumber: { type: ["string", "null"] },
    periodMonth: { type: "string", description: "Mes de consumo facturado, formato YYYY-MM" },
    contractedKw: nullableNum,
    kwhFp: nullableNum,
    kwhHp: nullableNum,
    maxKw: nullableNum,
    totalBill: nullableNum,
    costItems: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "value"],
        properties: { name: { type: "string", enum: COST_NAMES }, value: { type: "number" } },
      },
    },
    history: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["month", "kwhFp", "kwhHp", "maxKw"],
        properties: {
          month: { type: "string", description: "YYYY-MM" },
          kwhFp: nullableNum,
          kwhHp: nullableNum,
          maxKw: nullableNum,
        },
      },
    },
  },
};

const PROMPT = `Eres un extractor experto de datos de recibos de luz peruanos (Luz del Sur, Enel). Lee el PDF y devuelve SOLO el JSON del esquema.

REGLAS CRÍTICAS:
1. periodMonth: Mes de CONSUMO facturado (no fecha de emisión ni vencimiento), en formato YYYY-MM (ej. si dice Lectura Actual 25/11/2025 o Emisión 30-NOV-2025, es "2025-11"; si es 30-ABR-2026, es "2026-04").
2. kwhFp y kwhHp del mes actual:
   - "kwhFp" es "Consumo de Energía Fuera Punta" (suele ser el consumo mayor, ej. 12779.20 o 4599.00).
   - "kwhHp" es "Consumo de Energía Hora Punta" (suele ser el consumo menor, ej. 1165.60 o 717.00).
   - ¡NUNCA los inviertas aunque "Hora Punta" aparezca primero en la tabla de importes!
3. maxKw: Máxima demanda / potencia registrada del mes en kW (entre hora punta y fuera de punta, usa la mayor).
4. contractedKw: Potencia contratada en kW.
5. totalBill: Total a pagar del mes en soles, con IGV.
6. costItems: Cada concepto facturado en soles mapeado al nombre canónico más cercano. No incluyas subtotales ni el total.
7. history (LECTURA VISUAL Y CÁLCULO EXACTO DE AÑO):
   - En la parte inferior del recibo está la tabla "Historia de Consumos y Demandas" con 12 columnas mensuales (ej. Di, En, Fe, Mr, Ab, My, Jn, Jl, Ag, Se, Oc, Nv) y 3 filas: "kW.h - FP", "kW.h - HP" y "Max - kW".
   - Ignora el texto OCR corrupto del PDF y LEE VISUALMENTE LA IMAGEN DE LA TABLA columna por columna.
   - La columna 12 (extremo derecho) es siempre periodMonth, la columna 11 es 1 mes antes, y así sucesivamente hasta la columna 1 (extremo izquierdo), que es 11 meses antes de periodMonth.
   - ¡Cuidado con el cambio de año!: Si periodMonth es "2025-11", las columnas de Ene a Nov son de 2025 ("2025-01" a "2025-11"), pero la primera columna "Di" es de DICIEMBRE DEL AÑO ANTERIOR ("2024-12"). Si periodMonth es "2026-04", las columnas de "My" a "Di" son de 2025 ("2025-05" a "2025-12") y de "En" a "Ab" son de 2026 ("2026-01" a "2026-04").
8. Devuelve todos los números como número JS puro sin separador de miles (1234.56).`;

const httpError = (status, message) => Object.assign(new Error(message), { status });
const round2 = (n) => Math.round(n * 100) / 100;
const YM = /^\d{4}-(0[1-9]|1[0-2])$/;

export function normalizeBill(raw) {
  if (!YM.test(raw.periodMonth)) {
    throw httpError(422, "No se pudo identificar el mes facturado de uno de los recibos.");
  }
  if (raw.kwhFp == null && raw.kwhHp == null) {
    throw httpError(422, `No se pudo leer el consumo en kWh del recibo ${raw.periodMonth}.`);
  }

  const costs = {};
  for (const it of raw.costItems) costs[it.name] = round2((costs[it.name] || 0) + it.value);

  const warnings = [];
  const sum = Object.values(costs).reduce((s, v) => s + v, 0);
  if (raw.totalBill && Math.abs(sum - raw.totalBill) / raw.totalBill > 0.02) {
    warnings.push(
      `Recibo ${raw.periodMonth}: los conceptos suman S/ ${round2(sum)} y el total leído es S/ ${raw.totalBill}. Revisa la lectura.`
    );
  }

  return { ...raw, costs, history: raw.history.filter((h) => YM.test(h.month)), warnings };
}

export async function extractBill(filePath) {
  const b64 = (await fs.readFile(filePath)).toString("base64");

  let res;
  try {
    res = await client.responses.create({
      model: MODEL,
      input: [
        {
          role: "user",
          content: [
            { type: "input_file", filename: "recibo.pdf", file_data: `data:application/pdf;base64,${b64}` },
            { type: "input_text", text: PROMPT },
          ],
        },
      ],
      text: { format: { type: "json_schema", name: "recibo_luz", strict: true, schema: SCHEMA } },
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