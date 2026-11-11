import { Subscription } from '../models/Subscription.js';
import { PaymentHistory } from '../models/PaymentHistory.js';
import Company from '../models/Company.js'; // Tu modelo actual de Empresa
import User from '../models/User.js';       // Tu modelo actual de Usuario

/**
 * Obtener listado de empresas con su suscripción para la tabla de ventas
 * GET /api/sales
 */
export const getSalesDashboardData = async (req, res) => {
  try {
    const companies = await Company.find().lean();
    const salesData = [];

    const now = new Date();

    for (const comp of companies) {
      // Buscar suscripción asociada o asumir básica si no existe aún
      let sub = await Subscription.findOne({ companyId: comp._id });
      
      // Buscar contacto principal (ADMIN de la empresa)
      const contact = await User.findOne({ companyId: comp._id, role: 'ADMIN' }).lean();

      // Buscar último pago realizado
      const lastPayment = await PaymentHistory.findOne({ companyId: comp._id })
        .sort({ fechaPago: -1 })
        .lean();

      // Evaluar estado en tiempo real según fecha y hora exacta
      let currentStatus = sub ? sub.status : 'active';
      if (sub && sub.plan === 'empresarial' && sub.endDate) {
        if (now > new Date(sub.endDate)) {
          currentStatus = 'expired';
          if (sub.status !== 'expired') {
            sub.status = 'expired';
            await sub.save();
          }
        } else {
          currentStatus = 'active';
        }
      }

      salesData.push({
        id: comp._id,
        nombre: contact?.firstName || comp.contactName || 'Sin asignar',
        apellido: contact?.lastName || '',
        email: contact?.email || comp.email || '',
        telefono: contact?.phone || comp.phone || '',
        ruc: comp.ruc || '',
        razonSocial: comp.name || comp.razonSocial || '',
        comoLlego: comp.source || 'Directo',
        role: contact?.role || 'ADMIN',
        plan: sub ? sub.plan : 'basico',
        status: currentStatus,
        fechaRegistro: comp.createdAt,
        fechaVencimiento: sub?.endDate ? sub.endDate.toISOString() : undefined,
        montoAcordadoMensual: sub?.montoAcordadoMensual || 0,
        scope: sub?.scope || { tableros: 1, spatPozos: 0, subestaciones: 0, instalacionesSolares: 0 },
        nroOperacion: sub?.nroOperacionActual || lastPayment?.nroOperacion || '',
      });
    }

    res.status(200).json(salesData);
  } catch (error) {
    console.error('Error en getSalesDashboardData:', error);
    res.status(500).json({ message: 'Error al obtener datos de ventas.' });
  }
};

/**
 * Activar o renovar plan empresarial
 * POST /api/sales/:companyId/activate
 */
export const activateOrRenewSubscription = async (req, res) => {
  try {
    const { companyId } = req.params;
    const {
      tableros,
      spatPozos,
      subestaciones,
      instalacionesSolares,
      duracionMeses,
      montoCobrado,
      banco,
      nroOperacion,
      observaciones,
    } = req.body;

    const ahora = new Date();
    let sub = await Subscription.findOne({ companyId });

    // Si aún no vence, extender a partir de la fecha fin existente; si ya venció, contar desde hoy
    let baseDate = ahora;
    if (sub && sub.endDate && new Date(sub.endDate) > ahora) {
      baseDate = new Date(sub.endDate);
    }

    const nuevaFechaFin = new Date(baseDate);
    nuevaFechaFin.setMonth(nuevaFechaFin.getMonth() + parseInt(duracionMeses, 10));

    const scope = {
      tableros: Number(tableros) || 1,
      spatPozos: Number(spatPozos) || 0,
      subestaciones: Number(subestaciones) || 0,
      instalacionesSolares: Number(instalacionesSolares) || 0,
    };

    const montoMensualCalculado = Math.round(Number(montoCobrado) / parseInt(duracionMeses, 10));

    // 1. Guardar o actualizar la suscripción
    sub = await Subscription.findOneAndUpdate(
      { companyId },
      {
        plan: 'empresarial',
        status: 'active',
        montoAcordadoMensual: montoMensualCalculado,
        scope,
        startDate: ahora,
        endDate: nuevaFechaFin,
        nroOperacionActual: nroOperacion,
        notified5DaysBefore: false,
        notifiedDayOfExpiration: false,
      },
      { upsert: true, new: true }
    );

    // 2. Registrar el comprobante en PaymentHistory
    const inicioStr = ahora.toLocaleString('es-PE', { dateStyle: 'short', timeStyle: 'short' });
    const finStr = nuevaFechaFin.toLocaleString('es-PE', { dateStyle: 'short', timeStyle: 'short' });

    const comprobante = await PaymentHistory.create({
      companyId,
      fechaPago: ahora,
      nroOperacion,
      banco,
      monto: Number(montoCobrado),
      duracionMeses: parseInt(duracionMeses, 10),
      plan: 'empresarial',
      scope,
      periodoTexto: `${inicioStr} al ${finStr}`,
      validadoPor: req.user?.name || 'Ana Ventas',
      notas: observaciones || 'Activación manual desde panel de ventas',
    });

    // 3. Elevar rol del usuario principal a ADMIN si estuviera en USER
    await User.updateMany({ companyId, role: 'USER' }, { $set: { role: 'ADMIN' } });

    res.status(200).json({
      message: 'Suscripción activada con éxito',
      subscription: sub,
      comprobante,
    });
  } catch (error) {
    console.error('Error en activateOrRenewSubscription:', error);
    res.status(500).json({ message: 'Error al activar/renovar suscripción.' });
  }
};

/**
 * Obtener detalle completo de suscripción e historial de pagos
 * GET /api/sales/:companyId/subscription
 */
export const getSubscriptionDetail = async (req, res) => {
  try {
    const { companyId } = req.params;

    const company = await Company.findById(companyId).lean();
    if (!company) {
      return res.status(404).json({ message: 'Empresa no encontrada.' });
    }

    const sub = await Subscription.findOne({ companyId }).lean();
    const contact = await User.findOne({ companyId, role: 'ADMIN' }).lean();
    const historialPagos = await PaymentHistory.find({ companyId })
      .sort({ fechaPago: -1 })
      .lean();

    res.status(200).json({
      id: company._id,
      razonSocial: company.name || company.razonSocial,
      ruc: company.ruc,
      nombre: contact?.firstName || company.contactName || '',
      apellido: contact?.lastName || '',
      email: contact?.email || company.email || '',
      telefono: contact?.phone || company.phone || '',
      plan: sub ? sub.plan : 'basico',
      fechaVencimiento: sub?.endDate ? sub.endDate.toISOString() : undefined,
      montoAcordadoMensual: sub?.montoAcordadoMensual || 0,
      scope: sub?.scope || { tableros: 1, spatPozos: 0, subestaciones: 0, instalacionesSolares: 0 },
      historialPagos: historialPagos.map((p) => ({
        id: p._id,
        fechaPago: p.fechaPago.toISOString(),
        nroOperacion: p.nroOperacion,
        banco: p.banco,
        monto: p.monto,
        duracionMeses: p.duracionMeses,
        plan: p.plan,
        scope: p.scope,
        periodo: p.periodoTexto,
        validadoPor: p.validadoPor,
        notas: p.notas,
      })),
    });
  } catch (error) {
    console.error('Error en getSubscriptionDetail:', error);
    res.status(500).json({ message: 'Error al obtener detalle de la suscripción.' });
  }
};