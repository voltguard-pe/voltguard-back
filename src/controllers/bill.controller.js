import openai from "../config/openai.js";
import Board from "../models/Board.js"; // Importar modelo

export const extractElectricityRates = async (req, res) => {
  try {
    const { boardId } = req.params; // <-- Recibe el boardId
    const file = req.file;

    if (!file || !file.buffer) {
      return res.status(400).json({ 
        error: "Debe adjuntar una imagen o documento del recibo de luz." 
      });
    }

    const mime = file.mimetype || "image/jpeg";
    const base64Data = `data:${mime};base64,${file.buffer.toString("base64")}`;

    const prompt = `Analiza este recibo de servicio eléctrico (Luz del Sur / Enel / etc.).
Dirígete a la sección "DETALLE DE LOS IMPORTES FACTURADOS".
Ubica la columna "Precio Unitario" para los siguientes conceptos:
1. "Consumo de Energía Hora Punta" (corresponde a tarifaHP)
2. "Consumo de Energía Fuera Punta" (corresponde a tarifaFP)

Devuelve ÚNICAMENTE un objeto JSON estrictamente válido con este formato:
{
  "tarifaHP": 0.3095,
  "tarifaFP": 0.2616
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

    const tarifaHP = Number(parsed.tarifaHP) || 0.3095;
    const tarifaFP = Number(parsed.tarifaFP) || 0.2616;

    // Guardar directamente en el tablero si se envía boardId
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
      message: "Tarifas extraídas y guardadas correctamente.",
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