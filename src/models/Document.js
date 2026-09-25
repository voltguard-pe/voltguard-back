import mongoose from "mongoose";

const documentSchema = new mongoose.Schema(
    {
        title: {
            type: String,
            required: true,
            trim: true,
        },
        // type: {
        //     type: String,
        //     enum: ["MANTENIMIENTO", "OPERATIVIDAD", "POZO_A_TIERRA"],
        //     required: true,
        // },
        cloudinaryUrl: {
            type: String,
            required: true,
        },
        cloudinaryPublicId: {
            type: String,
            required: true, // Útil si necesitas eliminarlo de Cloudinary después
        },
        companyPublicCode: {
            type: String,
            required: true,
            index: true,
            trim: true,
        },
        uploadedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
        },
    },
    { timestamps: true }
);

export default mongoose.model("Document", documentSchema);