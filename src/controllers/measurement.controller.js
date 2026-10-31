import Measurement from '../models/Measurement.js';
import mongoose from "mongoose";

// Limpieza y parseo de floats (soporta tanto coma como punto decimal)
const parseUniversalFloat = (textoRaw) => {
  if (textoRaw === null || textoRaw === undefined) return 0;
  let limpio = String(textoRaw).trim().replace(/[^\d.,-]/g, '');
  if (limpio.includes(',') && limpio.includes('.')) {
    limpio = limpio.replace(/,/g, '');
  } else if (limpio.includes(',') && !limpio.includes('.')) {
    limpio = limpio.replace(/,/g, '.');
  }
  const valor = parseFloat(limpio);
  return isNaN(valor) ? 0 : valor;
};

// Detección universal de THD Tensión (%) para Metrel, Circutor y Fluke
const encontrarColumnaTHDU = (columnas, fase) => {
  return columnas.findIndex(col => {
    const c = col.toLowerCase();
    const esTHD = c.includes('thd') || c.includes('distors');
    const esVoltaje = c.includes('u') || c.includes('v') || c.includes('tensi');
    const esPorc = c.includes('%');
    if (!esTHD || !esVoltaje || !esPorc) return false;

    if (fase === 1) {
      return c.includes('u12') || c.includes('v12') || 
             (c.includes('l1') && !c.includes('l12')) || 
             (c.includes('u1') && !c.includes('u12') && !c.includes('u31')) ||
             (c.includes('v1') && !c.includes('v12') && !c.includes('v31'));
    }
    if (fase === 2) {
      return c.includes('u23') || c.includes('v23') || 
             (c.includes('l2') && !c.includes('l23')) || 
             (c.includes('u2') && !c.includes('u23')) ||
             (c.includes('v2') && !c.includes('v23'));
    }
    if (fase === 3) {
      return c.includes('u31') || c.includes('v31') || 
             (c.includes('l3') && !c.includes('l31')) || 
             (c.includes('u3') && !c.includes('u31')) ||
             (c.includes('v3') && !c.includes('v31'));
    }
    return false;
  });
};

