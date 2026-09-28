import Measurement from '../models/Measurement.js';
import mongoose from "mongoose";

const parseMetrelFloat = (textoRaw) => {
  if (!textoRaw) return 0;
  let limpio = String(textoRaw).replace(/[^\d.,-]/g, '');
  if (limpio.includes(',') && limpio.includes('.')) {
    limpio = limpio.replace(/,/g, '');
  } else if (limpio.includes(',') && !limpio.includes('.')) {
    limpio = limpio.replace(/,/g, '.');
  }
  const valor = parseFloat(limpio);
  return isNaN(valor) ? 0 : valor;
};

// Función auxiliar: Detección universal de cabeceras THD (%)
// Compatible con conexiones Delta (U12, U23, U31) y Estrella (U1, U2, U3)
const encontrarColumnaTHDU = (columnas, fase) => {
  return columnas.findIndex(col => {
    const c = col.toLowerCase();
    // Exigir 'thd' y el símbolo '%' obligatoriamente para descartar las columnas en Voltios [V]
    if (!c.includes('thd') || !c.includes('%')) return false;

    if (fase === 1) {
      return c.includes('u12') || (c.includes('u1') && !c.includes('u12') && !c.includes('u31'));
    }
    if (fase === 2) {
      return c.includes('u23') || (c.includes('u2') && !c.includes('u23'));
    }
    if (fase === 3) {
      return c.includes('u31') || (c.includes('u3') && !c.includes('u31'));
    }
    return false;
  });
};

