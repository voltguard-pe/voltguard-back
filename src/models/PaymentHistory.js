import mongoose from 'mongoose';

const paymentHistorySchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
    },
    fechaPago: {
      type: Date,
      default: Date.now,
    },
    nroOperacion: {
      type: String,
      required: true,
    },
    banco: {
      type: String,
      required: true,
    },
    monto: {
      type: Number,
      required: true,
    },
    duracionMeses: {
      type: Number,
      required: true,
    },
    plan: {
      type: String,
      enum: ['basico', 'empresarial'],
      default: 'empresarial',
    },
    scope: {
      tableros: { type: Number, default: 1 },
      spatPozos: { type: Number, default: 0 },
      subestaciones: { type: Number, default: 0 },
      instalacionesSolares: { type: Number, default: 0 },
    },
    periodoTexto: {
      type: String, // Ej: "02/11/2026 15:30 al 02/12/2026 15:30"
    },
    validadoPor: {
      type: String,
      default: 'Área de Ventas',
    },
    notas: {
      type: String,
    },
  },
  { timestamps: true }
);

export const PaymentHistory = mongoose.model('PaymentHistory', paymentHistorySchema);