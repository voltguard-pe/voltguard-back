import openai from "../config/openai.js";
import Board from "../models/Board.js";
import sharp from "sharp";

const MODEL = process.env.OPENAI_BILL_MODEL || "gpt-4o";

// Variantes de lectura de la tabla. Cada variante lee 2 mitades (6 columnas cada una).
// 1 = gris, 2 = gris + nítida, 3 = gris + nítida + gris muy ampliada (la 3.ª solo se usa si hay desacuerdo).
const MAX_VARIANTES = Math.min(Math.max(Number(process.env.RECIBO_MAX_LECTURAS) || 3, 1), 3);

const MESES = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Set", "Oct", "Nov", "Dic"];

// Abreviaturas de mes tal como aparecen en la tabla del recibo -> índice de mes (0 = enero)
const ETIQUETA_A_MES = {
  ene: 0, en: 0, feb: 1, fe: 1, mar: 2, mr: 2, abr: 3, ab: 3, may: 4, my: 4, jun: 5, jn: 5,
  jul: 6, jl: 6, ago: 7, ag: 7, set: 8, sep: 8, se: 8, oct: 9, oc: 9, nov: 10, nv: 10, dic: 11, di: 11,
};
const mesDeEtiqueta = (s) => {
  const k = String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
  return Object.prototype.hasOwnProperty.call(ETIQUETA_A_MES, k) ? ETIQUETA_A_MES[k] : null;
};