// A. IMPORTACIÓN CON LECTURA DINÁMICA DE CABECERAS
export const importMetrel = async (req, res) => {
  try {
    const { boardId } = req.params;
    if (!req.file || !req.file.buffer) return res.status(400).json({ error: 'Buffer vacío.' });

    const csvTexto = req.file.buffer.toString('utf-8');
    const lineas = csvTexto.split(/\r?\n/);
    const datosProcesados = [];
    const diasInEsp = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

    let colIndices = null;

    for (let i = 0; i < lineas.length; i++) {
      const linea = lineas[i].trim();
      if (!linea) continue;

      const columnas = linea.replace(/"/g, '').split(';');

      // 1. Detección automática de la fila de cabecera
      const lineaNormalizada = linea.toLowerCase();
      if (!colIndices && (lineaNormalizada.includes('eptot') || lineaNormalizada.includes('thd') || lineaNormalizada.includes('hora'))) {
        colIndices = {
          time: 0,
          eptot: columnas.findIndex(c => c.toLowerCase().includes('eptot')),
          cap: columnas.findIndex(c => c.toLowerCase().includes('ntotcap')),
          ind: columnas.findIndex(c => c.toLowerCase().includes('ntotind')),

          // Armónicos de Tensión (%) - Detección universal U1/U12, U2/U23, U3/U31
          thdu1: encontrarColumnaTHDU(columnas, 1),
          thdu2: encontrarColumnaTHDU(columnas, 2),
          thdu3: encontrarColumnaTHDU(columnas, 3),

          // Armónicos de Corriente (%)
          thdi1: columnas.findIndex(c => /thd.*i.*1/i.test(c) && c.includes('%')),
          thdi2: columnas.findIndex(c => /thd.*i.*2/i.test(c) && c.includes('%')),
          thdi3: columnas.findIndex(c => /thd.*i.*3/i.test(c) && c.includes('%')),
        };
        continue;
      }

      if (!colIndices) continue; // Saltar filas previas a la cabecera

      const rawTime = columnas[colIndices.time]?.trim();
      if (!rawTime || !rawTime.includes('/') || !rawTime.includes(':')) continue;

      // Lectura de potencias (con fallback a índices 1, 2, 3 si el nombre varió)
      const rawWh = parseMetrelFloat(columnas[colIndices.eptot !== -1 ? colIndices.eptot : 1]);
      const rawVarCap = parseMetrelFloat(columnas[colIndices.cap !== -1 ? colIndices.cap : 2]);
      const rawVarInd = parseMetrelFloat(columnas[colIndices.ind !== -1 ? colIndices.ind : 3]);

      // Lectura individual de Armónicos de Tensión (%)
      const u1 = colIndices.thdu1 !== -1 ? parseMetrelFloat(columnas[colIndices.thdu1]) : 0;
      const u2 = colIndices.thdu2 !== -1 ? parseMetrelFloat(columnas[colIndices.thdu2]) : 0;
      const u3 = colIndices.thdu3 !== -1 ? parseMetrelFloat(columnas[colIndices.thdu3]) : 0;
      const cantU = (u1 > 0 ? 1 : 0) + (u2 > 0 ? 1 : 0) + (u3 > 0 ? 1 : 0);
      const thdVAvg = cantU > 0 ? (u1 + u2 + u3) / cantU : 0;

      // Lectura individual de Armónicos de Corriente (%)
      const i1 = colIndices.thdi1 !== -1 ? parseMetrelFloat(columnas[colIndices.thdi1]) : 0;
      const i2 = colIndices.thdi2 !== -1 ? parseMetrelFloat(columnas[colIndices.thdi2]) : 0;
      const i3 = colIndices.thdi3 !== -1 ? parseMetrelFloat(columnas[colIndices.thdi3]) : 0;
      const cantI = (i1 > 0 ? 1 : 0) + (i2 > 0 ? 1 : 0) + (i3 > 0 ? 1 : 0);
      const thdIAvg = cantI > 0 ? (i1 + i2 + i3) / cantI : 0;

      const [fechaParte, horaParte] = rawTime.split(' ');
      const [diaStr, mesStr, añoStr] = fechaParte.split('/');
      const [horaStr, minutoStr] = horaParte.split(':');

      let horaInt = parseInt(horaStr);
      let minutoInt = parseInt(minutoStr);
      let minutoRedondeado = Math.round(minutoInt / 5) * 5;

      if (minutoRedondeado === 60) {
        minutoRedondeado = 0;
        horaInt += 1;
      }
      if (horaInt === 24) horaInt = 0;

      const hora = String(horaInt).padStart(2, '0');
      const minuto = String(minutoRedondeado).padStart(2, '0');
      const horaMinuto = `${hora}:${minuto}`; 
      const fecha = `${añoStr}-${mesStr.padStart(2, '0')}-${diaStr.padStart(2, '0')}`;
      const timestampNeutro = new Date(`${fecha}T${hora}:${minuto}:00.000Z`);
      const diaSemana = diasInEsp[timestampNeutro.getUTCDay()];

      const kw = (rawWh * 12) / 1000;
      const kvarCap = rawVarCap / 1000;
      const kvarInd = rawVarInd / 1000;

      datosProcesados.push({
        boardId,
        timestamp: timestampNeutro,
        fecha,
        horaMinuto,
        diaSemana,
        demandaKw: Number(kw.toFixed(2)),
        reactivaCapKvar: Number(kvarCap.toFixed(2)),
        reactivaIndKvar: Number(kvarInd.toFixed(2)),
        // Guardado de cada fase individual de Tensión
        thd_u12: Number(u1.toFixed(2)),
        thd_u23: Number(u2.toFixed(2)),
        thd_u31: Number(u3.toFixed(2)),
        thdVoltaje: Number(thdVAvg.toFixed(2)),
        // Guardado de cada fase individual de Corriente
        thd_i1: Number(i1.toFixed(2)),
        thd_i2: Number(i2.toFixed(2)),
        thd_i3: Number(i3.toFixed(2)),
        thdCorriente: Number(thdIAvg.toFixed(2))
      });
    }

    if (datosProcesados.length > 0) {
      await Measurement.deleteMany({ boardId });
      await Measurement.bulkWrite(
        datosProcesados.map(doc => ({
          updateOne: {
            filter: { boardId, timestamp: doc.timestamp },
            update: { $set: doc },
            upsert: true
          }
        }))
      );
    }

    return res.status(200).json({ success: true, count: datosProcesados.length });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

// B. CONSULTA EXTENDIDA CON INCLUSIÓN DE FASES u12, u23, u31
export const chartData = async (req, res) => {
  try {
    const { boardId } = req.params;
    const { fechaInicio, fechaFin } = req.query;

    const limites = await Measurement.aggregate([
      { $match: { boardId: new mongoose.Types.ObjectId(boardId) } },
      { $group: { _id: null, min: { $min: "$fecha" }, max: { $max: "$fecha" } } }
    ]);

    const minFechaDisponible = limites[0]?.min || "2026-09-01";
    const maxFechaDisponible = limites[0]?.max || "2026-09-08";

    const query = { boardId };
    if (fechaInicio && fechaFin) {
      query.fecha = { $gte: fechaInicio,$lte: fechaFin };
    } else {
      query.fecha = { $gte: minFechaDisponible,$lte: maxFechaDisponible };
    }

    const datos = await Measurement.find(query).sort({ timestamp: 1 });

    if (!datos || datos.length === 0) {
      return res.json({
        agrupado: {},
        minFecha: minFechaDisponible,
        maxFecha: maxFechaDisponible
      });
    }

    const primerLunesObj = datos.find(item => item.timestamp.getUTCDay() === 1);
    const fechaLunesBase = primerLunesObj
      ? new Date(primerLunesObj.fecha + 'T00:00:00.000Z')
      : new Date(datos[0].fecha + 'T00:00:00.000Z');

    const agrupado = {};
    const diasInfo = [];
    const diasNombres = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];

    for (let i = 0; i < 7; i++) {
      const fechaDia = new Date(fechaLunesBase);
      fechaDia.setUTCDate(fechaLunesBase.getUTCDate() + i);

      const yyyy = fechaDia.getUTCFullYear();
      const mm = String(fechaDia.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(fechaDia.getUTCDate()).padStart(2, '0');

      const fechaFormateada = `${yyyy}-${mm}-${dd}`;
      const nombreDia = diasNombres[i];
      const keyFinal = `${fechaFormateada} (${nombreDia})`;

      agrupado[keyFinal] = {};

      diasInfo.push({
        jsDay: fechaDia.getUTCDay(),
        keyFinal
      });
    }

    datos.forEach(item => {
      const jsDay = item.timestamp.getUTCDay();
      const match = diasInfo.find(d => d.jsDay === jsDay);

      if (match) {
        agrupado[match.keyFinal][item.horaMinuto] = {
          p: item.demandaKw,
          ind: item.reactivaIndKvar,
          cap: item.reactivaCapKvar,
          // Fases individuales THD-U (%) enviadas al frontend
          thd_u12: item.thd_u12 || 0,
          thd_u23: item.thd_u23 || 0,
          thd_u31: item.thd_u31 || 0,
          thd_v: item.thdVoltaje || 0,
          // Fases individuales THD-I (%) enviadas al frontend
          thd_i1: item.thd_i1 || 0,
          thd_i2: item.thd_i2 || 0,
          thd_i3: item.thd_i3 || 0,
          thd_i: item.thdCorriente || 0
        };
      }
    });

    return res.json({
      agrupado,
      minFecha: minFechaDisponible,
      maxFecha: maxFechaDisponible
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};