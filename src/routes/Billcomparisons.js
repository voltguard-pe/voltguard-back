import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import express from "express";
import multer from "multer";
import cloudinary from "../config/cloudinary.js";
import BillComparison from "../models/Billcomparison.js";
import { extractBill } from "../services/Billextractor.js";
import { buildComparison } from "../services/Comparisonbuilder.js";

// Solo se usa para limpiar recibos antiguos que aún estén en disco (legacy)
export const UPLOAD_DIR = path.resolve(process.env.BILL_UPLOAD_DIR || "uploads/bills");

const FOLDER = process.env.CLOUDINARY_BILLS_FOLDER || "recibos-luz";

/** Sube un Buffer PDF a Cloudinary (como "raw") y devuelve { url, publicId }. */
function uploadPdf(buffer) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { resource_type: "raw", folder: FOLDER, public_id: `${crypto.randomUUID()}.pdf` },
      (err, r) => (err ? reject(err) : resolve({ url: r.secure_url, publicId: r.public_id }))
    );
    stream.end(buffer);
  });
}

const deletePdf = (publicId) =>
  publicId
    ? cloudinary.uploader.destroy(publicId, { resource_type: "raw" }).catch(() => {})
    : Promise.resolve();

const rmLegacy = (name) => (name ? fs.unlink(path.join(UPLOAD_DIR, name)).catch(() => {}) : Promise.resolve());

// Sube varios buffers; si alguno falla, borra los que sí subieron y lanza el error
async function uploadAll(buffers) {
  const settled = await Promise.allSettled(buffers.map(uploadPdf));
  const ok = settled.filter((s) => s.status === "fulfilled").map((s) => s.value);
  const failed = settled.find((s) => s.status === "rejected");
  if (failed) {
    await Promise.all(ok.map((u) => deletePdf(u.publicId)));
    throw Object.assign(new Error(`No se pudo subir el PDF a Cloudinary: ${failed.reason?.message}`), { status: 502 });
  }
  return ok;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, file.mimetype === "application/pdf"),
});

const router = express.Router();

const toClient = (d, req) => {
  const host = (process.env.PUBLIC_API_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
  const bill = (f) => {
    if (f?.url) return { name: f.name, url: f.url };
    if (f?.file) return { name: f.name, url: `${host}/uploads/bills/${f.file}` }; // legacy
    return null;
  };
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

// Crear: lee los 2 PDF en memoria con OpenAI y, solo si todo sale bien, los sube a Cloudinary
router.post("/", upload.fields([{ name: "fileA", maxCount: 1 }, { name: "fileB", maxCount: 1 }]), async (req, res, next) => {
  const fa = req.files?.fileA?.[0];
  const fb = req.files?.fileB?.[0];
  let uploaded = [];
  try {
    if (!fa || !fb) throw Object.assign(new Error("Faltan los dos PDF."), { status: 400 });
    const { id, code, title, companyCode } = req.body;
    if (!id || !code?.trim()) throw Object.assign(new Error("Falta el código del comparativo."), { status: 400 });

    const [a, b] = await Promise.all([extractBill(fa.buffer), extractBill(fb.buffer)]);
    const built = buildComparison(a, b);

    uploaded = await uploadAll([fa.buffer, fb.buffer]);

    const doc = await BillComparison.create({
      cid: id,
      code: code.trim(),
      title: (title || "").trim(),
      companyCode,
      distributor: built.distributor,
      supplyNumber: built.supplyNumber,
      baseLabel: built.baseLabel,
      currentLabel: built.currentLabel,
      bills: {
        a: { name: fa.originalname, url: uploaded[0].url, publicId: uploaded[0].publicId },
        b: { name: fb.originalname, url: uploaded[1].url, publicId: uploaded[1].publicId },
      },
      extracted: { a, b },
      metrics: built.metrics,
      warnings: built.warnings,
    });
    res.status(201).json(toClient(doc, req));
  } catch (e) {
    await Promise.all(uploaded.map((u) => deletePdf(u.publicId)));
    if (e.code === 11000) e = Object.assign(new Error("Ya existe un comparativo con este código."), { status: 409 });
    next(e);
  }
});

// Cambiar un PDF: re-lee solo ese recibo, lo sube a Cloudinary y recalcula
router.put("/:id/bill/:slot", upload.single("file"), async (req, res, next) => {
  const f = req.file;
  let uploaded = null;
  try {
    const { id, slot } = req.params;
    if (!["a", "b"].includes(slot) || !f) throw Object.assign(new Error("Solicitud inválida."), { status: 400 });
    const doc = await BillComparison.findOne({ cid: id });
    if (!doc) throw Object.assign(new Error("Comparativo no encontrado."), { status: 404 });

    const fresh = await extractBill(f.buffer);
    const extracted = { a: doc.extracted.a, b: doc.extracted.b, [slot]: fresh };
    const built = buildComparison(extracted.a, extracted.b);

    [uploaded] = await uploadAll([f.buffer]);

    const old = doc.bills[slot];
    doc.bills[slot] = { name: f.originalname, url: uploaded.url, publicId: uploaded.publicId };
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

    // Limpiar el PDF anterior (Cloudinary o legacy en disco)
    if (old?.publicId) await deletePdf(old.publicId);
    else if (old?.file) await rmLegacy(old.file);

    res.json(toClient(doc, req));
  } catch (e) {
    if (uploaded) await deletePdf(uploaded.publicId);
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