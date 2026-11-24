import mongoose from "mongoose";

const { Schema, model } = mongoose;

// Colección propia de informes ("reports"), independiente de los documentos ITSE.
const reportSchema = new Schema(
  {
    title: { type: String, required: true, trim: true },
    cloudinaryUrl: { type: String, required: true },
    cloudinaryPublicId: { type: String, required: true },
    cloudinaryResourceType: { type: String, default: "image" },

    // ⚠️ Ajusta "Company" al nombre con el que registraste tu modelo de empresa
    company: { type: Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    companyPublicCode: { type: String, required: true, index: true },
  },
  { timestamps: true } // createdAt y updatedAt (el frontend usa createdAt)
);

export default model("Report", reportSchema);
