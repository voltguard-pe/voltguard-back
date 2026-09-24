import AdmZip from "adm-zip";
import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";

import openai from "../config/openai.js";
import Board from "../models/Board.js";
import Company from "../models/Company.js";
import cloudinary from "../config/cloudinary.js";

const UNIT_MOHM = "MΩ";
const ALLOWED_IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png"];

const insulationTableSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    boardCode: {
      type: "string",
    },
    unit: {
      type: "string",
      enum: [UNIT_MOHM],
    },
    rows: {
      type: "array",
      minItems: 1,
      maxItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          description: {
            type: "string",
            enum: ["Barras generales"],
          },
          measurement_l1_g: {
            type: ["number", "null"],
          },
          measurement_l2_g: {
            type: ["number", "null"],
          },
          measurement_l3_g: {
            type: ["number", "null"],
          },
          unit: {
            type: "string",
            enum: [UNIT_MOHM],
          },
        },
        required: [
          "description",
          "measurement_l1_g",
          "measurement_l2_g",
          "measurement_l3_g",
          "unit",
        ],
      },
    },
    warnings: {
      type: "array",
      items: {
        type: "string",
      },
    },
    summary: {
      type: "string",
    },
  },
  required: ["boardCode", "unit", "rows", "warnings", "summary"],
};

const createWorkDir = () => {
  const workDir = path.join("./uploads", `extracted-insulation-${uuidv4()}`);
  fs.mkdirSync(workDir, { recursive: true });
  return workDir;
};

const cleanupFiles = (filePath, workDir) => {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    if (workDir && fs.existsSync(workDir)) {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  } catch (err) {
    console.error("Error limpiando archivos de aislamiento:", err);
  }
};

const validateZipFile = (req) => {
  if (!req.file) {
    throw new Error("Debes subir un archivo ZIP en el campo 'file'.");
  }

  if (!req.file.originalname.toLowerCase().endsWith(".zip")) {
    throw new Error("Solo se permite subir archivo .zip.");
  }
};

const resolveCompanyPublicCode = async (req) => {
  const publicCode =
    req.body.companyCode ||
    req.body.company_code ||
    req.body.publicCode ||
    req.params.companyCode ||
    req.params.publicCode;

  if (!publicCode) {
    throw new Error(
      "Debes enviar el publicCode de la empresa en el campo 'companyCode'."
    );
  }

  const company = await Company.findOne({ publicCode }).select(
    "publicCode name"
  );

  if (!company) {
    throw new Error(`No existe una empresa con publicCode: ${publicCode}`);
  }

  return company.publicCode;
};

const extractZip = (zipPath, workDir) => {
  const zip = new AdmZip(zipPath);
  zip.extractAllTo(workDir, true);
};

const isSystemFile = (filePath) => {
  const normalized = filePath.replaceAll("\\", "/");
  const base = path.basename(filePath);

  return (
    normalized.includes("__MACOSX") ||
    base.startsWith(".") ||
    base === "Thumbs.db"
  );
};

const getAllFilesRecursive = (dir) => {
  const result = [];
  const entries = fs.readdirSync(dir);

  for (const entry of entries) {
    const fullPath = path.join(dir, entry);
    const stat = fs.statSync(fullPath);

    if (stat.isDirectory()) {
      result.push(...getAllFilesRecursive(fullPath));
    } else if (!isSystemFile(fullPath)) {
      result.push(fullPath);
    }
  }

  return result;
};

const isAllowedImageFile = (filePath) => {
  const ext = path.extname(filePath).toLowerCase();
  return ALLOWED_IMAGE_EXTENSIONS.includes(ext);
};

const getBoardCodeFromFilename = (filePath) => {
  const base = path.basename(filePath, path.extname(filePath));
  const boardCode = base.split("_")[0];

  return boardCode ? boardCode.trim().toUpperCase() : null;
};

const groupImagesByBoardCode = (workDir) => {
  const allFiles = getAllFilesRecursive(workDir);

  const invalidFiles = allFiles.filter(
    (filePath) => !isAllowedImageFile(filePath)
  );

  const imageFiles = allFiles.filter(isAllowedImageFile);

  const groups = {};

  for (const filePath of imageFiles) {
    const boardCode = getBoardCodeFromFilename(filePath);

    if (!boardCode) continue;

    if (!groups[boardCode]) {
      groups[boardCode] = {
        boardCode,
        boardImages: [],
      };
    }

    groups[boardCode].boardImages.push(filePath);
  }

  return {
    groups,
    invalidFiles,
  };
};