export const importUniversalMeasurement = async (req, res) => {
  try {
    const { boardId } = req.params;
    if (!req.file || !req.file.buffer) return res.status(400).json({ error: 'Buffer vacío.' });

    // latin1 previene que caracteres especiales (ó, é, º, ï»¿) rompan la lectura de cabeceras
    const csvTexto = req.file.buffer.toString('latin1');
    const lineas = csvTexto.split(/\r?\n/);
    const datosProcesados = [];
    const diasInEsp = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

    let colIndices = null;
    let delim = ';';
    let tieneColSeparadaHora = false;

    for (let i = 0; i < lineas.length; i++) {
      const linea = lineas[i].trim();
      if (!linea) continue;

      // Autodetectar delimitador (; o ,)
      if (!colIndices) {
        if ((linea.match(/;/g) || []).length < (linea.match(/,/g) || []).length) {
          delim = ',';
        }
      }

      const columnas = linea.replace(/"/g, '').split(delim);
      const lineaNorm = linea.toLowerCase();

      // Detección universal de la fila de cabecera
      if (!colIndices && (
        lineaNorm.includes('ptot') || 
        lineaNorm.includes('p.activa') || 
        lineaNorm.includes('active power') || 
        lineaNorm.includes('fecha/hora') || 
        lineaNorm.includes('hora [utc]') ||
        (lineaNorm.includes('fecha') && lineaNorm.includes('hora'))
      )) {
        const idxFecha = columnas.findIndex(c => /^(fecha|date)$/i.test(c.trim()));
        const idxHora = columnas.findIndex(c => /^(hora|time)$/i.test(c.trim()));

        tieneColSeparadaHora = (idxFecha !== -1 && idxHora !== -1);

        colIndices = {
          dateCol: tieneColSeparadaHora ? idxFecha : 0,
          timeCol: tieneColSeparadaHora ? idxHora : 0,

          // Energía acumulada por intervalo (Wh / kWh)
          eptot: columnas.findIndex(c => c.toLowerCase().includes('eptot')),

          // Potencia Activa Total trifásica (excluyendo columnas de energía pura)
          ptot: columnas.findIndex(c => 
            (/ptot/i.test(c) || /p\.activa/i.test(c) || /active.*power/i.test(c) || /potencia.*activa/i.test(c)) && 
            !/eptot/i.test(c) && !/e\.activa/i.test(c)
          ),

          // Reactiva Capacitiva
          cap: columnas.findIndex(c => 
            c.toLowerCase().includes('ntotcap') || 
            c.toLowerCase().includes('capacit') || 
            c.toLowerCase().includes('kvarc')
          ),

          // Reactiva Inductiva
          ind: columnas.findIndex(c => 
            c.toLowerCase().includes('ntotind') || 
            c.toLowerCase().includes('induct') || 
            c.toLowerCase().includes('kvarl')
          ),

          // Armónicos de Tensión (%)
          thdu1: encontrarColumnaTHDU(columnas, 1),
          thdu2: encontrarColumnaTHDU(columnas, 2),
          thdu3: encontrarColumnaTHDU(columnas, 3),

          // Armónicos de Corriente (%)
          thdi1: columnas.findIndex(c => /thd.*i.*1/i.test(c) && c.includes('%')),
          thdi2: columnas.findIndex(c => /thd.*i.*2/i.test(c) && c.includes('%')),
          thdi3: columnas.findIndex(c => /thd.*i.*3/i.test(c) && c.includes('%')),

          // Banderas automáticas de unidades
          ptotIsKw: false,
          reactIsKvar: false
        };

        // Si la cabecera dice kW explicitamente, NO dividimos entre 1000
        if (colIndices.ptot !== -1) {
          colIndices.ptotIsKw = columnas[colIndices.ptot].toLowerCase().includes('kw');
        }
        // Si las reactivas dicen kvar / kvarc / kvarl, tampoco dividimos
        if (colIndices.cap !== -1 || colIndices.ind !== -1) {
          const hc = colIndices.cap !== -1 ? columnas[colIndices.cap].toLowerCase() : '';
          const hi = colIndices.ind !== -1 ? columnas[colIndices.ind].toLowerCase() : '';
          colIndices.reactIsKvar = hc.includes('kvar') || hi.includes('kvar');
        }

        continue;
      }

      if (!colIndices) continue; // Saltar filas de metadatos o comentarios

      // Extracción de Fecha y Hora
      let rawFechaStr = '';
      let rawHoraStr = '';

      if (tieneColSeparadaHora) {
        rawFechaStr = columnas[colIndices.dateCol]?.trim();
        rawHoraStr = columnas[colIndices.timeCol]?.trim();
      } else {
        const fullTime = columnas[colIndices.dateCol]?.trim();
        if (!fullTime) continue;
        const partes = fullTime.split(' ');
        rawFechaStr = partes[0] || '';
        rawHoraStr = partes[1] || '';
      }

      if (!rawFechaStr || !rawHoraStr || !rawFechaStr.includes('/') || !rawHoraStr.includes(':')) {
        continue;
      }

      // Normalizar Año de 2 dígitos a 4 dígitos (ej: "10" -> "2010")
      const [diaStr, mesStr, añoStrRaw] = rawFechaStr.split('/');
      let añoStr = añoStrRaw;
      if (añoStr && añoStr.length === 2) {
        añoStr = parseInt(añoStr) > 70 ? `19${añoStr}` : `20${añoStr}`;
      }

      const [horaStr, minutoStr] = rawHoraStr.split(':');
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

      // Conversión inteligente de Potencia Activa (siempre a kW)
      let kw = 0;
      if (colIndices.eptot !== -1) {
        // En Metrel Wh a kW por intervalo
        kw = (parseUniversalFloat(columnas[colIndices.eptot]) * 12) / 1000;
      } else if (colIndices.ptot !== -1) {
        const rawP = parseUniversalFloat(columnas[colIndices.ptot]);
        kw = colIndices.ptotIsKw ? rawP : rawP / 1000;
      }

      // Conversión inteligente de Potencia Reactiva (siempre a kvar)
      const rawCap = colIndices.cap !== -1 ? parseUniversalFloat(columnas[colIndices.cap]) : 0;
      const rawInd = colIndices.ind !== -1 ? parseUniversalFloat(columnas[colIndices.ind]) : 0;
      const kvarCap = colIndices.reactIsKvar ? rawCap : rawCap / 1000;
      const kvarInd = colIndices.reactIsKvar ? rawInd : rawInd / 1000;

      // THD de Tensión (%)
      const u1 = colIndices.thdu1 !== -1 ? parseUniversalFloat(columnas[colIndices.thdu1]) : 0;
      const u2 = colIndices.thdu2 !== -1 ? parseUniversalFloat(columnas[colIndices.thdu2]) : 0;
      const u3 = colIndices.thdu3 !== -1 ? parseUniversalFloat(columnas[colIndices.thdu3]) : 0;
      const cantU = (u1 > 0 ? 1 : 0) + (u2 > 0 ? 1 : 0) + (u3 > 0 ? 1 : 0);
      const thdVAvg = cantU > 0 ? (u1 + u2 + u3) / cantU : 0;

      // THD de Corriente (%)
      const i1 = colIndices.thdi1 !== -1 ? parseUniversalFloat(columnas[colIndices.thdi1]) : 0;
      const i2 = colIndices.thdi2 !== -1 ? parseUniversalFloat(columnas[colIndices.thdi2]) : 0;
      const i3 = colIndices.thdi3 !== -1 ? parseUniversalFloat(columnas[colIndices.thdi3]) : 0;
      const cantI = (i1 > 0 ? 1 : 0) + (i2 > 0 ? 1 : 0) + (i3 > 0 ? 1 : 0);
      const thdIAvg = cantI > 0 ? (i1 + i2 + i3) / cantI : 0;

      datosProcesados.push({
        boardId,
        timestamp: timestampNeutro,
        fecha,
        horaMinuto,
        diaSemana,
        demandaKw: Number(kw.toFixed(2)),
        reactivaCapKvar: Number(kvarCap.toFixed(2)),
        reactivaIndKvar: Number(kvarInd.toFixed(2)),
        thd_u12: Number(u1.toFixed(2)),
        thd_u23: Number(u2.toFixed(2)),
        thd_u31: Number(u3.toFixed(2)),
        thdVoltaje: Number(thdVAvg.toFixed(2)),
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
      query.fecha = { $gte: fechaInicio, $lte: fechaFin };
    } else {
      query.fecha = { $gte: minFechaDisponible, $lte: maxFechaDisponible };
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