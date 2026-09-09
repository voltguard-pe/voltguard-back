import 'dotenv/config';
import dotenv from "dotenv";
import express from "express";
import authRoute from "./routes/auth.route.js";
import companyRoute from "./routes/company.route.js";
import boardRoute from "./routes/board.route.js";
import adminRoute from "./routes/admin.route.js";
import userRoute from "./routes/user.route.js";
import publicRoute from "./routes/public.route.js";
import importRoute from "./routes/import.route.js";
import connectDB from "./config/db.js";
import cors from "cors";
import cookieParser from "cookie-parser";
import insulationRoute from "./routes/insulation.route.js";
import nfpa70eRoute from "./routes/nfpa70e.route.js";
import boardUnifilarRoute from "./routes/boardUnifilarAi.route.js";
import SubscriptionRoute from "./routes/subscription.route.js";
import documentRoute from "./routes/document.route.js";
import measurementRoute from "./routes/measurement.route.js";
import importUnifilarNFPARoute from "./routes/importUnifilarNFPA.route.js";
import thermographyRoute from "./routes/thermography.route.js";
import voltageEventRoute from "./routes/voltageEvent.route.js";

dotenv.config();

const app = express();

connectDB();

app.use(express.json());
app.use(cookieParser());

// const allowlist = [process.env.FRONTEND_URL];

// const corsOptions = {
//     origin: function (origin, callback) {
//         if (allowlist.indexOf(origin) !== -1 || !origin) {
//             callback(null, true);
//         } else {
//             callback(new Error("Not allowed by CORS"));
//         }
//     },
//     credentials: true
// };

// app.use(cors(corsOptions));

const allowlist = process.env.FRONTEND_URL ? process.env.FRONTEND_URL.split(',').map(url => url.trim().replace(/\/$/, "")) : [];

const corsOptions = {
    origin: function (origin, callback) {
        if (!origin || allowlist.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error("Not allowed by CORS"));
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions))

app.use("/api/v1/auth", authRoute);
app.use("/api/v1/company", companyRoute);
app.use("/api/v1/board", boardRoute);
app.use("/api/v1/admin", adminRoute);
app.use("/api/v1/user", userRoute);
app.use("/api/v1/public", publicRoute);
app.use("/api/v1/import", importRoute);
app.use("/api/v1/insulation", insulationRoute);
app.use("/api/v1/nfpa70e", nfpa70eRoute);
app.use("/api/v1/boards-unifilar", boardUnifilarRoute);
app.use("/api/v1/subscription", SubscriptionRoute);
app.use("/api/v1/document", documentRoute);
app.use("/api/v1/mediciones", measurementRoute);
app.use("/api/v1/import-unifilar-nfpa", importUnifilarNFPARoute);
app.use("/api/v1/thermography", thermographyRoute);
app.use("/api/v1/voltage-events", voltageEventRoute);

const PORT = process.env.PORT || 5080;

app.listen(PORT, () => {
    console.log("Se esta ejecutando en el puerto:", PORT);
});
