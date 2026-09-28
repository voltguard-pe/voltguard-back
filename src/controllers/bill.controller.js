import openai from "../config/openai.js";
import Board from "../models/Board.js";

export const extractElectricityRates = async (req, res) => {
  try {
    const { boardId } = req.params;
    const file = req.file;

    if (!file || !file.buffer) {
      return res.status(400).json({ 
        error: "Debes adjuntar una imagen del recibo de luz." 
      });
    }

    const mime = file.mimetype || "image/jpeg";

    // Validar que sea una imagen compatible con el modelo de visión
    if (!mime.startsWith("image/")) {
      return res.status(400).json({
        error: "Formato no compatible. Por favor sube una imagen (JPG, PNG o WEBP) de tu recibo de luz."
      });
    }

    const base64Data = `data:${mime};base64,${file.buffer.toString("base64")}`;

    const prompt = `Analiza este recibo de servicio eléctrico (Luz del Sur / Enel / etc.).
Dirígete a la sección "DETALLE DE LOS IMPORTES FACTURADOS".
Ubica la columna "Precio Unitario" para los siguientes conceptos:
1. "Consumo de Energía Hora Punta" (corresponde a tarifaHP)
2. "Consumo de Energía Fuera Punta" (corresponde a tarifaFP)

Devuelve ÚNICAMENTE un objeto JSON estrictamente válido con este formato exacto:
{
  "tarifaHP": 0.3095,
  "tarifaFP": 0.2616
}

Si la imagen no es un recibo de luz o no se aprecian con claridad las tarifas unitarias, devuelve valores nulos:
{
  "tarifaHP": null,
  "tarifaFP": null
}`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { 
              type: "image_url", 
              image_url: { 
                url: base64Data, 
                detail: "high" 
              } 
            },
          ],
        },
      ],
      response_format: { type: "json_object" },
      temperature: 0.1,
    });

    const parsed = JSON.parse(response.choices[0]?.message?.content || "{}");

    const tarifaHP = parsed.tarifaHP != null ? Number(parsed.tarifaHP) : null;
    const tarifaFP = parsed.tarifaFP != null ? Number(parsed.tarifaFP) : null;

    // Validación estricta: Si la IA no encontró números válidos, no guardar datos inventados
    if (!tarifaHP || !tarifaFP || isNaN(tarifaHP) || isNaN(tarifaFP)) {
      return res.status(422).json({
        error: "No se pudieron extraer las tarifas de Hora Punta y Fuera de Punta del documento adjunto. Asegúrate de que la sección de importes facturados sea legible."
      });
    }

    // Guardar directamente en el tablero en MongoDB si se proporciona boardId
    if (boardId) {
      await Board.findByIdAndUpdate(boardId, {
        $set: {
          "energyRates.tarifaHP": tarifaHP,
          "energyRates.tarifaFP": tarifaFP,
          "energyRates.updatedAt": new Date(),
        },
      });
    }

    return res.status(200).json({
      success: true,
      message: "Tarifas extraídas y actualizadas correctamente con Inteligencia Artificial.",
      data: {
        tarifaHP,
        tarifaFP,
      },
    });
  } catch (error) {
    console.error("Error al procesar tarifas del recibo en OpenAI:", error);
    return res.status(500).json({ 
      error: "Error interno al analizar el recibo de luz: " + error.message 
    });
  }
};