const num = (v) => {
  if (typeof v === "string") v = v.replace(/,/g, "");
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};
// Los kWh del historial son enteros: un valor con decimales es de otra fila (p. ej. "Max - kW")
const entero = (v) => {
  const n = num(v);
  return n != null && Number.isInteger(n) ? n : null;
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

// OJO: los números del JSON de ejemplo son 0 a propósito (la IA a veces copiaba valores reales de ejemplo).
// Un 0 se descarta solo (num() lo vuelve null).
const MAIN_PROMPT = `Eres un extractor de datos de recibos de luz peruanos (Luz del Sur / Enel).
Copia los números TAL CUAL aparecen, sin calcular ni redondear. Quita solo las comas de miles.
Distingue siempre kWh (cantidad) de S/. (importe en soles): son columnas distintas.

A) En "DETALLE DE LOS IMPORTES FACTURADOS" hay una tabla con columnas
   Descripción | Precio Unitario | Consumo | Importe. Extrae de las filas:
   - "Consumo de Energía Hora Punta": precio unitario (tarifaHP), Consumo en kWh (kwhHP) e Importe en soles (importeHP)
   - "Consumo de Energía Fuera Punta": precio unitario (tarifaFP), Consumo en kWh (kwhFP) e Importe en soles (importeFP)
   NO uses las filas de energía reactiva (Capacitiva / Inductiva), de potencia, de Electrificación Rural ni de Alumbrado para estos campos.

B) En "Energía Activa (kW.h)" busca las fechas de "Lectura Actual" y "Lectura Anterior"
   (formato DD/MM/AAAA, suelen venir entre paréntesis) y devuélvelas en fechaLecturaActual y fechaLecturaAnterior.

C) Abajo del recibo hay una tabla pequeña "Historia de Consumos y Demandas" con una
   columna por mes (My, Jn, Jl, Ag, Se, Oc, Nv, Di, En, Fe, Mr, Ab). Tiene la fila "kW.h - FP"
   y la fila "kW.h - HP" (son kWh, NO soles) y la fila "Max - kW" (con decimales: IGNÓRALA).
   Devuelve cada fila como una lista con TODOS sus valores de izquierda a derecha (12), sin saltarte ninguno.
   Si no puedes leer un valor con claridad, pon null en esa posición (NO lo inventes ni lo repitas).

D) Importes totales:
   - "TOTAL A PAGAR S/": devuélvelo en totalPagar (sin asteriscos ni comas).
   - "SUBTOTAL DEL MES" (o "TOTAL LUZ DEL SUR"): devuélvelo en subtotalMes.
   - De la tabla de importes, devuelve los importes en soles de: "Consumo de Energía Reactiva"
     (importeReactiva), "Potencia Generación ..." (importePotenciaGeneracion),
     "Potencia Distribución ..." (importePotenciaDistribucion) e "I.G.V." (importeIGV).
   - Debajo del gráfico de barras dice "Importe 2 Últimos Meses Facturados" con dos montos
     (por ejemplo "Feb-26 S/ 00,000.00  Mar-26 S/ 00,000.00"). Devuélvelos en ultimosMeses,
     en el mismo orden en que aparecen, con "mes" y "total" (número).

Devuelve ÚNICAMENTE este JSON. Todos los 0 son solo marcadores de formato: reemplázalos por lo que ves en ESTE recibo; si un dato no se ve, ponlo en null.
{
  "tarifaHP": 0,
  "tarifaFP": 0,
  "actual": {
    "kwhHP": 0,
    "kwhFP": 0,
    "importeHP": 0,
    "importeFP": 0,
    "fechaLecturaActual": "DD/MM/AAAA",
    "fechaLecturaAnterior": "DD/MM/AAAA",
    "totalPagar": 0,
    "subtotalMes": 0,
    "importeReactiva": 0,
    "importePotenciaGeneracion": 0,
    "importePotenciaDistribucion": 0,
    "importeIGV": 0
  },
  "ultimosMeses": [ { "mes": "Mmm-AA", "total": 0 }, { "mes": "Mmm-AA", "total": 0 } ],
  "historialFP": [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  "historialHP": [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
}
No inventes valores.`;

// Lectura de una MITAD de la tabla (izquierda o derecha).
const HALF_PROMPT = `Esta imagen es un pedazo (la parte izquierda o la derecha) de la tabla "Historia de Consumos y Demandas" de un recibo de luz peruano.
Normalmente trae 6 columnas de meses. De arriba hacia abajo contiene:
 1) una fila de meses en abreviatura (My, Jn, Jl, Ag, Se, Oc, Nv, Di, En, Fe, Mr, Ab),
 2) la fila "kW.h - FP": números ENTEROS de 4 o 5 cifras,
 3) la fila "kW.h - HP": números ENTEROS de 3 o 4 cifras (siempre menores que los de FP),
 4) la fila "Max - kW": números con decimales. IGNÓRALA POR COMPLETO.
Si falta la columna con los nombres de fila (pedazo derecho), guíate por el orden de las filas.
Lee SOLO las columnas completas, de izquierda a derecha, sin saltarte ninguna. Copia el mes tal cual aparece y lee cada número cifra por cifra.
Si una columna está cortada en el borde de la imagen, no la incluyas. Si un número no se ve con claridad, pon null; no lo adivines ni lo calcules.
Devuelve ÚNICAMENTE este JSON:
{ "columnas": [ { "mes": "My", "fp": 0, "hp": 0 } ] }`;

// Lectura de la tabla completa (solo se usa si el recibo no trae fecha de lectura)
const HISTORY_PROMPT = `Esta imagen es un recorte de la tabla "Historia de Consumos y Demandas" de un recibo de luz peruano.
Tiene una columna por mes (12 columnas) y las filas "kW.h - FP" (enteros de 4 o 5 cifras), "kW.h - HP" (enteros de 3 o 4 cifras) y "Max - kW" (con decimales; IGNÓRALA).
Lee SOLO "kW.h - FP" y "kW.h - HP", columna por columna, de izquierda a derecha, SIN omitir ni repetir ninguna, cifra por cifra.
Si un valor no se ve con claridad, pon null; no lo adivines.
Devuelve ÚNICAMENTE este JSON, con una entrada por cada columna que veas (normalmente 12):
{ "columnas": [ { "mes": "My", "fp": 0, "hp": 0 } ] }`;

// ── Ubicar la tabla con la IA (imagen reducida = barata) ──
const LOCATE_PROMPT = `Esta imagen es un recibo de luz peruano.
Ubica el rectángulo que contiene SOLO la tabla "Historia de Consumos y Demandas"
(la tabla pequeña con una columna por mes y las filas "kW.h - FP", "kW.h - HP" y "Max - kW").
Desde el título "Historia de Consumos y Demandas" hasta la fila "Max - kW" inclusive.
No incluyas el gráfico de barras ni las tablas de arriba (Energía Reactiva).
Devuelve ÚNICAMENTE este JSON con proporciones de 0 a 1 respecto al ancho y alto de la imagen:
{ "left": 0.0, "top": 0.0, "width": 0.0, "height": 0.0 }
Si no encuentras la tabla, devuelve { "left": null, "top": null, "width": null, "height": null }.`;

// Respaldo si la IA no ubica la tabla (formato Luz del Sur). Si cambia el formato, ajusta estos 4 números.
const RECORTE_FIJO = { left: 0.04, top: 0.738, width: 0.44, height: 0.062 };

const boxValido = (b) => {
  if (!b) return false;
  const { left, top, width, height } = b;
  const ok = [left, top, width, height].every((v) => typeof v === "number" && Number.isFinite(v));
  if (!ok) return false;
  if (width < 0.15 || height < 0.03) return false;
  if (width > 0.98 && height > 0.6) return false;
  return left >= 0 && top >= 0 && left + width <= 1.001 && top + height <= 1.001;
};

const ampliarBox = (b) => {
  const mx = b.width * 0.03;
  const my = b.height * 0.1;
  const left = Math.max(0, b.left - mx);
  const top = Math.max(0, b.top - my);
  const right = Math.min(1, b.left + b.width + mx);
  const bottom = Math.min(1, b.top + b.height + my);
  return { left, top, width: right - left, height: bottom - top };
};

const prepararBase = async (buffer) => {
  const base = await sharp(buffer).rotate().toBuffer();
  const thumb = await sharp(base)
    .resize({ width: 1400, withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer();
  return { base, thumbUrl: `data:image/jpeg;base64,${thumb.toString("base64")}` };
};

const ubicarTabla = async (thumbUrl) => {
  try {
    const box = await callVision(thumbUrl, LOCATE_PROMPT);
    console.log("[recibo] box de la tabla según la IA:", JSON.stringify(box));
    return boxValido(box) ? ampliarBox(box) : null;
  } catch (e) {
    console.warn("[recibo] falló ubicar la tabla:", e.message);
    return null;
  }
};

const regionDeBox = (width, height, box) => {
  const left = Math.min(width - 1, Math.max(0, Math.round(width * box.left)));
  const top = Math.min(height - 1, Math.max(0, Math.round(height * box.top)));
  const w = Math.max(1, Math.min(Math.round(width * box.width), width - left));
  const h = Math.max(1, Math.min(Math.round(height * box.height), height - top));
  return { left, top, width: w, height: h };
};

// Recorta, amplía y deja en alto contraste (todo en memoria). Ancho máx. 2000 px.
// nitida = más enfoque y contraste (NO binarizar: el umbral rompe los dígitos finos).
const recortarConBox = async (base, box, { zoom = 5, nitida = false } = {}) => {
  const { width, height } = await sharp(base).metadata();
  const region = regionDeBox(width, height, box);
  const targetW = Math.min(Math.round(region.width * zoom), 2000);
  let img = sharp(base)
    .extract(region)
    .resize({ width: targetW, kernel: "lanczos3" })
    .grayscale()
    .normalise();
  if (nitida) img = img.sharpen({ sigma: 1.5, m1: 1, m2: 2 }).linear(1.25, -35);
  const out = await img.png().toBuffer();
  return `data:image/png;base64,${out.toString("base64")}`;
};

// ── Análisis de la tabla por píxeles (sin IA) ──
const analizarTabla = async (base, box) => {
  const { width, height } = await sharp(base).metadata();
  const region = regionDeBox(width, height, box);
  const { data, info } = await sharp(base)
    .extract(region)
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;

  let min = 255;
  let suma = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i] < min) min = data[i];
    suma += data[i];
  }
  const media = suma / data.length;
  const umbral = Math.min(200, Math.max(80, media - 0.35 * (media - min)));

  const y0 = Math.floor(H * 0.35);
  const tinta = new Array(W).fill(0);
  for (let y = y0; y < H; y++) {
    const fila = y * W;
    for (let x = 0; x < W; x++) if (data[fila + x] < umbral) tinta[x]++;
  }

  const minGap = Math.max(3, Math.round(W * 0.016));
  const bloques = [];
  let ini = null;
  let ultimaTinta = -1;
  for (let x = 0; x < W; x++) {
    if (tinta[x] > 1) {
      if (ini === null) ini = x;
      else if (x - ultimaTinta > minGap) {
        bloques.push({ ini, fin: ultimaTinta + 1 });
        ini = x;
      }
      ultimaTinta = x;
    }
  }
  if (ini !== null) bloques.push({ ini, fin: ultimaTinta + 1 });

  let columnas = bloques;
  if (bloques.length >= 2) {
    const anchos = bloques.map((b) => b.fin - b.ini).sort((a, b) => a - b);
    const mediana = anchos[Math.floor(anchos.length / 2)];
    if (bloques[0].fin - bloques[0].ini > mediana * 1.5) columnas = bloques.slice(1);
  }
  columnas = columnas.slice(0, 12);

  let bandas = 0;
  if (columnas.length > 0) {
    const xa = columnas[0].ini;
    const xb = columnas[columnas.length - 1].fin;
    let enBanda = false;
    let vacias = 0;
    for (let y = 0; y < H; y++) {
      let hay = false;
      for (let x = xa; x < xb; x++) {
        if (data[y * W + x] < umbral) {
          hay = true;
          break;
        }
      }
      if (hay) {
        if (!enBanda) {
          bandas++;
          enBanda = true;
        }
        vacias = 0;
      } else if (enBanda && ++vacias > 1) {
        enBanda = false;
      }
    }
  }

  const ok = columnas.length === 12 && bandas >= 5 && bandas <= 6;
  return {
    ok,
    motivo: ok ? "ok" : `columnas=${columnas.length} (esperadas 12), bandas de texto=${bandas} (esperadas 5 o 6: título, meses, FP, HP, Max)`,
    columnas,
    ancho: W,
  };
};

