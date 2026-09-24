import Board from "../models/Board.js";
import Company from "../models/Company.js";
import { v4 as uuidv4 } from "uuid";
import { uploadToCloudinary } from "../utils/uploadToCloudinary.js";
import cloudinary from "../config/cloudinary.js";
import Measurement from "../models/Measurement.js";
import Thermography from "../models/Thermography.js";
import VoltageEvent from "../models/VoltageEvent.js";
import mongoose from "mongoose";

/**
 * =========================
 * 🔒 PRIVADO
 * =========================
 */

// ✅ Crear tablero
export const createBoard = async (req, res) => {
    try {
        const {
            name,
            type,
            tensionNominal,
            numeroFases,
            incluyeNeutro,
            sistema,
            estadoGeneral,
            location,
            description,
            boardCode,
            circuits,
            // mainBreaker,
            // proteccion,
        } = req.body;

        // if (!name || !type || !boardCode) {
        //     return res
        //         .status(400)
        //         .json({ message: "name, type y boardCode son obligatorios" });
        // }

        // if (
        //     tensionNominal === undefined ||
        //     numeroFases === undefined ||
        //     incluyeNeutro === undefined
        // ) {
        //     return res.status(400).json({
        //         message:
        //             "tensionNominal, numeroFases e incluyeNeutro son obligatorios",
        //     });
        // }

        if (!name || !boardCode) {
            return res
                .status(400)
                .json({ message: "name y boardCode son obligatorios" });
        }

        if (incluyeNeutro === undefined) {
            return res.status(400).json({
                message: "incluyeNeutro es obligatorio",
            });
        }

        if (!req.user) {
            return res.status(401).json({ message: "No autorizado" });
        }

        const company = await Company.findOne({
            publicCode: req.body.companyPublicCode,
        });

        if (!company) {
            return res.status(404).json({ message: "Empresa no encontrada" });
        }

        // =========================
        // 🖼 IMÁGENES
        // =========================
        const imageFields = ["tablero", "unifilar", "termografia"];

        const images = {
            tablero: [],
            unifilar: [],
            termografia: [],
        };

        for (const field of imageFields) {
            const files = req.files?.[field] || [];

            for (const file of files) {
                const { url } = await uploadToCloudinary(
                    file.buffer,
                    `boards/${field}`,
                );
                images[field].push(url);
            }
        }

        // =========================
        // ⚡ CIRCUITS
        // =========================
        let parsedCircuits = [];

        if (circuits) {
            parsedCircuits =
                typeof circuits === "string" ? JSON.parse(circuits) : circuits;
        }

        // Convertimos strings vacíos o NaN en undefined de forma segura antes de guardar
        const cleanTension =
            tensionNominal === "" || isNaN(Number(tensionNominal))
                ? undefined
                : Number(tensionNominal);

        const cleanFases =
            numeroFases === "" || isNaN(Number(numeroFases))
                ? undefined
                : Number(numeroFases);

        const board = await Board.create({
            code: uuidv4(),
            boardCode: boardCode.trim(),
            name: name.trim(),
            type: type ? type.trim() : undefined,
            // 👈 Usamos las variables ya limpias aquí
            tensionNominal: cleanTension,
            numeroFases: cleanFases,
            incluyeNeutro: incluyeNeutro === true || incluyeNeutro === "true",
            sistema,
            estadoGeneral,
            location: location?.trim() || "",
            description: description?.trim() || "",
            circuits: parsedCircuits,
            // mainBreaker:
            //     typeof mainBreaker === "string"
            //         ? JSON.parse(mainBreaker)
            //         : mainBreaker,
            // proteccion:
            //     typeof proteccion === "string"
            //         ? JSON.parse(proteccion)
            //         : proteccion,
            images,
            companyPublicCode: company.publicCode,
            createdBy: req.user._id,

            nfpa: undefined
        });

        return res.status(201).json({
            message: "Tablero creado correctamente",
            board: {
                ...board.toObject(),
                company: {
                    name: company.name,
                    publicCode: company.publicCode,
                },
            },
        });
    } catch (error) {
        return res.status(500).json({
            message: "Error al crear tablero",
            error: error.message,
        });
    }
};

