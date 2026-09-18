import path from "path";
import { v4 as uuidv4 } from "uuid";
import AdmZip from "adm-zip";

import openai from "../config/openai.js";
import cloudinary from "../config/cloudinary.js";
import Board from "../models/Board.js";
import Company from "../models/Company.js";

// ==========================================
// UTILIDADES GENERALES & CLOUDINARY
// ==========================================

const bufferToDataUrl = (buffer, mimetype) => {
    const base64 = buffer.toString("base64");
    return `data:${mimetype};base64,${base64}`;
};

const getMimeTypeFromFileName = (filename) => {
    const ext = path.extname(filename).toLowerCase();
    const mimeTypes = {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".webp": "image/webp",
    };
    return mimeTypes[ext] || "image/jpeg";
};

const getImageKindFromFileName = (filename) => {
    const name = filename.toLowerCase();

    if (name.includes("unifilar")) return "unifilar";
    if (name.includes("_itm") || name.includes("interruptor") || name.includes("breaker")) return "itm";
    if (name.includes("termografia") || name.includes("termica")) return "termografia";
    if (name.includes("normal") || name.includes("tablero")) return "tablero";

    return "tablero";
};

const getBoardCodeFromFileName = (filename) => {
    // path.basename asegura que se tome únicamente "REC-MOL-TE-003_unifilar.png" ignorando subcarpetas
    const baseName = path.basename(filename);
    const nameWithoutExt = path.parse(baseName).name;

    // Extrae todo lo que esté antes del tipo (_unifilar, _itm, _termografia, _normal)
    return nameWithoutExt.split("_")[0].trim().toUpperCase();
};

const uploadBoardImageToCloudinary = async ({ buffer, boardCode, originalName, kind }) => {
    return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
            {
                folder: `boards/${boardCode}/${kind}`,
                resource_type: "image",
                public_id: `${kind}_${Date.now()}_${path.parse(originalName).name}`,
            },
            (error, result) => {
                if (error) return reject(error);
                resolve(result.secure_url);
            }
        );
        stream.end(buffer);
    });
};

// ==========================================
// SCHEMAS Y ANALISIS DE OPENAI
// ==========================================

const boardUnifilarSchema = {
    type: "object",
    additionalProperties: false,
    required: [
        "name",
        "type",
        "location",
        "description",
        "tensionNominal",
        "numeroFases",
        "incluyeNeutro",
        "sistema",
        "circuits",
        "mainBreakerAmperage",
        "mainBreakerSigla",
        "warnings",
    ],
    properties: {
        name: { type: ["string", "null"] },
        type: { type: ["string", "null"] },
        location: { type: ["string", "null"] },
        description: { type: ["string", "null"] },
        tensionNominal: { type: ["number", "null"] },
        numeroFases: { type: ["number", "null"] },
        incluyeNeutro: { type: ["boolean", "null"] },
        sistema: {
            type: ["string", "null"],
            enum: ["MONOFASICO", "TRIFASICO", null],
        },
        circuits: {
            type: "array",
            items: {
                type: "object",
                additionalProperties: false,
                required: ["circuito", "description"],
                properties: {
                    circuito: { type: ["string", "null"] },
                    description: { type: ["string", "null"] },
                },
            },
        },
        mainBreakerAmperage: { type: ["number", "null"] },
        mainBreakerSigla: { type: ["string", "null"] },
        warnings: {
            type: "array",
            items: { type: "string" },
        },
    },
};

const itmSchema = {
    type: "object",
    additionalProperties: false,
    required: [
        "manufacturer",
        "model",
        "amperage",
        "voltage",
        "breakingCapacityKA",
        "breakerType",
        "warnings",
    ],
    properties: {
        manufacturer: { type: ["string", "null"] },
        model: { type: ["string", "null"] },
        amperage: { type: ["number", "null"] },
        voltage: { type: ["number", "null"] },
        breakingCapacityKA: { type: ["number", "null"] },
        breakerType: { type: ["string", "null"] },
        warnings: { type: "array", items: { type: "string" } },
    },
};

