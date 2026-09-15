import Document from "../models/Document.js";
import { v2 as cloudinary } from "cloudinary";

// Helper para subir archivos a Cloudinary como RAW (Documentos estandar)
const uploadFromBuffer = (fileBuffer, companyPublicCode, originalName) => {
    return new Promise((resolve, reject) => {
        const cleanName = originalName.toLowerCase().endsWith('.pdf') 
            ? originalName.replace(/\.pdf$/i, '') 
            : originalName;

        const safePublicId = cleanName.replace(/[^a-zA-Z0-9_-]/g, "_");

        const stream = cloudinary.uploader.upload_stream(
            {
                folder: `boards/documentos/${companyPublicCode}`,
                resource_type: "image", // "image" permite previsualización nativa de PDFs en Cloudinary
                format: "pdf",          // Garantiza Content-Type: application/pdf
                public_id: safePublicId,
            },
            (error, result) => {
                if (result) resolve(result);
                else reject(error);
            }
        );
        stream.end(fileBuffer);
    });
};

// 1. SUBIR MÚLTIPLES DOCUMENTOS (POST)
export const uploadDocuments = async (req, res) => {
    try {
        const { companyPublicCode, uploadedBy, types, titles } = req.body;

        // Validar que vengan archivos en la petición
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ message: "No se han seleccionado archivos PDF" });
        }

        // Normalizar titles y types a Arrays por si vienen como String individual desde Multer/FormData
        const titlesArray = Array.isArray(titles) ? titles : [titles];
        const typesArray = Array.isArray(types) ? types : [types];

        // Mapeamos los archivos para subirlos en paralelo
        const uploadPromises = req.files.map(async (file, index) => {
            // Subir a Cloudinary desde el buffer de memoria
            const cloudinaryResult = await uploadFromBuffer(file.buffer, companyPublicCode, file.originalname);

            // Asignación segura con fallback
            const documentTitle = titlesArray[index] || file.originalname;
            const documentType = typesArray[index] || "MANTENIMIENTO";

            // Crear el registro de Mongo
            const newDocument = new Document({
                title: documentTitle,
                type: documentType,
                companyPublicCode,
                cloudinaryUrl: cloudinaryResult.secure_url,
                cloudinaryPublicId: cloudinaryResult.public_id,
                uploadedBy
            });

            return await newDocument.save();
        });

        // Ejecutar subidas concurrentemente
        const savedDocuments = await Promise.all(uploadPromises);

        return res.status(201).json({
            message: `${savedDocuments.length} documentos subidos con éxito`,
            documents: savedDocuments
        });

    } catch (error) {
        console.error("Error en uploadDocuments:", error);
        return res.status(500).json({ message: "Error en la subida múltiple", error: error.message });
    }
};

// 2. OBTENER DOCUMENTOS POR EMPRESA (GET)
export const getDocumentsByCompany = async (req, res) => {
    try {
        const { companyPublicCode } = req.params;
        const documents = await Document.find({ companyPublicCode }).sort({ createdAt: -1 });
        return res.status(200).json(documents);
    } catch (error) {
        return res.status(500).json({ message: "Error al obtener documentos", error: error.message });
    }
};

// 3. ACTUALIZAR DATOS DEL DOCUMENTO (PUT)
export const updateDocumentData = async (req, res) => {
    try {
        const { id } = req.params;
        const { title, type } = req.body;

        const updatedDocument = await Document.findByIdAndUpdate(
            id,
            { $set: { title, type } },
            { new: true }
        );

        if (!updatedDocument) {
            return res.status(404).json({ message: "Documento no encontrado" });
        }

        return res.status(200).json(updatedDocument);
    } catch (error) {
        return res.status(500).json({ message: "Error al actualizar documento", error: error.message });
    }
};

// 4. ELIMINAR DOCUMENTO (DELETE)
export const deleteDocument = async (req, res) => {
    try {
        const { id } = req.params;

        const document = await Document.findById(id);
        if (!document) {
            return res.status(404).json({ message: "Documento no encontrado" });
        }

        await cloudinary.uploader.destroy(document.cloudinaryPublicId, { resource_type: "image" });
        await Document.findByIdAndDelete(id);

        return res.status(200).json({ message: "Documento eliminado correctamente" });
    } catch (error) {
        return res.status(500).json({ message: "Error al eliminar el documento", error: error.message });
    }
};