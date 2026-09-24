import path from "path";
import { v4 as uuidv4 } from "uuid";

import openai from "../config/openai.js";
import cloudinary from "../config/cloudinary.js";
import Board from "../models/Board.js";
import Company from "../models/Company.js";
import AdmZip from "adm-zip";

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

    return mimeTypes[ext] || null;
};

const getImageKindFromFileName = (filename) => {
    const name = filename.toLowerCase();

    if (name.includes("unifilar")) {
        return "unifilar";
    }

    if (
        name.includes("_itm") ||
        name.includes("interruptor") ||
        name.includes("breaker")
    ) {
        return "itm";
    }

    if (name.includes("termografia") || name.includes("termica")) {
        return "termografia";
    }

    if (name.includes("normal") || name.includes("tablero")) {
        return "normal";
    }

    return "tablero";
};

const getBoardCodeFromGroupedImage = (filename) => {
    return path.parse(filename).name.split("_")[0].trim().toUpperCase();
};

const uploadBoardImageToCloudinary = async ({
    buffer,
    boardCode,
    originalName,
    kind,
}) => {
    return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
            {
                folder: `boards/${boardCode}/${kind}`,
                resource_type: "image",
                public_id: path.parse(originalName).name,
            },
            (error, result) => {
                if (error) return reject(error);
                resolve(result.secure_url);
            },
        );

        stream.end(buffer);
    });
};

// -------------

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
            enum: ["MONOFÁSICO", "TRIFÁSICO", null],
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

Tu objetivo es llenar automáticamente un registro de tablero eléctrico.

REGLAS CRÍTICAS:
- NO inventes información.
- Si un dato no aparece claramente usa null.
- NO generes texto fuera del JSON.
- NO expliques nada.
- NO uses markdown.
- NO agregues propiedades adicionales.
- Extrae TODOS los circuitos visibles.
- Los circuitos SIEMPRE deben venir ordenados visualmente de arriba hacia abajo.
- Ignora completamente pruebas de aislamiento.
- Ignora mediciones MΩ.
- Ignora termografías.
- Ignora sellos, firmas y notas administrativas.

REGLAS DE INTERPRETACIÓN:
1. boardCode
- El código del tablero viene PRIORITARIAMENTE del nombre del archivo.
- Si el diagrama muestra otro código visible más preciso, úsalo como "name" pero NO reemplaces boardCode.

2. name
- Corresponde al nombre visible principal del tablero.
- Ejemplo: "TABLERO TG-SE", "TG-SE", "TABLERO GENERAL"

3. type
Determina el tipo del tablero usando: nombre, descripción, cargas conectadas, etiquetas visibles.
Ejemplos válidos: "TABLERO GENERAL", "TABLERO DISTRIBUCION", "TABLERO ESTABILIZADO", "TABLERO FUERZA", "TABLERO ALUMBRADO", "TABLERO CONTROL".
Si no es claro: "NO_IDENTIFICADO"

4. tensionNominal
Extrae la tensión nominal principal visible del tablero.
Ejemplos: 220V => 220, 380V => 380. Si existen varias tensiones, prioriza la tensión principal del tablero. Si no puede determinarse: null

4.1 mainBreakerAmperage / mainBreakerSigla
Busca el interruptor general (IG) o el interruptor principal que está en la cabecera del diagrama.
- Extrae en "mainBreakerAmperage" solo el número del amperaje nominal.
- Extrae en "mainBreakerSigla" el tipo de tecnología si viene escrita (ej. "MCCB", "ACB", "MCB"). Si no hay datos, usa null.

5. numeroFases / sistema / neutro
Debes determinar correctamente si el tablero es MONOFÁSICO o TRIFÁSICO.
TABLERO MONOFÁSICO: "1Ø", "1F", "1 fase", "F+N", "L+N", breaker 1P. numeroFases: 1, sistema: "MONOFÁSICO".
TABLERO TRIFÁSICO: "3Ø", "3F", "3 fases", "R S T", breaker 3P, tensión 380V, 440V, 480V. numeroFases: 3, sistema: "TRIFÁSICO".
REGLA IMPORTANTE SOBRE 220V: 220V NO significa automáticamente TRIFÁSICO. Si solo aparece una fase + neutro => MONOFÁSICO.
incluyeNeutro: TRUE si aparece N, +N, (N), F+N, L+N, neutro. Caso contrario FALSE.

6. location
Extrae ubicación física o sector (ej: "SALA ELECTRICA"). Si no existe: null.

7. description
Genera una descripción técnica breve usando SOLO información visible.

