import mongoose from "mongoose";

const annualMeasurementSchema = new mongoose.Schema(
  {
    año: { 
      type: String, 
      required: true 
    },
    resistencia: { 
      type: Number, 
      required: true 
    },
    fuga: { 
      type: Number, 
      required: true 
    },
    diametro: { 
      type: Number, 
      default: 14.6 
    },
    ph: { 
      type: Number, 
      default: 6.1 
    },
    images: {
      caja: { type: String, default: null },
      telurometro: { type: String, default: null },
      fuga: { type: String, default: null },
    },
    measuredAt: { 
      type: Date, 
      default: Date.now 
    },
  },
  { _id: true }
);

const spatSchema = new mongoose.Schema(
  {
    companyPublicCode: { 
      type: String, 
      required: true, 
      index: true 
    },
    pozoCode: { 
      type: String, 
      required: true, 
      trim: true, 
      index: true 
    },
    name: { 
      type: String, 
      default: "" 
    },
    location: { 
      type: String, 
      default: "Instalación Principal" 
    },
    certificateCode: {
      type: String,
      default: () => `GES-SPAT-CERT-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`,
    },
    // Lista histórica de años medidos (solo años reales)
    measurements: {
      type: [annualMeasurementSchema],
      default: [],
    },
    createdBy: { 
      type: mongoose.Schema.Types.ObjectId, 
      ref: "User", 
      required: false 
    },
  },
  { timestamps: true }
);

spatSchema.index({ companyPublicCode: 1, pozoCode: 1 }, { unique: true });

export default mongoose.model("Spat", spatSchema);