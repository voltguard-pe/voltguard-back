import jwt from "jsonwebtoken";

export const generateToken = (user) => {
  return jwt.sign(
    {
      id: user.id,
      role: user.role,
      plan: user.plan,
      company: user.companyPublicCode || user.company,
    },
    process.env.JWT_SECRET,
    { expiresIn: "30d" }
  );
};