const elegirBox = async (base, boxIA) => {
  const candidatos = [];
  if (boxIA) candidatos.push(["IA", boxIA]);
  candidatos.push(["fijo", RECORTE_FIJO]);
  for (const [origen, b] of candidatos) {
    try {
      const an = await analizarTabla(base, b);
      console.log(`[recibo] recorte ${origen}: ${an.motivo}`);
      if (an.ok) return { box: b, an, origen };
    } catch (e) {
      console.warn(`[recibo] falló el análisis del recorte ${origen}:`, e.message);
    }
  }
  return { box: boxIA || RECORTE_FIJO, an: null, origen: boxIA ? "IA (sin validar)" : "fijo (sin validar)" };
};

// Parte la tabla en dos: 6 columnas de meses a cada lado, cortando entre la 6.ª y la 7.ª.
const partirEnMitades = async (base, box, an) => {
  let analisis = an;
  if (!analisis) {
    try {
      analisis = await analizarTabla(base, box);
    } catch {
      analisis = null;
    }
  }

  let finIzq;
  let iniDer;
  if (analisis && analisis.columnas.length === 12) {
    const c6 = analisis.columnas[5];
    const c7 = analisis.columnas[6];
    const corteX = (c6.fin + c7.ini) / 2;
    const aNorm = (x) => box.left + (x / analisis.ancho) * box.width;
    finIzq = aNorm(corteX);
    iniDer = aNorm(corteX);
    console.log(`[recibo] corte de la tabla en x=${Math.round(corteX)} de ${analisis.ancho}px (entre la columna 6 y la 7)`);
  } else {
    finIzq = box.left + box.width * 0.57;
    iniDer = box.left + box.width * 0.5;
    console.log("[recibo] corte aproximado de la tabla (no se detectaron las 12 columnas)");
  }
  return [
    { nombre: "mitad izquierda", box: { left: box.left, top: box.top, width: finIzq - box.left, height: box.height } },
    { nombre: "mitad derecha", box: { left: iniDer, top: box.top, width: box.left + box.width - iniDer, height: box.height } },
  ];
};

const tablaDesdeColumnas = (cols) => ({
  fp: Array.isArray(cols) ? cols.map((c) => c?.fp) : [],
  hp: Array.isArray(cols) ? cols.map((c) => c?.hp) : [],
});