const fileToDataUrl = (filePath) => {
  const ext = path.extname(filePath).toLowerCase();

  const mimeByExt = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
  };

  const mimeType = mimeByExt[ext] || "image/jpeg";
  const base64 = fs.readFileSync(filePath).toString("base64");

  return `data:${mimeType};base64,${base64}`;
};

const uploadImageToCloudinary = async (filePath, boardCode, type) => {
  const upload = await cloudinary.uploader.upload(filePath, {
    folder: `insulation-measurements/${boardCode}/${type}`,
  });

  return upload.secure_url;
};

const buildAiPrompt = ({ boardCode, board }) => {
  const boardContext = {
    boardCode: board.boardCode,
    name: board.name,
    sistema: board.sistema || null,
    numeroFases: board.numeroFases || null,
    incluyeNeutro: board.incluyeNeutro ?? null,
    tensionNominal: board.tensionNominal || null,
    type: board.type || null,
  };

  return `
Analiza la foto del tablero ${boardCode}.

La imagen contiene apuntes manuscritos de mediciones de aislamiento ubicados únicamente en la zona del INTERRUPTOR GENERAL o en sus conductores principales.

OBJETIVO:
Extraer SOLO las mediciones generales de aislamiento de las barras/fases principales del tablero.

Debes devolver UNA SOLA FILA con esta estructura:
- description
- measurement_l1_g
- measurement_l2_g
- measurement_l3_g
- unit

REGLA PRINCIPAL:
- No analices circuitos derivados.
- No devuelvas circuitos como IG, C-1, C-2, etc.
- No devuelvas circuitType.
- No devuelvas confidence.
- No devuelvas observation dentro de la fila.
- Solo devuelve una fila con description = "Barras generales".
- Las mediciones corresponden a fase-tierra.
- La unidad siempre es MΩ.

TIPOS DE TABLERO:

1. TABLERO TRIFÁSICO:
- Tiene tres fases.
- Se pueden observar hasta tres apuntes manuscritos junto al interruptor general.
- Debes asignarlos así:
  - primera fase detectada: measurement_l1_g
  - segunda fase detectada: measurement_l2_g
  - tercera fase detectada: measurement_l3_g

2. TABLERO MONOFÁSICO FASE-FASE:
- Tiene dos conductores activos.
- Puede tener dos apuntes.
- Debes asignarlos así:
  - primera fase detectada: measurement_l1_g
  - segunda fase detectada: measurement_l2_g
  - measurement_l3_g = null

3. TABLERO MONOFÁSICO FASE-NEUTRO:
- Tiene una fase y un neutro.
- Solo se mide el cable de fase.
- Debes asignar:
  - measurement_l1_g = valor leído
  - measurement_l2_g = null
  - measurement_l3_g = null

CÓMO DETERMINAR CUÁNTAS MEDICIONES USAR:
- Usa primero la información registrada del tablero.
- Si sistema = "TRIFÁSICO" o numeroFases = 3, considera que pueden existir L1-G, L2-G y L3-G.
- Si sistema = "MONOFÁSICO", considera que solo pueden existir L1-G y L2-G como máximo.
- Si sistema = "MONOFÁSICO" e incluyeNeutro = true, considera que solo debe existir L1-G.
- Si sistema = "MONOFÁSICO" e incluyeNeutro = false, considera que pueden existir L1-G y L2-G.
- Si la información del tablero no es suficiente, usa la foto para inferir la cantidad de conductores del interruptor general.

CÓMO LEER LA FOTO:
- Busca solo números manuscritos cerca del interruptor general.
- Los números pueden estar arriba, abajo o al costado del interruptor general.
- Los números pueden estar señalados con líneas hacia los conductores principales.
- Cada número manuscrito es una medición en MΩ.
- Ignora números impresos, marcas, modelos, amperajes, tensiones, capacidades o textos del interruptor.
- Ignora apuntes ubicados en interruptores derivados.

REGLAS DE SALIDA:
- Devuelve exactamente una fila en rows.
- description siempre debe ser "Barras generales".
- unit siempre debe ser "MΩ".
- Si una medición no se ve claramente, usa null.
- No inventes valores.
- No devuelvas texto fuera del JSON.

Información registrada del tablero:
${JSON.stringify(boardContext, null, 2)}
  `.trim();
};

