import mongoose from "mongoose";

const HotspotSchema = new mongoose.Schema(
  {
    id: { type: String, required: true }, // Ej: "HS-01"
    panelId: { type: String, default: "Desconocido" }, // Ej: "A2-06"
    cellLocation: { type: String, default: "Celda identificada" },
    x: { type: Number, required: true }, // Coordenada X porcentual (0 - 100%)
    y: { type: Number, required: true }, // Coordenada Y porcentual (0 - 100%)
    tSpot: { type: Number, required: true },
    tNormal: { type: Number, required: true },
    deltaT: { type: Number, required: true },
    status: {
      type: String,
      enum: ["WARNING", "CRITICAL"],
      required: true,
    },
    visualCause: { type: String, default: "Mancha / Celda inversa" },
    action: { type: String, required: true }, // "CAMBIO INTEGRAL DEL PANEL" o "PRE-CAMBIO / LIMPIEZA"
  },
  { _id: false }
);

const SolarThermographySchema = new mongoose.Schema(
  {
    // Identificador público de la empresa (ddffd24e-3365-4eaf...)
    companyPublicCode: {
      type: String,
      required: true,
      index: true,
    },
    // Código del subarreglo (ej: SOLAR-001)
    solarCode: {
      type: String,
      required: true,
      default: "SOLAR-001",
    },
    title: {
      type: String,
      default: "Auditoría Termográfica Aérea de Paneles Solares (IEC 62446-3)",
    },
    location: {
      type: String,
      default: "Azotea Principal",
    },
    droneModel: {
      type: String,
      default: "DJI Matrice 300 RTK / H20T Dual Sensor",
    },
    thermalImageUrl: {
      type: String, // URL de Cloudinary
      default: null,
    },
    visualImageUrl: {
      type: String, // URL de Cloudinary
      default: null,
    },
    rows: { type: Number, required: true },
    cols: { type: Number, required: true },

    // Métricas globales del subarreglo térmico
    stats: {
      min: { type: Number, required: true },
      max: { type: Number, required: true },
      avg: { type: Number, required: true },
      deltaTMax: { type: Number, required: true },
      criticalHotspotsCount: { type: Number, default: 0 },
      warningHotspotsCount: { type: Number, default: 0 },
      panelsToReplaceCount: { type: Number, default: 0 },
    },

    // Puntos calientes mapeados celda por celda
    hotspots: [HotspotSchema],

    // Dictamen técnico formal emitido por OpenAI
    technicalDiagnosis: {
      type: String,
      default: null,
    },

    // Matriz térmica Float32 comprimida con zlib para el hover continuo
    compressedData: {
      type: Buffer,
      required: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// Índice compuesto para evitar duplicados del mismo código en una empresa
SolarThermographySchema.index({ companyPublicCode: 1, solarCode: 1 });

const SolarThermography = mongoose.model("SolarThermography", SolarThermographySchema);
export default SolarThermography;