import mongoose from "mongoose";

const MeasurementSchema = new mongoose.Schema({
  boardId: { type: mongoose.Schema.Types.ObjectId, ref: 'Board', required: true },
  timestamp: { type: Date, required: true },
  fecha: { type: String, required: true },         // 'YYYY-MM-DD'
  horaMinuto: { type: String, required: true },    // 'HH:MM'
  diaSemana: { type: String, required: true },     // 'Lunes', 'Martes', etc.
  demandaKw: { type: Number, required: true },     // Convertido a kW (Eptot+)
  reactivaIndKvar: { type: Number, required: true }, // Convertido a kvar (Ntotind+)
  reactivaCapKvar: { type: Number, required: true }, // Convertido a kvar (Ntotcap+)

  // ── DISTORSIÓN ARMÓNICA DE TENSIÓN (THD-U %) ──
  thd_u12: { type: Number, default: 0 },           // Fase 1 o Línea 12 en %
  thd_u23: { type: Number, default: 0 },           // Fase 2 o Línea 23 en %
  thd_u31: { type: Number, default: 0 },           // Fase 3 o Línea 31 en %
  thdVoltaje: { type: Number, default: 0 },        // Promedio (THDu1 + THDu2 + THDu3) / 3 en %

  // ── DISTORSIÓN ARMÓNICA DE CORRIENTE (THD-I %) ──
  thd_i1: { type: Number, default: 0 },            // Corriente Fase 1 en %
  thd_i2: { type: Number, default: 0 },            // Corriente Fase 2 en %
  thd_i3: { type: Number, default: 0 },            // Corriente Fase 3 en %
  thdCorriente: { type: Number, default: 0 }       // Promedio (THDi1 + THDi2 + THDi3) / 3 en %
});

MeasurementSchema.index({ boardId: 1, timestamp: 1 }, { unique: true });

const MeasurementModel = mongoose.models.Measurement || mongoose.model('Measurement', MeasurementSchema);
export default MeasurementModel;