const analyzeBoardWithOpenAI = async ({ boardCode, board, boardImagePath }) => {
  const response = await openai.responses.create({
    model: process.env.OPENAI_MODEL || "gpt-5.5",

    input: [
      {
        role: "system",
        content: `
Eres un asistente especializado en tableros eléctricos y mediciones de aislamiento.

Debes devolver exclusivamente JSON según el esquema solicitado.
No inventes mediciones.
Solo analiza el interruptor general.
Si no puedes leer un dato con claridad, usa null y explica en observation.
        `.trim(),
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: buildAiPrompt({
              boardCode,
              board,
            }),
          },
          {
            type: "input_image",
            image_url: fileToDataUrl(boardImagePath),
            detail: "high",
          },
        ],
      },
    ],

    reasoning: {
      effort: "low",
    },

    text: {
      verbosity: "low",
      format: {
        type: "json_schema",
        name: "insulation_measurement_table",
        strict: true,
        schema: insulationTableSchema,
      },
    },

    max_output_tokens: 2500,
    store: false,
  });

  try {
    return JSON.parse(response.output_text);
  } catch {
    throw new Error(
      `OpenAI respondió, pero no se pudo convertir la respuesta a JSON para ${boardCode}.`
    );
  }
};

export const validateInsulationZip = async (req, res) => {
  let workDir = null;

  try {
    validateZipFile(req);

    workDir = createWorkDir();
    extractZip(req.file.path, workDir);

    const companyPublicCode = await resolveCompanyPublicCode(req);

    const { groups, invalidFiles } = groupImagesByBoardCode(workDir);
    const boardCodes = Object.keys(groups);

    const errors = [];
    const warnings = [];

    if (invalidFiles.length > 0) {
      errors.push(
        `El ZIP contiene archivos no permitidos. Solo se aceptan imágenes .jpg, .jpeg o .png. Archivos inválidos: ${invalidFiles
          .map((file) => path.basename(file))
          .join(", ")}`
      );
    }

    if (boardCodes.length === 0) {
      errors.push(
        "No se encontraron imágenes con código de tablero. Usa nombres como T0001.jpg, T0002.jpeg o T0003.png."
      );
    }

    const boards = await Board.find({
      companyPublicCode,
      boardCode: { $in: boardCodes },
    }).select("boardCode");

    const boardMap = new Map(boards.map((board) => [board.boardCode, board]));

    for (const boardCode of boardCodes) {
      const group = groups[boardCode];
      const board = boardMap.get(boardCode);

      if (!board) {
        errors.push(
          `No existe el tablero ${boardCode}. Primero debes importar o registrar el tablero.`
        );
        continue;
      }

      if (group.boardImages.length === 0) {
        errors.push(
          `Falta la foto del tablero ${boardCode}. Debe llamarse ${boardCode}.jpg, ${boardCode}.jpeg o ${boardCode}.png.`
        );
      }

      if (group.boardImages.length > 1) {
        warnings.push(
          `${boardCode} tiene más de una foto. Se usará la primera.`
        );
      }
    }

    return res.json({
      ok: errors.length === 0,
      companyPublicCode,
      totalBoardsDetected: boardCodes.length,
      errors,
      warnings,
      boards: boardCodes.map((boardCode) => ({
        boardCode,
        existsInDb: boardMap.has(boardCode),
        boardImages: groups[boardCode].boardImages.map((file) =>
          path.basename(file)
        ),
      })),
    });
  } catch (error) {
    console.error("Error validando ZIP de aislamiento:", error);

    return res.status(400).json({
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "Error validando ZIP de aislamiento.",
    });
  } finally {
    cleanupFiles(req.file?.path, workDir);
  }
};