// ✅ FUNCIÓN CORREGIDA getCompanyBoards:
export const getCompanyBoards = async (req, res) => {
  try {
    let { publicCode } = req.params;

    if (!req.user) {
      return res.status(401).json({ message: "No autorizado" });
    }

    // Para ADMIN o USER, usamos companyPublicCode guardado en el usuario
    if (req.user.role === "ADMIN" || req.user.role === "USER") {
      publicCode = typeof req.user.companyPublicCode === "string"
        ? req.user.companyPublicCode
        : req.user.companyPublicCode?.publicCode;
    }

    if (!publicCode) {
      return res.status(400).json({ message: "Código de empresa no proporcionado" });
    }

    const company = await Company.findOne({ publicCode });
    if (!company) {
      return res.status(404).json({ message: "Empresa no encontrada" });
    }

    const boards = await Board.find({
      companyPublicCode: publicCode,
    }).sort({ createdAt: -1 });

    return res.json({ company, boards });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// ── HELPER: Filtra los datos sensibles del tablero según el plan del usuario ──
const sanitizeBoardByPlan = (boardObj, plan = "basico") => {
    const sanitized = { ...boardObj };

    // PLAN BÁSICO: Solo fotos de tablero e información general / leyenda
    if (plan === "basico") {
        if (sanitized.images) {
            sanitized.images = {
                tablero: sanitized.images.tablero || []
                // Eliminamos unifilar y termografia para que no viajen como []
            };
        }
        delete sanitized.nfpa;
        delete sanitized.insulationMeasurements; // Solo accesible en planes superiores/empresarial
        sanitized.assignedDocuments = [];
    } 
    // PLAN INTERMEDIO: Añade Unifilar y Certificados. Oculta Termografía, NFPA y SPAT
    else if (plan === "intermedio") {
        if (sanitized.images) {
            sanitized.images = {
                tablero: sanitized.images.tablero || [],
                unifilar: sanitized.images.unifilar || []
            };
        }
        delete sanitized.nfpa;
        delete sanitized.insulationMeasurements;
    }

    // PLAN EMPRESARIAL: Mantiene todos los datos sin modificar
    return sanitized;
};

// ✅ Obtener tablero por código (PRIVADO)
export const getBoardByCode = async (req, res) => {
    try {
        const { publicCode, code } = req.params;

        const company = await Company.findOne({ publicCode });
        if (!company) {
            return res.status(404).json({ message: "Empresa no encontrada" });
        }

        if (req.user?.role === "ADMIN") {
            if (req.user.companyPublicCode !== publicCode) {
                return res
                    .status(403)
                    .json({ message: "No autorizado para esta empresa" });
            }
        }

        const board = await Board.findOne({
            code,
            companyPublicCode: publicCode,
        })
            .populate("createdBy", "firstname lastname email")
            .populate("assignedDocuments");

        if (!board) {
            return res.status(404).json({
                message: "Tablero no encontrado en la base de datos",
                buscado: { code, companyPublicCode: publicCode },
            });
        }

        // 🛡️ APLICAMOS LA RESTRICCIÓN SEGÚN EL PLAN DEL USUARIO
        const isSuperAdmin = req.user?.role === "SUPERADMIN";
        const userPlan = isSuperAdmin ? "empresarial" : (req.user?.plan || "basico");
        const sanitizedBoard = sanitizeBoardByPlan(board.toObject(), userPlan);

        return res.json({
            ...sanitizedBoard,
            company: {
                name: company.name,
                publicCode: company.publicCode,
            },
        });
    } catch (error) {
        return res.status(500).json({
            message: "Error al obtener tablero",
            error: error.message,
        });
    }
};

// ✅ Actualizar tablero
export const updateBoard = async (req, res) => {
    try {
        const {
            boardCode,
            name,
            type,
            tensionNominal,
            numeroFases,
            incluyeNeutro,
            sistema,
            estadoGeneral,
            location,
            description,
            circuits,
            // mainBreaker,
            // proteccion,
            existingUnifilar,
            existingTablero,
            existingTermografia,
        } = req.body;

        const { publicCode, code } = req.params;

        if (!req.user) {
            return res.status(401).json({ message: "No autorizado" });
        }

        const company = await Company.findOne({ publicCode });
        if (!company) {
            return res.status(404).json({ message: "Empresa no encontrada" });
        }

        const board = await Board.findOne({
            code,
            companyPublicCode: publicCode,
        });

        if (!board) {
            return res.status(404).json({ message: "Tablero no encontrado" });
        }

        // =========================
        // 🧾 DATOS
        // =========================
        if (boardCode !== undefined) board.boardCode = boardCode.trim();
        if (name !== undefined) board.name = name.trim();
        if (type !== undefined) board.type = type.trim();
        if (tensionNominal !== undefined)
            board.tensionNominal = Number(tensionNominal);
        if (numeroFases !== undefined) board.numeroFases = Number(numeroFases);
        if (incluyeNeutro !== undefined)
            board.incluyeNeutro =
                incluyeNeutro === "true" || incluyeNeutro === true;
        if (sistema !== undefined) board.sistema = sistema;
        if (estadoGeneral !== undefined) board.estadoGeneral = estadoGeneral;
        if (location !== undefined) board.location = location;
        if (description !== undefined) board.description = description;

        if (circuits !== undefined) {
            board.circuits =
                typeof circuits === "string" ? JSON.parse(circuits) : circuits;
        }

        // if (mainBreaker !== undefined) {
        //     board.mainBreaker =
        //         typeof mainBreaker === "string"
        //             ? JSON.parse(mainBreaker)
        //             : mainBreaker;
        // }

        // if (proteccion !== undefined) {
        //     board.proteccion =
        //         typeof proteccion === "string"
        //             ? JSON.parse(proteccion)
        //             : proteccion;
        // }

        // =========================
        // 🖼 IMÁGENES
        // =========================
        const parseArray = (data) => {
            if (!data) return [];
            return Array.isArray(data) ? data : JSON.parse(data);
        };

        const parsedExisting = {
            unifilar: parseArray(existingUnifilar),
            tablero: parseArray(existingTablero),
            termografia: parseArray(existingTermografia),
        };

        const imageFields = ["unifilar", "tablero", "termografia"];

        for (const field of imageFields) {
            const files = req.files?.[field] || [];

            const uploaded = [];

            for (const file of files) {
                const { url } = await uploadToCloudinary(
                    file.buffer,
                    `boards/${field}`,
                );
                uploaded.push(url);
            }

            board.images[field] = [...parsedExisting[field], ...uploaded];
        }

        await board.save();

        return res.json({
            message: "Tablero actualizado correctamente",
            board,
        });
    } catch (error) {
        return res.status(500).json({
            message: "Error al actualizar tablero",
            error: error.message,
        });
    }
};

// ✅ Eliminar tablero
// export const deleteBoard = async (req, res) => {
//     try {
//         const { publicCode, code } = req.params;

//         const company = await Company.findOne({ publicCode });
//         if (!company) {
//             return res.status(404).json({ message: "Empresa no encontrada" });
//         }

//         const board = await Board.findOne({
//             code,
//             companyPublicCode: publicCode,
//         });

//         if (!board) {
//             return res.status(404).json({ message: "Tablero no encontrado" });
//         }

//         const extractPublicId = (url) => {
//             const parts = url.split("/");
//             const file = parts[parts.length - 1];
//             return `boards/${file.split(".")[0]}`;
//         };

//         const allImages = [
//             ...(board.images?.tablero || []),
//             ...(board.images?.unifilar || []),
//             ...(board.images?.termografia || []),
//         ];

//         for (const url of allImages) {
//             try {
//                 const publicId = extractPublicId(url);
//                 await cloudinary.uploader.destroy(publicId);
//             } catch (err) {}
//         }

//         await board.deleteOne();

//         return res.json({
//             message: "Tablero eliminado correctamente",
//         });
//     } catch (error) {
//         return res.status(500).json({ message: error.message });
//     }
// };

// ✅ Eliminar tablero y todos sus datos relacionados (Borrado en cascada seguro)
export const deleteBoard = async (req, res) => {
  try {
    const { publicCode, code } = req.params;

    const company = await Company.findOne({ publicCode });
    if (!company) {
      return res.status(404).json({ message: "Empresa no encontrada" });
    }

    const board = await Board.findOne({
      code,
      companyPublicCode: publicCode,
    });

    if (!board) {
      return res.status(404).json({ message: "Tablero no encontrado" });
    }

    // -------------------------------------------------------------
    // 1. Filtro seguro de boardId (ObjectId vs String)
    // -------------------------------------------------------------
    // Creamos filtros que no fuercen error de casteo en modelos con boardId tipo ObjectId
    const objectIdFilter = mongoose.Types.ObjectId.isValid(board._id)
      ? [{ boardId: board._id }]
      : [];

    const stringOrCodeFilter = [
      { boardId: String(board._id) },
      { boardId: board.code },
    ];

    // Para modelos con schema boardId: ObjectId
    const strictObjectIdQuery = { $or: objectIdFilter };

    // Para modelos flexibles o indexados como String
    const flexibleQuery = { $or: [...objectIdFilter, ...stringOrCodeFilter] };

    // -------------------------------------------------------------
    // 2. Limpieza de imágenes del tablero en Cloudinary
    // -------------------------------------------------------------
    const extractPublicId = (url) => {
      if (!url) return null;
      const parts = url.split("/");
      const file = parts[parts.length - 1];
      return `boards/${file.split(".")[0]}`;
    };

    const allBoardImages = [
      ...(board.images?.tablero || []),
      ...(board.images?.unifilar || []),
      ...(board.images?.termografia || []),
    ];

    for (const url of allBoardImages) {
      try {
        const publicId = extractPublicId(url);
        if (publicId) await cloudinary.uploader.destroy(publicId);
      } catch (err) {
        console.error("Error al borrar imagen de Cloudinary:", err.message);
      }
    }

    // -------------------------------------------------------------
    // 3. Limpieza de imágenes de Termografía en Cloudinary
    // -------------------------------------------------------------
    try {
      const thermographyRecords = await Thermography.find(strictObjectIdQuery);
      for (const thermo of thermographyRecords) {
        const urlsToClean = [thermo.thermalImageUrl, thermo.originalImageUrl].filter(
          (url) => url && !url.startsWith("data:")
        );
        for (const url of urlsToClean) {
          try {
            const parts = url.split("/");
            const file = parts[parts.length - 1];
            await cloudinary.uploader.destroy(`boards/termografia/${file.split(".")[0]}`);
          } catch (err) {
            console.error("Error al borrar imagen de termografía en Cloudinary:", err.message);
          }
        }
      }
    } catch (err) {
      console.warn("Aviso al consultar imágenes de termografía:", err.message);
    }

    // -------------------------------------------------------------
    // 4. Borrado en cascada en la base de datos
    // -------------------------------------------------------------
    const deleteOperations = [];

    // Colecciones con Schema donde boardId es ObjectId
    if (objectIdFilter.length > 0) {
      deleteOperations.push(
        Measurement.deleteMany(strictObjectIdQuery).catch(() =>
          Measurement.deleteMany(flexibleQuery)
        ),
        Thermography.deleteMany(strictObjectIdQuery).catch(() =>
          Thermography.deleteMany(flexibleQuery)
        ),
        VoltageEvent.deleteMany(strictObjectIdQuery).catch(() =>
          VoltageEvent.deleteMany(flexibleQuery)
        )
      );
    } else {
      deleteOperations.push(
        Measurement.deleteMany(flexibleQuery),
        Thermography.deleteMany(flexibleQuery),
        VoltageEvent.deleteMany(flexibleQuery)
      );
    }

    // Eliminación final del registro del tablero
    deleteOperations.push(board.deleteOne());

    await Promise.all(deleteOperations);

    return res.json({
      message: "Tablero y todos sus registros asociados eliminados correctamente",
      deletedBoardId: board._id,
      deletedCode: board.code,
    });
  } catch (error) {
    return res.status(500).json({
      message: "Error al eliminar el tablero y sus registros asociados",
      error: error.message,
    });
  }
};

/**
 * =========================
 * 🌐 PÚBLICO
 * =========================
 */

// ✅ VERIFICA/REEMPLAZA EN controllers/board.controller.js:
export const publicGetCompanyBoards = async (req, res) => {
  try {
    const { publicCode } = req.params;

    const company = await Company.findOne({ publicCode });
    if (!company) {
      return res.status(404).json({ message: "Empresa no encontrada" });
    }

    const boards = await Board.find({ companyPublicCode: publicCode })
      .select(
        "code boardCode name type tensionNominal numeroFases incluyeNeutro location description images nfpa createdAt",
      )
      .sort({ createdAt: -1 });

    return res.json({
      company: {
        name: company.name,
        publicCode: company.publicCode,
      },
      boards,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const publicGetCompanyBoardByCode = async (req, res) => {
    try {
        const { publicCode, code } = req.params;

        const company = await Company.findOne({ publicCode });
        if (!company) {
            return res.status(404).json({ message: "Empresa no encontrada" });
        }

        const board = await Board.findOne({
            code,
            companyPublicCode: publicCode,
        }).populate("assignedDocuments");

        if (!board) {
            return res.status(404).json({ message: "Tablero no encontrado" });
        }

        // 🛡️ En accesos públicos (escaneo de QR) sanitizamos según el plan real contratado por la empresa
        const companyPlan = company.plan || "basico";
        const sanitizedBoard = sanitizeBoardByPlan(board.toObject(), companyPlan);

        return res.json({
            ...sanitizedBoard,
            company: {
                name: company.name,
                publicCode: company.publicCode,
            },
        });
    } catch (error) {
        return res.status(500).json({ message: error.message });
    }
};

// ✅ Asignar documentos previamente subidos a un tablero específico
export const assignDocumentsToBoard = async (req, res) => {
    try {
        const { publicCode, code } = req.params;
        const { documentIds } = req.body; // Se espera un array: ["id_doc_1", "id_doc_2"]

        if (!Array.isArray(documentIds)) {
            return res.status(400).json({
                message:
                    "documentIds es requerido y debe ser un arreglo de IDs",
            });
        }

        // Buscamos el tablero usando la misma lógica de tus rutas existentes (publicCode y code)
        const board = await Board.findOne({
            code,
            companyPublicCode: publicCode,
        });

        if (!board) {
            return res.status(404).json({ message: "Tablero no encontrado" });
        }

        // Reemplazamos las asignaciones viejas por las nuevas seleccionadas en el frontend
        board.assignedDocuments = documentIds;
        await board.save();

        // Devolvemos el tablero con la información completa de los documentos
        const populatedBoard = await Board.findById(board._id).populate(
            "assignedDocuments",
        );

        return res.status(200).json({
            message: "Documentos asignados correctamente",
            assignedDocuments: populatedBoard.assignedDocuments,
        });
    } catch (error) {
        return res.status(500).json({
            message: "Error al asignar documentos al tablero",
            error: error.message,
        });
    }
};