// ── Lecturas del historial: Map(mesesAtrás -> { fp, hp }) ──
// mesesAtrás: 0 = mes facturado, 1 = mes anterior, ... 11 = hace 11 meses.

const limpiarPar = (rawFP, rawHP) => {
  const fp = entero(rawFP);
  const hp = entero(rawHP);
  if (fp != null && hp != null && hp >= fp) return { fp: null, hp: null };
  return { fp, hp };
};

const lecturaPorEtiqueta = (columnas, mesFacturado) => {
  const out = new Map();
  if (!Array.isArray(columnas) || mesFacturado == null) return out;

  const idx = columnas.map((c) => mesDeEtiqueta(c?.mes));
  for (let i = 1; i < idx.length; i++) if (idx[i] == null && idx[i - 1] != null) idx[i] = (idx[i - 1] + 1) % 12;
  for (let i = idx.length - 2; i >= 0; i--) if (idx[i] == null && idx[i + 1] != null) idx[i] = (idx[i + 1] + 11) % 12;

  const repetidos = new Set();
  columnas.forEach((c, i) => {
    if (idx[i] == null) return;
    const back = (mesFacturado - idx[i] + 12) % 12;
    if (out.has(back)) {
      repetidos.add(back);
      return;
    }
    out.set(back, limpiarPar(c?.fp, c?.hp));
  });
  repetidos.forEach((b) => out.delete(b));
  return out;
};

const lecturaPosicional = (rawFP, rawHP) => {
  const fp = Array.isArray(rawFP) ? rawFP : [];
  const hp = Array.isArray(rawHP) ? rawHP : [];
  if (fp.length !== hp.length || fp.length < 2) return null;
  const n = Math.min(fp.length, 12);
  const out = new Map();
  for (let i = 0; i < n; i++) {
    const k = fp.length - n + i;
    out.set(n - 1 - i, limpiarPar(fp[k], hp[k]));
  }
  return out;
};

const ganador = (valores) => {
  const cuentas = new Map();
  valores.filter((v) => v != null).forEach((v) => cuentas.set(v, (cuentas.get(v) || 0) + 1));
  if (cuentas.size === 0) return { valor: null, firme: false };
  const orden = [...cuentas.entries()].sort((a, b) => b[1] - a[1]);
  const [valor, votos] = orden[0];
  const empate = orden.length > 1 && orden[1][1] === votos;
  return { valor, firme: votos >= 2 && !empate };
};

const consensoTabla = (lecturas, nMin = 0) => {
  let maxBack = 0;
  lecturas.forEach((l) => l.forEach((_, b) => { if (b > maxBack) maxBack = b; }));
  const n = Math.max(maxBack + 1, nMin);
  const fpArr = [];
  const hpArr = [];
  const sinConsenso = [];
  const discrepancias = [];

  for (let i = 0; i < n; i++) {
    const back = n - 1 - i;
    const vFP = lecturas.map((l) => l.get(back)?.fp).filter((v) => v !== undefined);
    const vHP = lecturas.map((l) => l.get(back)?.hp).filter((v) => v !== undefined);
    const fp = ganador(vFP);
    const hp = ganador(vHP);
    fpArr.push(fp.valor);
    hpArr.push(hp.valor);

    const distintos = (v) => new Set(v.filter((x) => x != null)).size > 1;
    if (back > 0 && (distintos(vFP) || distintos(vHP))) {
      discrepancias.push({ mesesAtras: back, fp: vFP, hp: vHP });
    }
    if (back > 0 && (!fp.firme || !hp.firme)) sinConsenso.push(back);
  }

  return { n, fpArr, hpArr, sinConsenso, discrepancias, lecturas: lecturas.length };
};

// ── Verificación con el gráfico de barras del propio recibo (sin IA) ──
const medirBarrasRecibo = async (base) => {
  const { data, info } = await sharp(base)
    .resize({ width: 1132 })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const px = (x, y) => data[y * W + x];
  const xa = Math.round(W * 0.09);
  const xb = Math.round(W * 0.47);

  let baseY = null;
  for (let y = Math.round(H * 0.38); y < Math.round(H * 0.45); y++) {
    let c = 0;
    for (let x = xa; x < xb; x++) if (px(x, y) < 120) c++;
    if (c > (xb - xa) * 0.8) {
      baseY = y;
      break;
    }
  }
  if (baseY == null) return null;

  const yy = baseY - 3;
  const segs = [];
  let ini = null;
  for (let x = xa - 10; x < xb + 40; x++) {
    const on = px(x, yy) < 235;
    if (on && ini === null) ini = x;
    if (!on && ini !== null) {
      if (x - ini >= 8) segs.push([ini, x - 1]);
      ini = null;
    }
  }
  if (segs.length < 12 || segs.length > 14) return null;
  const anchos = segs.map(([p, q]) => q - p).sort((p, q) => p - q);
  if (anchos[anchos.length - 1] - anchos[0] > 6) return null;

  const alturas = segs.map(([p, q]) => {
    const vals = [];
    for (let x = p + 3; x <= q - 3; x++) {
      const mid = (px(x, yy) + 255) / 2;
      let y = yy;
      while (y > baseY - 260 && px(x, y - 1) < mid) y--;
      const oscuro = px(x, y);
      const claro = px(x, y - 1);
      const frac = (mid - oscuro) / Math.max(1, claro - oscuro);
      vals.push(baseY - (y - Math.min(1, Math.max(0, frac))));
    }
    vals.sort((m, n) => m - n);
    return vals[Math.floor(vals.length / 2)];
  });
  return alturas; // de izquierda a derecha; la última barra es el mes facturado
};