export const testInsulationZip = async (req, res) => {
  let workDir = null;

  try {
    validateZipFile(req);

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({
        ok: false,
        error: "Falta configurar OPENAI_API_KEY en .env.",
      });
    }

    workDir = createWorkDir();
    extractZip(req.file.path, workDir);

    const companyPublicCode = await resolveCompanyPublicCode(req);

    const { groups, invalidFiles } = groupImagesByBoardCode(workDir);
    const boardCodes = Object.keys(groups);

    if (invalidFiles.length > 0) {
      return res.status(400).json({
        ok: false,
        error:
          "El ZIP contiene archivos no permitidos. Solo se aceptan imágenes .jpg, .jpeg o .png.",
        invalidFiles: invalidFiles.map((file) => path.basename(file)),
      });
    }

    if (boardCodes.length === 0) {
      return res.status(400).json({
        ok: false,
        error:
          "No se encontraron imágenes con código de tablero. Usa nombres como T0001.jpg, T0002.jpeg o T0003.png.",
      });
    }

    const results = [];
    const errors = [];

    for (const boardCode of boardCodes) {
      const group = groups[boardCode];

      try {
        const board = await Board.findOne({
          boardCode,
          companyPublicCode,
        });

        if (!board) {
          errors.push({
            boardCode,
            error:
              "El tablero no existe. Primero debes importar o registrar el tablero.",
          });
          continue;
        }

        const boardImagePath = group.boardImages[0];

        if (!boardImagePath) {
          errors.push({
            boardCode,
            error: "Falta foto principal del tablero.",
          });
          continue;
        }

        const aiResult = await analyzeBoardWithOpenAI({
          boardCode,
          board,
          boardImagePath,
        });

        results.push({
          boardCode,
          board: {
            _id: board._id,
            boardCode: board.boardCode,
            name: board.name,
          },
          inputFiles: {
            boardImage: path.basename(boardImagePath),
          },
          table: aiResult,
        });
      } catch (error) {
        console.error(`Error probando prompt para ${boardCode}:`, error);

        errors.push({
          boardCode,
          error:
            error instanceof Error
              ? error.message
              : "Error probando prompt.",
        });
      }
    }

    return res.json({
      ok: errors.length === 0,
      mode: "TEST_ONLY_NO_SAVE",
      message:
        "Prueba de análisis IA completada. No se guardó nada en la base de datos.",
      companyPublicCode,
      processed: results.length,
      errors,
      results,
    });
  } catch (error) {
    console.error("Error probando ZIP de aislamiento:", error);

    return res.status(500).json({
      ok: false,
      error: "Error probando análisis de aislamiento.",
      details:
        error instanceof Error
          ? error.message
          : "Error interno desconocido.",
    });
  } finally {
    cleanupFiles(req.file?.path, workDir);
  }
};

export const runInsulationZip = async (req, res) => {
  let workDir = null;

  try {
    validateZipFile(req);

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({
        ok: false,
        error: "Falta configurar OPENAI_API_KEY en .env.",
      });
    }

    workDir = createWorkDir();
    extractZip(req.file.path, workDir);

    const companyPublicCode = await resolveCompanyPublicCode(req);
    const batchCode = uuidv4();

    const { groups, invalidFiles } = groupImagesByBoardCode(workDir);
    const boardCodes = Object.keys(groups);

    if (invalidFiles.length > 0) {
      return res.status(400).json({
        ok: false,
        error:
          "El ZIP contiene archivos no permitidos. Solo se aceptan imágenes .jpg, .jpeg o .png.",
        invalidFiles: invalidFiles.map((file) => path.basename(file)),
      });
    }

    if (boardCodes.length === 0) {
      return res.status(400).json({
        ok: false,
        error:
          "No se encontraron imágenes con código de tablero. Usa nombres como T0001.jpg, T0002.jpeg o T0003.png.",
      });
    }

    const results = [];
    const errors = [];

    for (const boardCode of boardCodes) {
      const group = groups[boardCode];

      try {
        const board = await Board.findOne({
          boardCode,
          companyPublicCode,
        });

        if (!board) {
          errors.push({
            boardCode,
            error:
              "El tablero no existe. Primero debes importar o registrar el tablero.",
          });
          continue;
        }

        const boardImagePath = group.boardImages[0];

        if (!boardImagePath) {
          errors.push({
            boardCode,
            error: "Falta foto principal del tablero.",
          });
          continue;
        }

        const boardImageUrl = await uploadImageToCloudinary(
          boardImagePath,
          boardCode,
          "board"
        );

        const aiResult = await analyzeBoardWithOpenAI({
          boardCode,
          board,
          boardImagePath,
        });

        const measurementRecord = {
          batchCode,
          unit: UNIT_MOHM,
          status: "PENDING_REVIEW",
          sourceImages: {
            boardImage: boardImageUrl,
          },
          rows: aiResult.rows,
          warnings: aiResult.warnings || [],
          rawAiResponse: aiResult,
          importedBy: req.user?._id || null,
          importedAt: new Date(),
        };

        board.insulationMeasurements.push(measurementRecord);
        await board.save();

        const savedMeasurement =
          board.insulationMeasurements[board.insulationMeasurements.length - 1];

        results.push({
          boardCode,
          boardId: board._id,
          measurementId: savedMeasurement?._id || null,
          totalRows: aiResult.rows.length,
          warnings: aiResult.warnings || [],
          table: aiResult,
        });
      } catch (error) {
        console.error(`Error procesando tablero ${boardCode}:`, error);

        errors.push({
          boardCode,
          error:
            error instanceof Error
              ? error.message
              : "Error procesando tablero.",
        });
      }
    }

    return res.json({
      ok: errors.length === 0,
      message: "Importación de mediciones de aislamiento finalizada.",
      companyPublicCode,
      batchCode,
      processed: results.length,
      errors,
      results,
    });
  } catch (error) {
    console.error("Error importando ZIP de aislamiento:", error);

    return res.status(500).json({
      ok: false,
      error: "Error importando mediciones de aislamiento.",
      details:
        error instanceof Error
          ? error.message
          : "Error interno desconocido.",
    });
  } finally {
    cleanupFiles(req.file?.path, workDir);
  }
};

