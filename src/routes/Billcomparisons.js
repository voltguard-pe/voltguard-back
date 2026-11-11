import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import express from "express";
import multer from "multer";
import BillComparison from "../models/Billcomparison.js";
import { extractBill } from "../services/Billextractor.js";
import { buildComparison } from "../services/comparisonBuilder.js";

export const UPLOAD_DIR = path.resolve(process.env.BILL_UPLOAD_DIR || "uploads/bills");
await fs.mkdir(UPLOAD_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, _file, cb) => cb(null, `${crypto.randomUUID()}.pdf`),
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, file.mimetype === "application/pdf"),
});

const router = express.Router();
const rm = (p) => fs.unlink(p).catch(() => {});

const toClient = (d, req) => {
  const host = (process.env.PUBLIC_API_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
  const bill = (f) => (f?.file ? { name: f.name, url: `${host}/uploads/bills/${f.file}` } : null);
  return {
    id: d.cid,
    code: d.code,
    title: d.title,
    companyCode: d.companyCode,
    distributor: d.distributor,
    supplyNumber: d.supplyNumber,
    baseLabel: d.baseLabel,
    currentLabel: d.currentLabel,
    bills: { a: bill(d.bills?.a), b: bill(d.bills?.b) },
    metrics: d.metrics,
    warnings: d.warnings,
    source: "pdf",
  };
};

// Listar
router.get("/", async (req, res, next) => {
  try {
    const filter = req.query.companyCode ? { companyCode: String(req.query.companyCode) } : {};
    const docs = await BillComparison.find(filter).sort({ createdAt: -1 });
    res.json(docs.map((d) => toClient(d, req)));
  } catch (e) { next(e); }
});

// Crear: sube los 2 PDF, los lee con OpenAI y arma las métricas
router.post("/", upload.fields([{ name: "fileA", maxCount: 1 }, { name: "fileB", maxCount: 1 }]), async (req, res, next) => {
  const fa = req.files?.fileA?.[0];
  const fb = req.files?.fileB?.[0];
  try {
    if (!fa || !fb) throw Object.assign(new Error("Faltan los dos PDF."), { status: 400 });
    const { id, code, title, companyCode } = req.body;
    if (!id || !code?.trim()) throw Object.assign(new Error("Falta el código del comparativo."), { status: 400 });

    const [a, b] = await Promise.all([extractBill(fa.path), extractBill(fb.path)]);
    const built = buildComparison(a, b);

    const doc = await BillComparison.create({
      cid: id,
      code: code.trim(),
      title: (title || "").trim(),
      companyCode,
      distributor: built.distributor,
      supplyNumber: built.supplyNumber,
      baseLabel: built.baseLabel,
      currentLabel: built.currentLabel,
      bills: { a: { name: fa.originalname, file: fa.filename }, b: { name: fb.originalname, file: fb.filename } },
      extracted: { a, b },
      metrics: built.metrics,
      warnings: built.warnings,
    });
    res.status(201).json(toClient(doc, req));
  } catch (e) {
    await Promise.all([fa && rm(fa.path), fb && rm(fb.path)]);
    if (e.code === 11000) e = Object.assign(new Error("Ya existe un comparativo con este código."), { status: 409 });
    next(e);
  }
});

// Cambiar un PDF: re-lee solo ese recibo y recalcula
router.put("/:id/bill/:slot", upload.single("file"), async (req, res, next) => {
  const f = req.file;
  try {
    const { id, slot } = req.params;
    if (!["a", "b"].includes(slot) || !f) throw Object.assign(new Error("Solicitud inválida."), { status: 400 });
    const doc = await BillComparison.findOne({ cid: id });
    if (!doc) throw Object.assign(new Error("Comparativo no encontrado."), { status: 404 });

    const fresh = await extractBill(f.path);
    const extracted = { a: doc.extracted.a, b: doc.extracted.b, [slot]: fresh };
    const built = buildComparison(extracted.a, extracted.b);

    const oldFile = doc.bills[slot]?.file;
    doc.bills[slot] = { name: f.originalname, file: f.filename };
    doc.extracted = extracted;
    doc.metrics = built.metrics;
    doc.warnings = built.warnings;
    doc.baseLabel = built.baseLabel;
    doc.currentLabel = built.currentLabel;
    doc.distributor = built.distributor;
    doc.supplyNumber = built.supplyNumber;
    doc.markModified("extracted");
    doc.markModified("metrics");
    await doc.save();

    if (oldFile) await rm(path.join(UPLOAD_DIR, oldFile));
    res.json(toClient(doc, req));
  } catch (e) {
    if (f) await rm(f.path);
    next(e);
  }
});

// El frontend lee el cuerpo como texto cuando hay error
router.use((err, _req, res, _next) => {
  console.error(err);
  const status = err.status || (err.code === "LIMIT_FILE_SIZE" ? 413 : 500);
  res.status(status).type("text").send(
    err.code === "LIMIT_FILE_SIZE" ? "Cada PDF debe pesar máximo 15 MB." : err.message || "Error interno"
  );
});

export default router;