// Si la tabla de 12 meses no se pudo leer, se reconstruyen los 12 totales solo con el gráfico de barras.
// La última barra es el mes facturado (kWh exactos del detalle) y fija la escala kWh/píxel.
// El reparto HP/FP de los meses anteriores usa la proporción del mes facturado (aproximación).
const historialDesdeBarras = (alturas, kwhFP, kwhHP) => {
  if (!alturas || alturas.length < 12) return null;
  const ultima = alturas[alturas.length - 1];
  if (!(ultima > 5)) return null;
  const k = (kwhFP + kwhHP) / ultima;
  const shareHP = kwhHP / (kwhFP + kwhHP);
  const sel = alturas.slice(-12);
  const fpArr = [];
  const hpArr = [];
  sel.forEach((h, i) => {
    if (i === 11) {
      fpArr.push(kwhFP);
      hpArr.push(kwhHP);
      return;
    }
    const total = Math.round(h * k);
    const hp = Math.round(total * shareHP);
    hpArr.push(hp);
    fpArr.push(total - hp);
  });
  return { fpArr, hpArr };
};

// Dígitos que la IA suele confundir entre sí en texto pequeño
const CONFUSAS = { 0: "869", 1: "7", 2: "7", 3: "85", 4: "9", 5: "683", 6: "850", 7: "1", 8: "6309", 9: "804" };

const corregirConGrafico = (alturas, fpArr, hpArr, ilegibles) => {
  const n = fpArr.length;
  if (!alturas || alturas.length < n || n < 6) return null;
  const alt = (i) => alturas[alturas.length - n + i];
  const tot = (i) => fpArr[i] + hpArr[i];

  const ratios = [];
  for (let i = 0; i < n; i++) if (!ilegibles.includes(i) && alt(i) > 5) ratios.push(tot(i) / alt(i));
  if (ratios.length < 6) return null;
  ratios.sort((a, b) => a - b);
  const k = ratios[Math.floor(ratios.length / 2)];
  const k0 = tot(n - 1) / alt(n - 1);
  if (!Number.isFinite(k) || Math.abs(k / k0 - 1) > 0.03) return null;

  const fp = [...fpArr];
  const hp = [...hpArr];
  const corregidos = [];
  const dudosos = [];
  const rellenados = [];

  const shares = [];
  for (let i = 0; i < n - 1; i++) if (!ilegibles.includes(i)) shares.push(hp[i] / (fp[i] + hp[i]));
  const share = shares.reduce((s, v) => s + v, 0) / shares.length;

  for (let i = 0; i < n - 1; i++) {
    const barra = alt(i) * k;
    if (ilegibles.includes(i)) {
      const h = Math.round(barra * share);
      hp[i] = h;
      fp[i] = Math.round(barra) - h;
      rellenados.push(i);
      continue;
    }
    const err = Math.abs(barra - tot(i));
    if (err <= 0.7 * k) continue;

    let mejor = null;
    for (const campo of ["fp", "hp"]) {
      const v = campo === "fp" ? fp[i] : hp[i];
      const str = String(v);
      for (let pos = 0; pos < str.length; pos++) {
        for (const c of CONFUSAS[str[pos]] || "") {
          if (pos === 0 && c === "0") continue;
          const nuevo = Number(str.slice(0, pos) + c + str.slice(pos + 1));
          const nfp = campo === "fp" ? nuevo : fp[i];
          const nhp = campo === "hp" ? nuevo : hp[i];
          if (nhp >= nfp) continue;
          const e = Math.abs(barra - (nfp + nhp));
          if (!mejor || e < mejor.e) mejor = { campo, nuevo, e };
        }
      }
    }
    if (mejor && mejor.e <= 0.4 * k && mejor.e < err * 0.5) {
      if (mejor.campo === "fp") fp[i] = mejor.nuevo;
      else hp[i] = mejor.nuevo;
      corregidos.push(i);
    } else if (err > 1.5 * k) {
      dudosos.push(i);
    }
  }
  return { fpArr: fp, hpArr: hp, corregidos, dudosos, rellenados };
};