export const createBoardInsulationMeasurement = async (req, res) => {
  try {
    const { code } = req.params;

    const board = await Board.findOne({ code });

    if (!board) {
      return res.status(404).json({
        ok: false,
        message: "Tablero no encontrado.",
      });
    }

    const description =
      typeof req.body.description === "string" && req.body.description.trim()
        ? req.body.description.trim()
        : "Barras generales";

    const measurementL1G = parseNullableNumber(req.body.measurement_l1_g);
    const measurementL2G = parseNullableNumber(req.body.measurement_l2_g);
    const measurementL3G = parseNullableNumber(req.body.measurement_l3_g);

    const isMonofasic = isMonofasicBoard(board);

    if (
      isMonofasic &&
      measurementL3G !== undefined &&
      measurementL3G !== null
    ) {
      return res.status(400).json({
        ok: false,
        message:
          "No se puede registrar Fase 3 - Tierra en un tablero monofásico. El campo debe permanecer bloqueado.",
      });
    }

    const measurementRecord = {
      batchCode: uuidv4(),
      unit: UNIT_MOHM,
      status: "CONFIRMED",
      sourceImages: {
        boardImage: null,
      },
      rows: [
        {
          description,
          measurement_l1_g:
            measurementL1G === undefined ? null : measurementL1G,
          measurement_l2_g:
            measurementL2G === undefined ? null : measurementL2G,
          measurement_l3_g: isMonofasic
            ? null
            : measurementL3G === undefined
              ? null
              : measurementL3G,
          unit: UNIT_MOHM,
        },
      ],
      warnings: [],
      rawAiResponse: null,
      importedBy: req.user?._id || null,
      importedAt: new Date(),
    };

    board.insulationMeasurements.push(measurementRecord);

    await board.save();

    const savedMeasurement =
      board.insulationMeasurements[board.insulationMeasurements.length - 1];

    return res.status(201).json({
      ok: true,
      message: "Tabla de mediciones de aislamiento registrada correctamente.",
      data: {
        boardId: board._id,
        code: board.code,
        boardCode: board.boardCode,
        sistema: board.sistema,
        numeroFases: board.numeroFases,
        bloqueaFase3Tierra: isMonofasic,
        measurement: savedMeasurement,
      },
    });
  } catch (error) {
    console.error("Error registrando mediciones de aislamiento:", error);

    return res.status(500).json({
      ok: false,
      message:
        error instanceof Error
          ? error.message
          : "Error registrando mediciones de aislamiento.",
    });
  }
};

const parseNullableNumber = (value) => {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;

  const numberValue = Number(value);

  if (Number.isNaN(numberValue)) {
    throw new Error("Las mediciones deben ser valores numéricos o null.");
  }

  return numberValue;
};

const isMonofasicBoard = (board) => {
  return board.sistema === "MONOFÁSICO" || Number(board.numeroFases) < 3;
};

