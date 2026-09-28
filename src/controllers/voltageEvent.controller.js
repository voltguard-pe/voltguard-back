import VoltageEvent from '../models/VoltageEvent.js';

// ── UTILIDAD ROBUSTA PARA PARSEAR DURACIONES DE METREL A SEGUNDOS ──
const parseMetrelDuration = (durStr) => {
  if (!durStr) return 0.00001;
  const str = durStr.trim().toLowerCase();

  // Si no está disponible o es inicio de registro, ubicarlo a 10 µs (extremo izquierdo de Metrel)
  if (str.includes('no disponible') || str.includes('instant') || str === '0') {
    return 0.00001;
  }

  // 1. Milisegundos ("024 ms", "715 ms", "16 ms")
  if (str.includes('ms')) {
    const val = parseFloat(str.replace('ms', '').replace(',', '.').trim());
    return !isNaN(val) ? val / 1000 : 0.00001;
  }

  // 2. Horas con minutos ("2 h 15 min" o "4.22:01:37.467")
  if (str.includes('h')) {
    const parts = str.split('h');
    const hours = parseFloat(parts[0].replace(',', '.')) || 0;
    const mins = parseFloat(parts[1]?.replace('min', '').replace(',', '.')) || 0;
    return hours * 3600 + mins * 60;
  }

  // 3. Minutos simples ("15 min")
  if (str.includes('min')) {
    const val = parseFloat(str.replace('min', '').replace(',', '.').trim());
    return !isNaN(val) ? val * 60 : 0.00001;
  }

  // 4. Ciclos de red 60Hz ("24 c" -> ~0.4 s)
  if (str.includes('c') && !str.includes(':')) {
    const val = parseFloat(str.replace('c', '').replace(',', '.').trim());
    return !isNaN(val) ? val * (1 / 60) : 0.00001;
  }

  // 5. Formato con días o timestamps ("4.22:01:37.467")
  if (str.includes(':')) {
    let days = 0;
    let rest = str;
    const firstDot = rest.indexOf('.');
    const firstColon = rest.indexOf(':');

    if (firstDot > -1 && firstColon > -1 && firstDot < firstColon) {
      days = parseInt(rest.split('.')[0]) || 0;
      rest = rest.substring(firstDot + 1);
    }

    const timeParts = rest.split(':');
    let hours = 0, minutes = 0, seconds = 0;

    if (timeParts.length === 3) {
      hours = parseInt(timeParts[0]) || 0;
      minutes = parseInt(timeParts[1]) || 0;
      seconds = parseFloat(timeParts[2].replace(',', '.')) || 0;
    } else if (timeParts.length === 2) {
      minutes = parseInt(timeParts[0]) || 0;
      seconds = parseFloat(timeParts[1].replace(',', '.')) || 0;
    }

    return (days * 86400) + (hours * 3600) + (minutes * 60) + seconds;
  }

  // 6. Segundos simples ("1.958 s", "0.5 s" o número solo)
  const val = parseFloat(str.replace('s', '').replace(',', '.').trim());
  return !isNaN(val) && val > 0 ? val : 0.00001;
};

// ── IMPORTACIÓN DEL CSV (SUBIDA) ──
export const uploadIticCsv = async (req, res) => {
  try {
    const { boardId } = req.params;
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: 'No se ha detectado ningún archivo CSV.' });
    }

    let csvTexto = req.file.buffer.toString('utf-8');
    if (csvTexto.includes('ï»¿')) {
      csvTexto = csvTexto.replace('ï»¿', '');
    }

    const lineas = csvTexto.split(/\r?\n/);
    const eventosProcesados = [];
    let colIndices = null;

    for (let i = 0; i < lineas.length; i++) {
      const linea = lineas[i].trim();
      if (!linea) continue;

      const columnas = linea.replace(/"/g, '').split(';');
      const lineaLower = linea.toLowerCase();

      // Detección dinámica de cabeceras
      if (!colIndices && lineaLower.includes('tipo') && lineaLower.includes('duraci')) {
        colIndices = {
          tipo: columnas.findIndex(c => c.toLowerCase().includes('tipo de evento')),
          inicio: columnas.findIndex(c => c.toLowerCase().includes('inicio')),
          fin: columnas.findIndex(c => c.toLowerCase().includes('finaliza')),
          duracion: columnas.findIndex(c => c.toLowerCase().includes('duraci')),
          fase: columnas.findIndex(c => c.toLowerCase().includes('fase')),
          tension: columnas.findIndex(c => c.toLowerCase().includes('tensi'))
        };
        continue;
      }

      if (!colIndices || columnas.length < 5) continue;

      const tipoEvento = columnas[colIndices.tipo]?.trim();
      const duracionRaw = columnas[colIndices.duracion]?.trim();
      const tensionRaw = columnas[colIndices.tension]?.trim();

      if (!tipoEvento) continue;

      const duracionSegundos = parseMetrelDuration(duracionRaw);
      let tensionResidual = parseFloat(tensionRaw?.replace(',', '.') || '0');
      if (isNaN(tensionResidual)) tensionResidual = 0;

      eventosProcesados.push({
        boardId,
        tipoEvento,
        horaInicio: columnas[colIndices.inicio]?.trim() || "",
        horaFinalizacion: columnas[colIndices.fin]?.trim() || "",
        duracionSegundos: Number(duracionSegundos.toFixed(6)),
        fase: columnas[colIndices.fase]?.trim() || "Desconocida",
        tensionResidual: Number(tensionResidual.toFixed(2))
      });
    }

    if (eventosProcesados.length > 0) {
      await VoltageEvent.deleteMany({ boardId });
      await VoltageEvent.insertMany(eventosProcesados);
    }

    return res.status(200).json({ 
      success: true, 
      message: 'Eventos ITIC cargados con éxito',
      count: eventosProcesados.length 
    });

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

// ── CONSULTA DE EVENTOS ──
export const getIticEvents = async (req, res) => {
  try {
    const { boardId } = req.params;
    const events = await VoltageEvent.find({ boardId })
      .select('tipoEvento horaInicio horaFinalizacion duracionSegundos fase tensionResidual -_id')
      .lean();

    return res.status(200).json({ success: true, events });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};