const validarTabla = (rawFP, rawHP, kwhFPActual, kwhHPActual) => {
  const listFP = Array.isArray(rawFP) ? rawFP.map(num) : [];
  const listHP = Array.isArray(rawHP) ? rawHP.map(num) : [];
  const n = Math.min(listFP.length, listHP.length, 12);

  if (n < 2) return { ok: false, motivo: `tabla muy corta (FP=${listFP.length}, HP=${listHP.length})` };

  const fpArr = listFP.slice(listFP.length - n);
  const hpArr = listHP.slice(listHP.length - n);

  const cercano = (x, ref, tol) => Math.abs(x - ref) / ref <= tol;
  const last = n - 1;

  if (
    (fpArr[last] != null && !cercano(fpArr[last], kwhFPActual, 0.1)) ||
    (hpArr[last] != null && !cercano(hpArr[last], kwhHPActual, 0.1))
  ) {
    return {
      ok: false,
      motivo: `el último mes de la tabla (FP ${fpArr[last]}, HP ${hpArr[last]}) no coincide con el facturado (FP ${kwhFPActual}, HP ${kwhHPActual})`,
      fpArr,
      hpArr,
    };
  }
  fpArr[last] = kwhFPActual;
  hpArr[last] = kwhHPActual;

  const totalActual = kwhHPActual + kwhFPActual;
  const ilegibles = [];
  for (let i = 0; i < last; i++) {
    const fp = fpArr[i];
    const hp = hpArr[i];
    const t = (fp ?? 0) + (hp ?? 0);
    if (fp == null || hp == null || hp >= fp || t < totalActual * 0.2 || t > totalActual * 5) {
      ilegibles.push(i);
    }
  }

  const legibles = n - ilegibles.length;
  if (legibles < 6) {
    return { ok: false, motivo: `solo ${legibles} de ${n} meses legibles`, fpArr, hpArr };
  }

  return { ok: true, motivo: "ok", fpArr, hpArr, ilegibles };
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

    const energiaActual =
      (importeHP ?? kwhHPActual * tarifaHP) + (importeFP ?? kwhFPActual * tarifaFP);

    const totalLeido = num(a.totalPagar) ?? num(a.subtotalMes);
    const totalActual =
      totalLeido && totalLeido >= energiaActual * 0.99 && totalLeido <= energiaActual * 6
        ? totalLeido
        : null;
    const factorFactura = totalActual ? totalActual / energiaActual : null;

    const ultimos = Array.isArray(parsed.ultimosMeses)
      ? parsed.ultimosMeses.map((x) => num(x?.total))
      : [];
    const totalRealMes = (back, energiaMes) => {
      if (back === 0) return totalActual;
      if (back > ultimos.length) return null;
      const v = ultimos[ultimos.length - back];
      if (!v || !factorFactura) return v || null;
      const ratio = v / (energiaMes * factorFactura);
      return ratio >= 0.5 && ratio <= 2 ? v : null;
    };

    // ── Últimos 12 meses: lectura por mitades + consenso por columna ──
    const fechaActual = parseDMY(a.fechaLecturaActual);
    const mesFacturado = fechaActual ? fechaActual.getUTCMonth() : null;
    const nMin = mesFacturado != null ? 12 : 0;

    const lecturaInicialAlineada = lecturaPosicional(parsed.historialFP, parsed.historialHP);
    const lecturaInicial =
      lecturaInicialAlineada && lecturaInicialAlineada.size === 12 ? lecturaInicialAlineada : null;

    const lecturasRecorte = [];
    const juntarLecturas = () => [...lecturasRecorte, ...(lecturaInicial ? [lecturaInicial] : [])];
    let baseImg = null;
    let consenso = null;
    const evaluar = () => {
      const todas = juntarLecturas();
      if (todas.length < 2) return false;
      consenso = consensoTabla(todas, nMin);
      return consenso.sinConsenso.length === 0;
    };

    try {
      const { base, thumbUrl } = await prepararBase(file.buffer);
      baseImg = base;
      const boxIA = await ubicarTabla(thumbUrl);
      const { box, an, origen } = await elegirBox(base, boxIA);
      console.log(`[recibo] recorte de la tabla (${origen}):`, JSON.stringify(box));
      const variantes = [
        { nombre: "gris", zoom: 5, nitida: false },
        { nombre: "nítida", zoom: 7, nitida: true },
        { nombre: "gris grande", zoom: 8, nitida: false },
      ].slice(0, MAX_VARIANTES);

      if (mesFacturado != null) {
        const mitades = await partirEnMitades(base, box, an);
        for (const v of variantes) {
          const resultados = await Promise.all(
            mitades.map(async (m) => {
              try {
                const img = await recortarConBox(base, m.box, v);
                const r = await callVision(img, HALF_PROMPT);
                console.log(`[recibo] ${m.nombre} (${v.nombre}):`, JSON.stringify(r));
                return lecturaPorEtiqueta(r.columnas, mesFacturado);
              } catch (e) {
                console.warn(`[recibo] falló ${m.nombre} (${v.nombre}):`, e.message);
                return null;
              }
            })
          );
          resultados.forEach((l) => {
            if (l && l.size > 0) lecturasRecorte.push(l);
          });
          if (evaluar()) break;
        }
      } else {
        for (const v of variantes) {
          try {
            const img = await recortarConBox(base, box, v);
            const r = await callVision(img, HISTORY_PROMPT);
            console.log(`[recibo] tabla completa (${v.nombre}):`, JSON.stringify(r));
            const { fp, hp } = tablaDesdeColumnas(r.columnas);
            const l = lecturaPosicional(fp, hp);
            if (l && l.size === 12) lecturasRecorte.push(l);
          } catch (e) {
            console.warn(`[recibo] falló la tabla completa (${v.nombre}):`, e.message);
          }
          if (evaluar()) break;
        }
      }
    } catch (e) {
      console.warn("[recibo] falló la lectura reforzada del historial:", e.message);
    }

    if (!consenso) {
      const todas = juntarLecturas();
      if (todas.length > 0) consenso = consensoTabla(todas, nMin);
      else if (lecturaInicialAlineada) consenso = consensoTabla([lecturaInicialAlineada], nMin);
    }
    const verificada = juntarLecturas().length >= 2;

    if (consenso) {
      console.log(
        `[recibo] consenso con ${consenso.lecturas} lectura(s). Discrepancias:`,
        JSON.stringify(consenso.discrepancias),
        "Sin consenso (meses atrás):",
        JSON.stringify(consenso.sinConsenso)
      );
    }

    let tabla;
    if (consenso && consenso.n >= 2) {
      tabla = validarTabla(consenso.fpArr, consenso.hpArr, kwhFPActual, kwhHPActual);
      if (!tabla.ok) console.warn("[recibo] tabla descartada tras el consenso:", tabla.motivo);
    } else {
      tabla = { ok: false, motivo: "no se pudo leer la tabla" };
    }

    let n, fpArr, hpArr, warning = null;
    let ilegibles = [];
    let corregidosPos = [];
    let dudososGrafico = [];
    let rellenadosPos = [];
    let desdeBarras = false; // true si el historial se reconstruyó solo con el gráfico de barras

    const alturasCache = { v: undefined };
    const obtenerAlturas = async () => {
      if (alturasCache.v === undefined) {
        try {
          const baseV = baseImg || (await sharp(file.buffer).rotate().toBuffer());
          alturasCache.v = await medirBarrasRecibo(baseV);
        } catch (e) {
          console.warn("[recibo] falló la medición del gráfico:", e.message);
          alturasCache.v = null;
        }
      }
      return alturasCache.v;
    };

    if (tabla.ok) {
      n = tabla.fpArr.length;
      fpArr = [...tabla.fpArr];
      hpArr = [...tabla.hpArr];
      ilegibles = tabla.ilegibles || [];

      try {
        const alturas = await obtenerAlturas();
        const v = corregirConGrafico(alturas, fpArr, hpArr, ilegibles);
        console.log("[recibo] verificación con el gráfico de barras:", v ? JSON.stringify({ corregidos: v.corregidos, dudosos: v.dudosos, rellenados: v.rellenados }) : "no disponible");
        if (v) {
          fpArr = v.fpArr;
          hpArr = v.hpArr;
          corregidosPos = v.corregidos;
          dudososGrafico = v.dudosos;
          ilegibles = ilegibles.filter((i) => !v.rellenados.includes(i));
          rellenadosPos = v.rellenados;
        }
      } catch (e) {
        console.warn("[recibo] falló la verificación con el gráfico:", e.message);
      }

      if (ilegibles.length > 0) {
        const buenos = fpArr.map((_, i) => i).filter((i) => i < n - 1 && !ilegibles.includes(i) && fpArr[i] != null);
        const prom = (arr) => arr.reduce((s, v) => s + v, 0) / arr.length;
        const promFP = Math.round(prom(buenos.map((i) => fpArr[i])));
        const promHP = Math.round(prom(buenos.map((i) => hpArr[i])));
        ilegibles.forEach((i) => {
          fpArr[i] = promFP;
          hpArr[i] = promHP;
        });
      }
      if (n < 12) {
        warning = `Solo se pudieron leer ${n} de 12 meses del historial. La proyección usará el promedio disponible.`;
      }
    } else {
      // Plan B: reconstruir los 12 meses con el gráfico de barras del recibo.
      const alturas = await obtenerAlturas();
      const reconstruido = historialDesdeBarras(alturas, kwhFPActual, kwhHPActual);
      if (reconstruido) {
        desdeBarras = true;
        n = 12;
        fpArr = reconstruido.fpArr;
        hpArr = reconstruido.hpArr;
        rellenadosPos = Array.from({ length: 11 }, (_, i) => i); // todos menos el mes facturado
        console.log("[recibo] historial reconstruido solo con el gráfico de barras");
        warning =
          "No se pudo leer la tabla de 12 meses (" + tabla.motivo + "). " +
          "Los consumos anteriores se calcularon a partir del gráfico de barras del recibo (aproximados) y el reparto HP/FP usa la proporción del mes facturado.";
      } else {
        n = 1;
        fpArr = [kwhFPActual];
        hpArr = [kwhHPActual];
        warning =
          "No se pudo leer el historial de 12 meses del recibo (" + tabla.motivo + "). " +
          "Se muestra solo el mes facturado; sube una imagen más nítida para ver el consumo anual real.";
      }
    }

    const historialValido = tabla.ok || desdeBarras;

    const dudosos = [
      ...(tabla.ok && consenso ? consenso.sinConsenso : []),
      ...dudososGrafico.map((i) => n - 1 - i),
    ];
    const estimadosBack = new Set([...ilegibles, ...rellenadosPos].map((i) => n - 1 - i));
    const corregidosBack = new Set(corregidosPos.map((i) => n - 1 - i));

    // ── Etiquetas de mes calculadas desde la fecha de lectura (no dependen de la IA) ──
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

      // El mes facturado siempre usa los kWh exactos del detalle del recibo
      const hp = back === 0 ? kwhHPActual : hpArr[i];
      const fp = back === 0 ? kwhFPActual : fpArr[i];

      const energiaMes = round2(back === 0 ? energiaActual : hp * tarifaHP + fp * tarifaFP);

      const real = totalRealMes(back, energiaMes);
      let costoTotal = null;
      let totalEsEstimado = false;
      if (real) {
        costoTotal = round2(real);
      } else if (factorFactura) {
        costoTotal = round2(energiaMes * factorFactura);
        totalEsEstimado = true;
      }

      const kwhTotal = round2(hp + fp);

      history.push({
        period,
        name: period, // el frontend usa "name" para la etiqueta del mes
        dias,
        kwhHP: round2(hp),
        kwhFP: round2(fp),
        kwhTotal,
        kWh: kwhTotal, // mismo valor que kwhTotal (la gráfica lo usa como respaldo)
        costoHP: back === 0 ? importeHP : null,
        costoFP: back === 0 ? importeFP : null,
        costoEnergia: energiaMes,
        costoTotal,
        totalEsEstimado,
        lecturaEstimada: estimadosBack.has(back),
        lecturaCorregida: corregidosBack.has(back),
        lecturaDudosa: dudosos.includes(back) || estimadosBack.has(back),
      });
    }

    // Para comparar con lo que pinta el gráfico del frontend
    console.log("[recibo] history final:", JSON.stringify(history.map((h) => [h.period, h.kwhTotal])));

    // Control de cordura: el último mes del historial debe ser igual al kWh del detalle
    const kwhMesFacturado = round2(kwhHPActual + kwhFPActual);
    const ultimoHist = history[history.length - 1];
    if (ultimoHist && Math.abs(ultimoHist.kwhTotal - kwhMesFacturado) > 0.5) {
      console.warn(
        `[recibo] OJO: el último mes del historial (${ultimoHist.kwhTotal}) no coincide con el facturado (${kwhMesFacturado})`
      );
    }

    // Datos listos para la gráfica del frontend
    const chartData = history.map((h) => ({
      name: h.period,
      kWh: h.kwhTotal,
      kwhHP: h.kwhHP,
      kwhFP: h.kwhFP,
      dias: h.dias,
    }));

    const mesesEstimados = history.filter((h) => h.lecturaEstimada).map((h) => h.period);
    const mesesCorregidos = history.filter((h) => h.lecturaCorregida).map((h) => h.period);
    const mesesDudosos = history.filter((h) => h.lecturaDudosa && !h.lecturaEstimada).map((h) => h.period);
    const agregarAviso = (aviso) => {
      warning = warning ? `${warning} ${aviso}` : aviso;
    };
    if (tabla.ok && mesesCorregidos.length > 0) {
      agregarAviso(`Se corrigió automáticamente la lectura de: ${mesesCorregidos.join(", ")} (contrastada con el gráfico de barras del recibo).`);
    }
    const nombreMes = (pos) => history[pos]?.period;
    const mesesDeBarra = rellenadosPos.map(nombreMes).filter(Boolean);
    const mesesPromedio = ilegibles.map(nombreMes).filter(Boolean);
    if (tabla.ok && mesesDeBarra.length > 0) {
      agregarAviso(`El consumo de ${mesesDeBarra.join(", ")} no se leía en la tabla y se calculó a partir del gráfico de barras del recibo.`);
    }
    if (tabla.ok && mesesPromedio.length > 0) {
      agregarAviso(`No se pudo leer el consumo de: ${mesesPromedio.join(", ")}. Se estimó con el promedio de los demás meses; revísalo contra el recibo.`);
    }
    if (tabla.ok && mesesDudosos.length > 0) {
      agregarAviso(`No se pudo confirmar la lectura de: ${mesesDudosos.join(", ")}. Revisa esos meses contra el recibo.`);
    }
    if (tabla.ok && !verificada) {
      agregarAviso("El historial se leyó una sola vez y no se pudo contrastar con una segunda lectura.");
    }
    if (!factorFactura) {
      agregarAviso("No se pudo leer el Total a pagar del recibo; el costo mostrado incluye solo energía activa.");
    }

    // ── Meta de ahorro de la empresa ──
    const ahorroRaw = req.body?.ahorroMeta;
    const ahorroNum = ahorroRaw === undefined || ahorroRaw === "" ? NaN : Number(ahorroRaw);
    const ahorroMeta = Number.isFinite(ahorroNum) ? Math.min(100, Math.max(0, ahorroNum)) : null;

    if (boardId) {
      await Board.findByIdAndUpdate(boardId, {
        $set: {
          "energyRates.tarifaHP": tarifaHP,
          "energyRates.tarifaFP": tarifaFP,
          "energyRates.history": history,
          "energyRates.updatedAt": new Date(),
          ...(ahorroMeta !== null && { "energyRates.ahorroMeta": ahorroMeta }),
        },
      });
    }

    return res.status(200).json({
      success: true,
      message: "Recibo analizado y guardado exitosamente.",
      data: {
        tarifaHP,
        tarifaFP,
        history,
        chartData,
        historyOk: historialValido && n >= 12,
        historyAproximado: desdeBarras,
        kwhMesFacturado, // p. ej. 93968: el frontend no debe sumar nada
        kwhHistorial: round2(history.reduce((s, h) => s + h.kwhTotal, 0)),
        mesesDudosos,
        mesesEstimados,
        mesesCorregidos,
        totalActual,
        factorFactura: factorFactura ? Math.round(factorFactura * 1000) / 1000 : null,
        ahorroMeta,
        warning,
      },
    });
  } catch (error) {
    console.error("Error al procesar recibo en OpenAI:", error);
    return res.status(500).json({
      error: "Error interno al analizar el recibo de luz: " + error.message,
    });
  }
};

// ── Actualiza solo la meta de ahorro, sin volver a subir el recibo ──
export const updateAhorroMeta = async (req, res) => {
  try {
    const { boardId } = req.params;
    const n = Number(req.body?.ahorroMeta);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      return res.status(400).json({ error: "La meta de ahorro debe estar entre 0 y 100." });
    }
    const board = await Board.findByIdAndUpdate(
      boardId,
      { $set: { "energyRates.ahorroMeta": n } },
      { new: true }
    );
    if (!board) return res.status(404).json({ error: "Tablero no encontrado." });
    return res.status(200).json({ success: true, ahorroMeta: n });
  } catch (error) {
    return res.status(500).json({ error: "Error al guardar la meta de ahorro: " + error.message });
  }
};