const analyzeUnifilarWithOpenAI = async ({ buffer, mimetype, boardCode }) => {
    const imageDataUrl = bufferToDataUrl(buffer, mimetype);

    const response = await openai.responses.create({
        model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
        input: [
            {
                role: "system",
                content: `
Eres un ingeniero electricista especialista en interpretación de diagramas unifilares industriales.
Tu tarea es analizar diagramas unifilares eléctricos y devolver ÚNICAMENTE JSON válido siguiendo estrictamente el schema proporcionado.

REGLAS CRÍTICAS:
- NO inventes información.
- Si un dato no aparece claramente usa null.
- NO generes texto fuera del JSON.
- Extrae TODOS los circuitos visibles ordenados de arriba hacia abajo.
- Ignora mediciones de aislamiento, termografías y sellos.

REGLAS DE INTERPRETACIÓN:
1. name: Nombre visible principal del tablero (ej. "TG-SE", "TABLERO GENERAL").
2. type: "TABLERO GENERAL", "TABLERO DISTRIBUCION", "TABLERO ESTABILIZADO", "TABLERO FUERZA", "TABLERO ALUMBRADO", "TABLERO CONTROL" o "NO_IDENTIFICADO".
3. tensionNominal: Tensión principal en voltios (ej: 220, 380, 440).
4. mainBreakerAmperage / mainBreakerSigla: Datos del interruptor general de cabecera.
5. numeroFases / sistema / neutro: 1Ø -> 1, "MONOFASICO"; 3Ø -> 3, "TRIFASICO". incluyeNeutro: true si aparece N, +N, etc.
6. location: Ubicación física (ej: "SALA ELECTRICA") o null.
7. circuits: Extraer todos los circuitos visibles con su circuito y descripción.
8. warnings: Lista de observaciones técnicas o ilegibilidades.`,
            },
            {
                role: "user",
                content: [
                    {
                        type: "input_text",
                        text: `Analiza este diagrama unifilar. Código interno: ${boardCode}`,
                    },
                    {
                        type: "input_image",
                        image_url: imageDataUrl,
                        detail: "high",
                    },
                ],
            },
        ],
        text: {
            format: {
                type: "json_schema",
                name: "board_unifilar_extraction",
                strict: true,
                schema: boardUnifilarSchema,
            },
        },
        max_output_tokens: 4000,
        store: false,
    });

    return JSON.parse(response.output_text);
};

const analyzeITMWithOpenAI = async ({ images }) => {
    const content = [
        {
            type: "input_text",
            text: `
Analiza fotografías de un interruptor principal industrial.
Extrae fabricante, modelo, amperaje, voltaje, capacidad interruptiva kA y tipo de interruptor.
REGLAS: MCCB = Caja Moldeada, MCB = Miniatura, ACB = Aire.
No inventes datos. Si no se ve claramente, usa null. Devuelve únicamente JSON.`,
        },
    ];

    for (const img of images) {
        const imageDataUrl = bufferToDataUrl(img.buffer, img.mimetype);
        content.push({
            type: "input_image",
            image_url: imageDataUrl,
            detail: "high",
        });
    }

    const response = await openai.responses.create({
        model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
        input: [{ role: "user", content }],
        text: {
            format: {
                type: "json_schema",
                name: "itm_extraction",
                strict: true,
                schema: itmSchema,
            },
        },
        max_output_tokens: 1500,
        store: false,
    });

    return JSON.parse(response.output_text);
};

// ==========================================
// CÁLCULOS TÉCNICOS & NORMALIZACIÓN
// ==========================================

const normalizeCircuits = (circuits = [], sistema = null) => {
    const cleanCircuits = circuits
        .filter((c) => c?.circuito)
        .map((c) => {
            const circuito = c.circuito.trim().toUpperCase();
            return {
                circuito,
                descripcion: circuito === "IG" ? "Interruptor General" : c.descripcion || c.description || "",
                tipo: c.tipo || null,
            };
        });

    const hasIG = cleanCircuits.some((c) => c.circuito === "IG");
    if (!hasIG) {
        cleanCircuits.unshift({
            circuito: "IG",
            descripcion: "Interruptor General",
            tipo: sistema || null,
        });
    }

    return cleanCircuits;
};

