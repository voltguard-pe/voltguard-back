import mongoose from 'mongoose';

const subscriptionSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      unique: true,
    },
    plan: {
      type: String,
      enum: ['basico', 'empresarial'],
      default: 'basico',
    },
    status: {
      type: String,
      enum: ['active', 'expired', 'pending_payment'],
      default: 'active',
    },
    montoAcordadoMensual: {
      type: Number,
      default: 0,
    },
    // Límites de activos cotizados
    scope: {
      tableros: { type: Number, default: 1 },
      spatPozos: { type: Number, default: 0 },
      subestaciones: { type: Number, default: 0 },
      instalacionesSolares: { type: Number, default: 0 },
    },
    startDate: {
      type: Date,
      default: Date.now,
    },
    endDate: {
      type: Date, // null si es básico (gratis e ilimitado en tiempo)
    },
    nroOperacionActual: {
      type: String,
    },
    // Banderas para el sistema de alertas por cron
    notified5DaysBefore: {
      type: Boolean,
      default: false,
    },
    notifiedDayOfExpiration: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

export const Subscription = mongoose.model('Subscription', subscriptionSchema);