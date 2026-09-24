import mongoose from "mongoose";

// =========================
// 🔌 CIRCUITS
// =========================
const circuitSchema = new mongoose.Schema(
    {
        circuito: {
            type: String,
            // required: true, // HABILITAR DESPUES
            trim: true,
        },
        descripcion: {
            type: String,
            trim: true,
            default: "",
        },
        tipo: {
            type: String,
            enum: ["MONOFÁSICO", "TRIFÁSICO", null],
            default: null,
        },
    },
    { _id: false },
);

// =========================
// 🧪 INSULATION MEASUREMENTS
// =========================
const insulationMeasurementRowSchema = new mongoose.Schema(
    {
        description: {
            type: String,
            trim: true,
            default: "Barras generales",
        },

        measurement_l1_g: {
            type: Number,
            default: null,
        },

        measurement_l2_g: {
            type: Number,
            default: null,
        },

        measurement_l3_g: {
            type: Number,
            default: null,
        },

        unit: {
            type: String,
            default: "MΩ",
        },
    },
    { _id: false },
);

const insulationMeasurementSchema = new mongoose.Schema(
    {
        batchCode: {
            type: String,
            required: true,
            index: true,
        },
        unit: {
            type: String,
            default: "MΩ",
        },
        status: {
            type: String,
            enum: ["PENDING_REVIEW", "CONFIRMED", "FAILED"],
            default: "PENDING_REVIEW",
        },
        sourceImages: {
            boardImage: {
                type: String,
                default: null,
            },
        },
        rows: {
            type: [insulationMeasurementRowSchema],
            default: [],
        },
        warnings: {
            type: [String],
            default: [],
        },
        rawAiResponse: {
            type: mongoose.Schema.Types.Mixed,
            default: null,
        },
        importedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            default: null,
        },
        importedAt: {
            type: Date,
            default: Date.now,
        },
    },
    { _id: true },
);

// =========================
// 🧱 BOARD
// =========================
const boardSchema = new mongoose.Schema(
    {
        // ID INTERNO
        code: {
            type: String,
            required: true,
            unique: true,
            index: true,
        },

        // CÓDIGO REAL DEL TABLERO
        boardCode: {
            type: String,
            required: true,
            trim: true,
            index: true,
        },

        // INFO BÁSICA
        name: {
            type: String,
            required: true,
            trim: true,
        },

        type: {
            type: String,
            // required: true, // HABILITAR DESPUES
            trim: true,
        },

        // INFO ELÉCTRICA (NO BLOQUEANTE)
        tensionNominal: {
            type: Number,
        },

        numeroFases: {
            type: Number,
        },

        incluyeNeutro: {
            type: Boolean,
            default: false,
        },

        sistema: {
            type: String,
            enum: ["MONOFÁSICO", "TRIFÁSICO"],
        },

        // UBICACIÓN
        location: {
            type: String,
            trim: true,
            default: "",
        },

        description: {
            type: String,
            trim: true,
            default: "",
        },

        // CIRCUITOS
        circuits: {
            type: [circuitSchema],
            default: [],
        },

        // IMÁGENES
        images: {
            tablero: {
                type: [String],
                default: [],
            },
            unifilar: {
                type: [String],
                default: [],
            },
            termografia: {
                type: [String],
                default: [],
            },
        },

        // MEDICIONES DE AISLAMIENTO
        insulationMeasurements: {
            type: [insulationMeasurementSchema],
            default: [],
        },

        // ESTADO
        estadoGeneral: {
            type: String,
            enum: ["OPERATIVO", "OBSERVACION", "CRITICO"],
        },

        // EMPRESA (CLAVE)
        companyPublicCode: {
            type: String,
            required: true,
            index: true,
            trim: true,
        },

        /***************** NFPA 70E SECTION *****************/
        nfpa: {
            type: {
                amperajePrincipal: { type: Number, default: null },
                tipoInterruptor: { type: String, default: "Caja Moldeada" },
                corrienteCortocircuito: { type: Number, default: null },
                distanciaTrabajo: { type: String, default: "45.72 cm (18 in)" },
                distanciaArco: { type: String, default: "" },
                energiaIncidente: { type: String, default: "" },
                categoriaRiesgo: { type: Number, default: null },
                limiteAproximacion: { type: String, default: "" },
                distanciaRestringida: { type: String, default: "" },
                guantesClase: { type: String, default: "" },
                eppRequerido: { type: [String], default: [] },
                calculadoPorIA: { type: Boolean, default: false },
            },
            default: undefined // 👈 ESTA LINEA EVITA QUE MONGOOSE LO CREA POR DEFECTO
        },
        
        /************************************************** */

        /***************** TARIFAS DE ENERGÍA (RECIBO DE LUZ) *****************/
        energyRates: {
            tarifaHP: {
                type: Number,
                default: 0.3095,
            },
            tarifaFP: {
                type: Number,
                default: 0.2616,
            },
            receiptImageUrl: {
                type: String,
                default: null,
            },
            updatedAt: {
                type: Date,
                default: Date.now,
            },
        },
        /*********************************************************************/

        // USUARIO
        createdBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
        },
        
        assignedDocuments: [
            {
                type: mongoose.Schema.Types.ObjectId,
                ref: "Document"
            }
        ]
    },
    {
        timestamps: true,
    },
);

// =========================
// 🔒 UNIQUE COMBINADO
// =========================
boardSchema.index({ boardCode: 1, companyPublicCode: 1 }, { unique: true });

export default mongoose.model("Board", boardSchema);