const generateNfpaData = (itmData) => {
    const voltage = itmData.voltage || 380;
    const amperaje = itmData.amperage || 150;

    let tipoInterruptor = "Caja Moldeada";
    const siglaDetectada = (itmData.breakerType || "").toUpperCase();

    if (siglaDetectada.includes("MCCB") || siglaDetectada.includes("MOLDEADA") || siglaDetectada.includes("CAJA MOLDEADA")) {
        tipoInterruptor = "Caja Moldeada";
    } else if (siglaDetectada.includes("ACB") || siglaDetectada.includes("AIRE") || siglaDetectada.includes("BASTIDOR")) {
        tipoInterruptor = "Caja Abierta (Bastidor)";
    } else if (siglaDetectada.includes("MCB") || siglaDetectada.includes("MINIATURA") || siglaDetectada.includes("DIN")) {
        tipoInterruptor = "Riel DIN (Miniatura)";
    } else {
        if (amperaje <= 125) tipoInterruptor = "Riel DIN (Miniatura)";
        else if (amperaje > 1000) tipoInterruptor = "Caja Abierta (Bastidor)";
    }

    let shortCircuitCurrent = itmData.breakingCapacityKA || null;
    if (!shortCircuitCurrent) {
        if (amperaje <= 125) shortCircuitCurrent = 10;
        else if (amperaje > 125 && amperaje <= 400) shortCircuitCurrent = 22;
        else if (amperaje > 400 && amperaje <= 1000) shortCircuitCurrent = 35;
        else if (amperaje > 1000) shortCircuitCurrent = 50;
    }

    let arcData = {
        riskCategory: 1,
        incidentEnergy: "3.13 cal/cm²",
        arcDistance: "0.74 m",
        eppRequerido: [
            "Casco de Seguridad de Polímero Tipo E con Careta Facial AR (Mín. 4 cal/cm²)",
            "Lentes de Seguridad de Policarbonato con protección UV",
            "Camisa de manga larga y pantalón de trabajo AR (Mínimo 4 cal/cm² a 8 cal/cm²)",
            "Guantes de Cuero para Trabajo Mecánico o Dieléctricos según corresponda",
            "Zapatos Dieléctricos de Seguridad con puntera de composite",
        ],
    };

    if (amperaje > 125 && amperaje <= 400) {
        arcData = {
            riskCategory: 2,
            incidentEnergy: "7.8 cal/cm²",
            arcDistance: "0.91 m",
            eppRequerido: [
                "Casco integrado con Careta Facial AR Libre con Mentonera (Mín. 8 cal/cm²)",
                "Lentes de Seguridad de Policarbonato con protectores laterales",
                "Camisa de Trabajo AR y Pantalón de Trabajo Industrial AR (Resistentes a 8 cal/cm²)",
                "Guantes de Cuero para Trabajo Mecánico",
                "Zapatos Dieléctricos de Seguridad",
            ],
        };
    } else if (amperaje > 400) {
        arcData = {
            riskCategory: 4,
            incidentEnergy: "32.0 cal/cm²",
            arcDistance: "1.52 m",
            eppRequerido: [
                "Capucha de Traje de Arco (Escafandra) certificada de 25 a 40 cal/cm²",
                "Lentes de Seguridad de Policarbonato (obligatorios bajo la escafandra)",
                "Traje de Arco de Alta Densidad (Chaqueta y Pantalón Peto ignífugo multicapa)",
                "Guantes Dieléctricos de Goma con Protectores de Cuero (Sobreguantes)",
                "Botas Dieléctricas de Caña Alta (Hule/Goma)",
            ],
        };
    }

    let limiteAproximacion = "1.07 m";
    let distanciaRestringida = "0.31 m";
    let shockGloveClass = "Clase 00 (Hasta 500 VCA) con guantes de piel";

    if (voltage > 250 && voltage <= 600) {
        limiteAproximacion = "1.07 m";
        distanciaRestringida = "0.31 m";
        shockGloveClass = "Clase 0 (Hasta 1,000 VCA) con guantes de piel";
    } else if (voltage > 600) {
        limiteAproximacion = "1.52 m";
        distanciaRestringida = "0.61 m";
        shockGloveClass = "Clase 1 (Hasta 7,500 VCA) con guantes de piel";
    }

    return {
        amperajePrincipal: amperaje,
        tipoInterruptor,
        corrienteCortocircuito: shortCircuitCurrent,
        distanciaTrabajo: "45.72 cm (18 in)",
        distanciaArco: arcData.arcDistance,
        energiaIncidente: arcData.incidentEnergy,
        categoriaRiesgo: arcData.riskCategory,
        limiteAproximacion,
        distanciaRestringida,
        guantesClase: shockGloveClass,
        eppRequerido: arcData.eppRequerido,
        calculadoPorIA: true,
        origenDatos: "FOTO_ITM_REAL",
        updatedAt: new Date(),
    };
};

// ==========================================
// CONTROLADOR PRINCIPAL UNIFICADO
// ==========================================