const getMeasurementByIdOrLatest = (board, measurementId) => {
  if (!board.insulationMeasurements?.length) {
    return null;
  }

  if (measurementId) {
    return board.insulationMeasurements.id(measurementId);
  }

  return board.insulationMeasurements[board.insulationMeasurements.length - 1];
};

export const updateBoardInsulationMeasurement = async (req, res) => {
  try {
    const { code, measurementId } = req.params;

    const board = await Board.findOne({ code });

    if (!board) {
      return res.status(404).json({
        ok: false,
        message: "Tablero no encontrado.",
      });
    }

    const measurement = getMeasurementByIdOrLatest(board, measurementId);

    if (!measurement) {
      return res.status(404).json({
        ok: false,
        message: "El tablero no tiene mediciones de aislamiento registradas.",
      });
    }

    if (!measurement.rows?.length) {
      measurement.rows = [
        {
          description: "Barras generales",
          measurement_l1_g: null,
          measurement_l2_g: null,
          measurement_l3_g: null,
          unit: UNIT_MOHM,
        },
      ];
    }

    const row = measurement.rows[0];

    const description =
      typeof req.body.description === "string" && req.body.description.trim()
        ? req.body.description.trim()
        : row.description || "Barras generales";

    const measurementL1G = parseNullableNumber(req.body.measurement_l1_g);
    const measurementL2G = parseNullableNumber(req.body.measurement_l2_g);
    const measurementL3G = parseNullableNumber(req.body.measurement_l3_g);

    const isMonofasic = isMonofasicBoard(board);

    if (
      isMonofasic &&
      measurementL3G !== undefined &&
      measurementL3G !== null
    ) {
      return res.status(400).json({
        ok: false,
        message:
          "No se puede registrar Fase 3 - Tierra en un tablero monofásico. El campo debe permanecer bloqueado.",
      });
    }

    row.description = description;

    if (measurementL1G !== undefined) {
      row.measurement_l1_g = measurementL1G;
    }

    if (measurementL2G !== undefined) {
      row.measurement_l2_g = measurementL2G;
    }

    if (isMonofasic) {
      row.measurement_l3_g = null;
    } else if (measurementL3G !== undefined) {
      row.measurement_l3_g = measurementL3G;
    }

    row.unit = UNIT_MOHM;

    measurement.unit = UNIT_MOHM;
    measurement.status = "CONFIRMED";

    await board.save();

    return res.json({
      ok: true,
      message: "Mediciones de aislamiento actualizadas correctamente.",
      data: {
        boardId: board._id,
        code: board.code,
        boardCode: board.boardCode,
        sistema: board.sistema,
        numeroFases: board.numeroFases,
        bloqueaFase3Tierra: isMonofasic,
        measurement,
      },
    });
  } catch (error) {
    console.error("Error actualizando mediciones de aislamiento:", error);

    return res.status(500).json({
      ok: false,
      message:
        error instanceof Error
          ? error.message
          : "Error actualizando mediciones de aislamiento.",
    });
  }
};

export const deleteBoardInsulationMeasurement = async (req, res) => {
  try {
    const { code, measurementId } = req.params;

    const board = await Board.findOne({ code });

    if (!board) {
      return res.status(404).json({
        ok: false,
        message: "Tablero no encontrado.",
      });
    }

    if (!board.insulationMeasurements?.length) {
      return res.status(404).json({
        ok: false,
        message: "El tablero no tiene mediciones de aislamiento registradas.",
      });
    }

    if (measurementId) {
      const measurement = board.insulationMeasurements.id(measurementId);

      if (!measurement) {
        return res.status(404).json({
          ok: false,
          message: "Registro de medición no encontrado.",
        });
      }

      measurement.deleteOne();
    } else {
      board.insulationMeasurements = [];
    }

    await board.save();

    return res.json({
      ok: true,
      message: measurementId
        ? "Registro de medición eliminado correctamente."
        : "Tabla de mediciones de aislamiento eliminada correctamente.",
      data: {
        boardId: board._id,
        code: board.code,
        boardCode: board.boardCode,
        remainingMeasurements: board.insulationMeasurements.length,
      },
    });
  } catch (error) {
    console.error("Error eliminando mediciones de aislamiento:", error);

    return res.status(500).json({
      ok: false,
      message:
        error instanceof Error
          ? error.message
          : "Error eliminando mediciones de aislamiento.",
    });
  }
};