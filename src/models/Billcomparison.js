import mongoose from "mongoose";

const FileSchema = new mongoose.Schema(
  {
    name: String,
    url: String, // URL de Cloudinary
    publicId: String, // para poder borrarlo/reemplazarlo en Cloudinary
    file: String, // legacy: recibos antiguos guardados en disco
  },
  { _id: false }
);

const schema = new mongoose.Schema(
  {
    cid: { type: String, required: true, unique: true }, // id que genera el frontend (cmp-123...)
    code: { type: String, required: true },
    title: { type: String, default: "" },
    companyCode: { type: String, index: true },
    distributor: String,
    supplyNumber: String,
    baseLabel: String,
    currentLabel: String,
    bills: { a: FileSchema, b: FileSchema },
    extracted: { a: mongoose.Schema.Types.Mixed, b: mongoose.Schema.Types.Mixed }, // lectura de OpenAI por recibo
    metrics: mongoose.Schema.Types.Mixed,
    warnings: [String],
    source: { type: String, default: "pdf" },
  },
  { timestamps: true }
);

schema.index({ companyCode: 1, code: 1 }, { unique: true });

export default mongoose.model("BillComparison", schema);