export const importBoardsWithNfpaFromZip = async (req, res) => {
    try {
        const { companyCode } = req.body;

        if (!companyCode) {
            return res.status(400).json({
                ok: false,
                error: "Debes enviar companyCode.",
            });
        }

        const company = await Company.findOne({ publicCode: companyCode });
        if (!company) {
            return res.status(404).json({
                ok: false,
                error: `No existe una empresa con publicCode: ${companyCode}`,
            });
        }

        if (!req.file) {
            return res.status(400).json({
                ok: false,
                error: "Debes subir un archivo ZIP en el campo file.",
            });
        }

        const zip = new AdmZip(req.file.buffer);
        const entries = zip.getEntries();

        // 🔍 Revisa en tu terminal exactamente qué lista imprime esto:
        console.log("Archivos dentro del ZIP:", entries.map(e => e.entryName));

        // FILTRADO ROBUSTO DE IMÁGENES
        const imageEntries = entries.filter((entry) => {
            if (entry.isDirectory) return false;

            const normalizedPath = entry.entryName.replace(/\\/g, "/");
            const fileName = path.basename(normalizedPath).trim();

            // Descartar carpetas internas, metadata y archivos ocultos de MacOS / Windows
            if (normalizedPath.endsWith("/")) return false;
            if (fileName.startsWith(".") || normalizedPath.includes("__MACOSX")) return false;

            // Extraer la extensión con path.extname y validarla
            const ext = path.extname(fileName).toLowerCase();
            return [".jpg", ".jpeg", ".png", ".webp"].includes(ext);
        });

        if (imageEntries.length === 0) {
            return res.status(400).json({
                ok: false,
                error: "El ZIP no contiene imágenes válidas.",
            });
        }

        // Control de peso individual (Máx 10MB por foto)
        const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
        const archivosPesados = [];

        for (const entry of imageEntries) {
            if (entry.header.uncompressedSize > MAX_IMAGE_SIZE) {
                const pesoMB = (entry.header.uncompressedSize / (1024 * 1024)).toFixed(2);
                archivosPesados.push(`${path.basename(entry.entryName)} (${pesoMB} MB)`);
            }
        }

        if (archivosPesados.length > 0) {
            return res.status(400).json({
                ok: false,
                error: `Importación cancelada. Se detectaron imágenes que superan el límite de 10MB: ${archivosPesados.join(", ")}.`,
            });
        }

        // Agrupamiento por código de tablero
        const groupedImages = {};

        for (const entry of imageEntries) {
            // Obtener el nombre limpio del archivo sin la subcarpeta
            const normalizedPath = entry.entryName.replace(/\\/g, "/");
            const originalName = normalizedPath.split("/").pop(); // Ej: "REC-MOL-TE-003_itm.jpg"

            const boardCode = getBoardCodeFromFileName(originalName);
            const kind = getImageKindFromFileName(originalName);

            if (!groupedImages[boardCode]) {
                groupedImages[boardCode] = {
                    boardCode,
                    unifilar: null,
                    itm: [],
                    tablero: [],
                    termografia: [],
                };
            }

            const fileBuffer = entry.getData();

            // Validar que el archivo realmente tenga datos
            if (!fileBuffer || fileBuffer.length === 0) {
                console.warn(`⚠️ Archivo vacío detectado y omitido: ${originalName}`);
                continue;
            }

            const mime = getMimeTypeFromFileName(originalName);

            const imageData = {
                entry,
                originalName,
                buffer: fileBuffer,
                mimetype: mime,
                kind,
            };

            if (kind === "unifilar") {
                groupedImages[boardCode].unifilar = imageData;
            } else if (kind === "itm") {
                groupedImages[boardCode].itm.push(imageData);
            } else if (kind === "termografia") {
                groupedImages[boardCode].termografia.push(imageData);
            } else {
                groupedImages[boardCode].tablero.push(imageData);
            }
        }

        const results = [];

        // Procesamiento lote a lote
        for (const group of Object.values(groupedImages)) {
            const { boardCode } = group;

            try {
                // Requisito base: debe existir al menos el plano unifilar
                if (!group.unifilar) {
                    results.push({
                        boardCode,
                        status: "failed",
                        error: "No se encontró imagen unifilar para este tablero.",
                    });
                    continue;
                }

                const exists = await Board.findOne({
                    boardCode,
                    companyPublicCode: companyCode,
                });

                if (exists) {
                    results.push({
                        boardCode,
                        status: "skipped",
                        error: "Ya existe un tablero con ese código.",
                    });
                    continue;
                }

                const allWarnings = [];

                // 1. Análisis del diagrama unifilar con OpenAI (Con captura detallada de error)
                let aiUnifilarResult;
                try {
                    aiUnifilarResult = await analyzeUnifilarWithOpenAI({
                        buffer: group.unifilar.buffer,
                        mimetype: group.unifilar.mimetype,
                        boardCode,
                    });
                } catch (aiErr) {
                    const fileName = group.unifilar.originalName;
                    if (aiErr.message?.includes("does not represent a valid image") || aiErr.status === 400) {
                        throw new Error(
                            `La imagen unifilar "${fileName}" no es válida para OpenAI (puede estar dañada, corrupta o con extensión incorrecta).`,
                            { cause: aiErr }
                        );
                    }
                    throw new Error(`Fallo en OpenAI al analizar unifilar "${fileName}": ${aiErr.message}`, { cause: aiErr });
                }

                if (aiUnifilarResult.warnings?.length) {
                    allWarnings.push(...aiUnifilarResult.warnings);
                }

                // 2. Análisis del ITM (si existen fotos) y cálculo NFPA 70E
                let nfpaCalculatedData = null;

                if (group.itm.length > 0) {
                    try {
                        const aiItmResult = await analyzeITMWithOpenAI({ images: group.itm });
                        nfpaCalculatedData = generateNfpaData(aiItmResult);

                        if (aiItmResult.warnings?.length) {
                            allWarnings.push(...aiItmResult.warnings);
                        }
                    } catch (itmError) {
                        const itmNames = group.itm.map((i) => i.originalName).join(", ");
                        console.error(`⚠️ No se pudo procesar la foto ITM para [${boardCode}]:`, itmError.message);
                        allWarnings.push(`No se pudo procesar foto de interruptor ITM (${itmNames}): ${itmError.message}`);
                    }
                }

                // 3. Subida paralela de todas las fotos a Cloudinary
                const images = {
                    tablero: [],
                    unifilar: [],
                    termografia: [],
                    itm: [],
                };

                const allImages = [
                    group.unifilar,
                    ...group.tablero,
                    ...group.termografia,
                    ...group.itm,
                ].filter(Boolean);

                for (const img of allImages) {
                    const url = await uploadBoardImageToCloudinary({
                        buffer: img.buffer,
                        boardCode,
                        originalName: img.originalName,
                        kind: img.kind,
                    });

                    if (images[img.kind]) {
                        images[img.kind].push(url);
                    } else {
                        images.tablero.push(url);
                    }
                }

                // 4. Creación final en MongoDB con todos los datos integrados
                const board = await Board.create({
                    code: uuidv4(),
                    boardCode,
                    name: aiUnifilarResult.name || boardCode,
                    type: aiUnifilarResult.type || "No identificado",
                    location: aiUnifilarResult.location || "",
                    description: aiUnifilarResult.description || "",
                    companyPublicCode: companyCode,
                    tensionNominal: aiUnifilarResult.tensionNominal,
                    numeroFases: aiUnifilarResult.numeroFases,
                    incluyeNeutro: aiUnifilarResult.incluyeNeutro ?? false,
                    sistema: aiUnifilarResult.sistema,
                    circuits: normalizeCircuits(
                        aiUnifilarResult.circuits,
                        aiUnifilarResult.sistema
                    ),
                    images,
                    estadoGeneral: "OPERATIVO",
                    createdBy: req.user?._id || "ID_REAL_DE_USUARIO_PARA_PRUEBAS",
                    nfpa: nfpaCalculatedData,
                });

                console.log(` Tablero ${boardCode} registrado con éxito con datos NFPA.`);

                results.push({
                    boardCode,
                    status: "created",
                    boardId: board._id,
                    hasNfpa: Boolean(nfpaCalculatedData),
                    warnings: allWarnings,
                });
            } catch (error) {
                console.error(` Error procesando el tablero [${boardCode}]:`, error);

                results.push({
                    boardCode,
                    status: "failed",
                    error: error.message,
                });
            }
        }

        return res.status(201).json({
            ok: true,
            total: Object.keys(groupedImages).length,
            created: results.filter((r) => r.status === "created").length,
            skipped: results.filter((r) => r.status === "skipped").length,
            failed: results.filter((r) => r.status === "failed").length,
            results,
        });
    } catch (error) {
        console.error("Error importando ZIP consolidado:", error);
        return res.status(500).json({
            ok: false,
            error: error.message || "Error importando lote consolidado de tableros.",
        });
    }
};