8. circuits
Extrae TODOS los circuitos visibles del tablero (IG, C1, C2, etc.).
Cada circuito debe contener: circuito, descripcion, tipo.
REGLA CRÍTICA DE INTERCONEXIÓN: Presta extrema atención si el circuito indica una procedencia o destino ("ALIMENTACIÓN DESDE: T-01", "A TABLERO:"). Transcribe esa relación de forma EXACTA.
INTERRUPTOR GENERAL (IG): Si existe un breaker principal antes de las derivaciones, debe registrarse como circuito "IG", descripcion: "Interruptor General", tipo: según el sistema del tablero. La descripción de IG NUNCA debe contener nombres de otros tableros derivados ni sub-cargas.
ORDEN: Los circuitos deben devolverse EXACTAMENTE en el orden visual. "RESERVA" también cuenta como circuito válido. NO OMITIR CIRCUITOS aunque estén incompletos.

9. warnings
Agrega advertencias SOLO si hay texto ilegible o datos contradictorios. Si todo es claro: []`,
            },
            {
                role: "user",
                content: [
                    {
                        type: "input_text",
                        text: `
Analiza este diagrama unifilar industrial.
El código interno del tablero obtenido desde el archivo es: ${boardCode}
Debes extraer toda la información eléctrica visible del tablero principal y sus circuitos derivados.
Devuelve únicamente JSON válido.`,
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

const normalizeCircuits = (circuits = [], sistema = null) => {
    const cleanCircuits = circuits
        .filter((c) => c?.circuito)
        .map((c) => {
            const circuito = c.circuito.trim().toUpperCase();

            return {
                circuito,
                descripcion:
                    circuito === "IG"
                        ? "Interruptor General"
                        : c.descripcion || c.description || "",
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

export const importBoardsFromUnifilarZip = async (req, res) => {
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

        const imageEntries = entries.filter((entry) => {
            if (entry.isDirectory) return false;
            const ext = path.extname(entry.entryName).toLowerCase();
            return [".jpg", ".jpeg", ".png", ".webp"].includes(ext);
        });

        if (imageEntries.length === 0) {
            return res.status(400).json({
                ok: false,
                error: "El ZIP no contiene imágenes válidas.",
            });
        }

        // CONTROL DE PESO MÁXIMO POR IMAGEN (MÁX. 10MB POR ARCHIVO)
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
                error: `Importación cancelada. Se detectaron imágenes individuales que superan el límite de 10MB: ${archivosPesados.join(", ")}.`,
            });
        }

        const groupedImages = {};

        for (const entry of imageEntries) {
            const originalName = path.basename(entry.entryName);
            const boardCode = getBoardCodeFromGroupedImage(originalName);
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

            const imageData = {
                entry,
                originalName,
                buffer: entry.getData(),
                mimetype: getMimeTypeFromFileName(originalName),
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

        for (const group of Object.values(groupedImages)) {
            const { boardCode } = group;

            try {
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

                // Analizar exclusivamente el Diagrama Unifilar mediante OpenAI
                const aiResult = await analyzeUnifilarWithOpenAI({
                    buffer: group.unifilar.buffer,
                    mimetype: group.unifilar.mimetype,
                    boardCode,
                });

                // Subida de imágenes de contexto encontradas en el ZIP a Cloudinary
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

                // Crear el registro base en MongoDB sin el payload de NFPA calculada
                const board = await Board.create({
                    code: uuidv4(),
                    boardCode,
                    name: aiResult.name || boardCode,
                    type: aiResult.type || "No identificado",
                    location: aiResult.location || "",
                    description: aiResult.description || "",
                    companyPublicCode: companyCode,
                    tensionNominal: aiResult.tensionNominal,
                    numeroFases: aiResult.numeroFases,
                    incluyeNeutro: aiResult.incluyeNeutro ?? false,
                    sistema: aiResult.sistema,
                    circuits: normalizeCircuits(
                        aiResult.circuits,
                        aiResult.sistema,
                    ),
                    images,
                    estadoGeneral: "OPERATIVO",
                    createdBy: req.user?._id || "ID_REAL_DE_USUARIO_PARA_PRUEBAS",
                    nfpa: null, // <-- Inicializado en null. El nuevo endpoint se encargará de rellenar esto.
                });

                console.log(`✅ Tablero ${boardCode} registrado con éxito en la BD.`);

                results.push({
                    boardCode,
                    status: "created",
                    boardId: board._id,
                    warnings: aiResult.warnings || [],
                });
            } catch (error) {
                console.error(`❌ Error procesando el tablero [${boardCode}]:`, error);

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
        console.error("Error importando ZIP de unifilares:", error);

        return res.status(500).json({
            ok: false,
            error: error.message || "Error importando ZIP de unifilares.",
        });
    }
};