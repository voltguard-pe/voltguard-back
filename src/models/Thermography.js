import mongoose from "mongoose";

const ThermographySchema = new mongoose.Schema(
  {
    boardId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Board",
      required: true,
      index: true,
    },
    title: {
      type: String,
      default: "Inspección Termográfica Radiométrica (NFPA 70B)",
    },
    // Imagen Térmica FLIR nativa (.jpg)
    thermalImageUrl: {
      type: String,
      default: null,
    },
    // Fotografía visual del tablero (.jpg)
    originalImageUrl: {
      type: String, // URL o ruta de la foto visible (.jpg)
      default: null,
    },
    // Dimensiones de la matriz radiométrica
    rows: { type: Number, required: true },
    cols: { type: Number, required: true },

    // Métricas clave y evaluación según NFPA 70B
    stats: {
      min: { type: Number, required: true },
      max: { type: Number, required: true },
      avg: { type: Number, required: true },
      deltaT: { type: Number, required: true },
      maxPos: { type: [Number], default: [0, 0] }, // [row, col]
      minPos: { type: [Number], default: [0, 0] },
      severity: {
        type: String,
        enum: ["NORMAL", "MONITOREO", "INTERVENCION_PROXIMA", "CRITICO"],
        default: "NORMAL",
      },
    },

    // Matriz de temperaturas comprimida con zlib (peso liviano < 200KB)
    compressedData: {
      type: Buffer,
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

const Thermography = mongoose.model("Thermography", ThermographySchema);
export default Thermography;