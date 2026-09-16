import User from "../models/User.js";
import { generateToken } from "../utils/generateToken.js";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import {
    sendResetPasswordEmail,
    sendVerificationEmail,
} from "../services/email.service.js";
import axios from "axios";

const getCookieOptions = () => {
    const isProduction = process.env.NODE_ENV === "production";
    
    return {
        httpOnly: true,
        secure: isProduction, // En localhost puede ser false, en producción obligatoriamente true
        // sameSite: isProduction ? "none" : "lax", // "none" exige HTTPS en producción
        sameSite:"none", // "none" exige HTTPS en producción
        domain: isProduction ? ".voltguard.pe" : undefined, // Toma la variable o deja undefined si no existe
        path: "/",
    };
};

export const register = async (req, res) => {
    try {
        const {
            firstname,
            lastname,
            email,
            password,
            company,
            ruc,
            phone,
            referralSource,
            captchaToken,
        } = req.body;

        // 1. Validar campos obligatorios
        if (!firstname || !lastname || !email || !password || !company || !ruc || !phone || !referralSource) {
            return res.status(400).json({ message: "Todos los campos obligatorios deben ser completados." });
        }

        // 2. Validar reCAPTCHA con Google de forma segura
        if (captchaToken) {
            try {
                const googleVerifyUrl = `https://www.google.com/recaptcha/api/siteverify?secret=${process.env.RECAPTCHA_SECRET_KEY}&response=${captchaToken}`;
                const recaptchaRes = await axios.post(googleVerifyUrl);
                const { success, score } = recaptchaRes.data;

                if (!success || (score !== undefined && score < 0.5)) {
                    return res.status(400).json({ message: "Verificación de seguridad reCAPTCHA fallida." });
                }
            } catch (captchaError) {
                console.error("⚠️ Error consultando API de reCAPTCHA:", captchaError.message);
            }
        }

        // 3. Validar si el usuario ya existe
        const exists = await User.findOne({ email });
        if (exists) {
            return res.status(400).json({ message: "El correo electrónico ya se encuentra registrado." });
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        // 4. Generar token de activación
        const token = crypto.randomBytes(32).toString("hex");
        const tokenExpires = new Date(Date.now() + 3600000); // 1 hora

        // 5. Crear el usuario en la base de datos (companyPublicCode tomará su valor default: null)
        const user = await User.create({
            firstname,
            lastname,
            email,
            password: hashedPassword,
            company,
            ruc,
            phone,
            referralSource,
            role: "USER",
            verified: false,
            verificationToken: token,
            verificationTokenExpires: tokenExpires,
        });

        // 6. Enviar correo de verificación
        try {
            await sendVerificationEmail(user.email, token);
        } catch (emailError) {
            console.error("❌ Error enviando email de verificación:", emailError.message);
        }

        return res.status(201).json({
            message: "Usuario registrado con éxito. Por favor, verifica tu correo electrónico.",
            user: {
                id: user._id,
                firstname: user.firstname,
                lastname: user.lastname,
                email: user.email,
                company: user.company,
                ruc: user.ruc,
                role: user.role,
                verified: user.verified,
            },
        });
    } catch (error) {
        console.error("❌ ERROR DETALLADO EN REGISTRO:", error);
        return res.status(500).json({
            message: error.message || "Error interno del servidor al registrar usuario.",
        });
    }
};

// 2. NUEVO CONTROLADOR PARA PROCESAR LA VERIFICACIÓN
export const verifyEmail = async (req, res) => {
    try {
        const { token } = req.params;

        // Buscar al usuario que posea el token y que este no haya expirado
        const user = await User.findOne({
            verificationToken: token,
            verificationTokenExpires: { $gt: new Date() }, // El vencimiento debe ser mayor a la hora actual
        });

        if (!user) {
            return res.status(400).json({
                message: "El enlace de verificación es inválido o ha expirado.",
            });
        }

        // Limpiar los campos del token y cambiar el estado verificado a TRUE
        user.verified = true;
        user.verificationToken = null;
        user.verificationTokenExpires = null;
        await user.save();

        res.status(200).json({
            message: "Cuenta verificada con éxito. Ya puedes iniciar sesión.",
        });
    } catch (error) {
        console.error("Error al verificar cuenta:", error);
        res.status(500).json({
            message: "Error al procesar la verificación de la cuenta.",
        });
    }
};

// 3. LOGIN REFACTORIZADO (Bloqueo si verified es false)
export const login = async (req, res) => {
    try {
        const { email, password } = req.body;

        const user = await User.findOne({ email });
        if (!user) {
            return res.status(400).json({ message: "Credenciales inválidas" });
        }

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(400).json({ message: "Credenciales inválidas" });
        }

        // RESTRICCIÓN DE VERIFICACIÓN CRÍTICA
        if (!user.verified) {
            return res.status(403).json({
                message:
                    "No puedes ingresar. Por favor, verifica primero tu cuenta en tu correo electrónico.",
            });
        }

        const token = generateToken(user);

       res.cookie("token", token, getCookieOptions());

        res.status(200).json({
            message: "Login exitoso",
            user: {
                id: user._id,
                firstname: user.firstname,
                lastname: user.lastname,
                role: user.role,
                companyPublicCode: user.companyPublicCode,
            },
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// SOLO para inicial (puedes luego protegerlo)
export const registerSuperAdmin = async (req, res) => {
    try {
        const { firstname, lastname, email, password } = req.body;

        const exists = await User.findOne({ email });
        if (exists) {
            return res.status(400).json({ message: "Usuario ya existe" });
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        const user = await User.create({
            firstname,
            lastname,
            email,
            password: hashedPassword,
            role: "SUPERADMIN",
        });

        // console.log(user);
        res.status(201).json({ message: "Superadmin creado", user });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

export const logout = (req, res) => {
    res.clearCookie("token", getCookieOptions());
    res.status(200).json({ message: "Sesión cerrada" });
};

export const getProfile = (req, res) => {
    try {
        // console.log(req.user)
        res.json(req.user);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// EMAILS

// COOLDOWN CONFIGURABLE (en segundos)
const REEND_COOLDOWN_SECONDS = 60;

// Solicitar token de restablecimiento
export const forgotPassword = async (req, res) => {
    try {
        const { email } = req.body; // Se recibe desde el body

        if (!email) {
            return res
                .status(400)
                .json({ message: "El correo electrónico es requerido." });
        }

        const user = await User.findOne({ email });

        // Por seguridad, si el usuario no existe respondes OK con el cooldown
        if (!user) {
            return res.status(200).json({
                message: "Si el correo está registrado, recibirás un enlace.",
                cooldownSeconds: REEND_COOLDOWN_SECONDS,
            });
        }

        // Generar Token
        const token = crypto.randomBytes(32).toString("hex");
        const tokenExpires = new Date(Date.now() + 3600000); // 1 hora de validez

        user.resetPasswordToken = token;
        user.resetPasswordExpires = tokenExpires;
        await user.save();

        // Enviar Email con la URL para React
        await sendResetPasswordEmail(user.email, token);

        return res.status(200).json({
            message: "Instrucciones enviadas con éxito.",
            cooldownSeconds: REEND_COOLDOWN_SECONDS, // El front requiere este campo exacto
        });
    } catch (error) {
        console.error("Error en forgotPassword:", error);
        return res
            .status(500)
            .json({ message: "Error al procesar la solicitud." });
    }
};

// Restablecer la contraseña con el token
export const resetPassword = async (req, res) => {
    try {
        // Tu frontend envía { token, newPassword } en el body
        const { token, newPassword } = req.body;

        if (!token || !newPassword) {
            return res
                .status(400)
                .json({
                    message:
                        "Datos incompletos para restablecer la contraseña.",
                });
        }

        // Buscar usuario por token y que el tiempo no haya expirado
        const user = await User.findOne({
            resetPasswordToken: token,
            resetPasswordExpires: { $gt: new Date() },
        });

        if (!user) {
            return res.status(400).json({
                message:
                    "El enlace de restablecimiento es inválido o ha expirado.",
            });
        }

        // Hashear y guardar nueva clave
        user.password = await bcrypt.hash(newPassword, 10);
        user.resetPasswordToken = null;
        user.resetPasswordExpires = null;
        await user.save();

        return res
            .status(200)
            .json({ message: "Contraseña restablecida exitosamente." });
    } catch (error) {
        console.error("Error en resetPassword:", error);
        return res
            .status(500)
            .json({ message: "Error al cambiar la contraseña." });
    }
};

export const testEmail = async (req, res) => {
    try {
        await sendVerificationEmail("serinlu2201@gmail.com", "TOKEN_PRUEBA");

        res.json({
            message: "Correo enviado",
        });
    } catch (error) {
        console.error(error);

        res.status(500).json({
            message: error.message,
        });
    }
};
