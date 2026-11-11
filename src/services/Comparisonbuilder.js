import { COST_NAMES } from "./Billextractor.js";

const MES = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
const httpError = (status, message) => Object.assign(new Error(message), { status });

const toIdx = (ym) => {
  const [y, m] = ym.split("-").map(Number);
  return y * 12 + (m - 1);
};
const monthOf = (i) => i % 12;
const yearOf = (i) => Math.floor(i / 12);

// El frontend lee el año del primer mes ("Dic-24" o "Abr-25"); el resto llevan el mes (y año en enero)
const label = (i, first) =>
  first || monthOf(i) === 0 ? `${MES[monthOf(i)]}-${String(yearOf(i)).slice(2)}` : MES[monthOf(i)];

export function buildComparison(base, cur) {
  if (toIdx(base.periodMonth) > toIdx(cur.periodMonth)) {
    [base, cur] = [cur, base];
  }

  const i0 = toIdx(base.periodMonth);
  const i1 = toIdx(cur.periodMonth);
  if (i1 === i0) throw httpError(422, "El recibo base debe ser de un mes anterior al recibo actual.");
  if (i1 - i0 > 36) throw httpError(422, "Los dos recibos no pueden distanciarse más de 36 meses.");

  const data = new Map();
  const put = (idx, p) => {
    const prev = data.get(idx) ?? {};
    for (const k of ["fp", "hp", "kw"]) {
      if (p[k] != null && p[k] > 0) prev[k] = p[k];
    }
    data.set(idx, prev);
  };

  for (const b of [base, cur]) {
    for (const h of b.history || []) {
      put(toIdx(h.month), { fp: h.kwhFp, hp: h.kwhHp, kw: h.maxKw });
    }
  }
  for (const b of [base, cur]) {
    put(toIdx(b.periodMonth), { fp: b.kwhFp, hp: b.kwhHp, kw: b.maxKw });
  }

  // Empieza en el mes más antiguo con dato disponible en los recibos (incluyendo 2024 o cualquier año base)
  let start = i0;
  for (const k of data.keys()) {
    if (k < start) start = k;
  }

  const months = [], kwhFp = [], kwhHp = [], maxKw = [];
  for (let i = start; i <= i1; i++) {
    const d = data.get(i) ?? {};
    months.push(label(i, i === start));
    kwhFp.push(d.fp ?? 0);
    kwhHp.push(d.hp ?? 0);
    maxKw.push(d.kw ?? 0);
  }

  const contractedKw = cur.contractedKw ?? base.contractedKw;
  if (!contractedKw) throw httpError(422, "No se pudo leer la potencia contratada en los recibos.");

  const costItems = COST_NAMES.filter((n) => cur.costs[n] || base.costs[n]).map((name) => ({
    name,
    value: cur.costs[name] ?? 0,
    baseValue: base.costs[name] ?? 0,
    power: name.startsWith("Potencia"),
  }));
  const sum = (o) => Object.values(o).reduce((s, v) => s + v, 0);

  const warnings = [...(base.warnings || []), ...(cur.warnings || [])];
  if (base.supplyNumber && cur.supplyNumber && base.supplyNumber !== cur.supplyNumber) {
    warnings.unshift(
      `Atención: Estás comparando suministros distintos (${base.supplyNumber} vs. ${cur.supplyNumber}).`
    );
  }

  return {
    distributor: cur.distributor ?? base.distributor ?? "",
    supplyNumber: cur.supplyNumber ?? base.supplyNumber ?? undefined,
    baseLabel: label(i0, true),
    currentLabel: label(i1, true),
    metrics: {
      contractedKw,
      months,
      kwhFp,
      kwhHp,
      maxKw,
      baseIndex: i0 - start,
      costItems,
      totalBill: cur.totalBill ?? Math.round(sum(cur.costs) * 100) / 100,
      baseTotalBill: base.totalBill ?? Math.round(sum(base.costs) * 100) / 100,
    },
    warnings,
  };
}