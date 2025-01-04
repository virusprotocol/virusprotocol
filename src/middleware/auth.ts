// src/middleware/auth.ts
import { PublicKey } from "@solana/web3.js";
import * as bs58 from "bs58";
import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import nacl from "tweetnacl";
import cookie from "cookie";

export interface AuthRequest extends Request {
  user?: {
    id: string;
    role?: string;
  };
}

const validateSignature = (
  message: string,
  signature: string,
  publicKey: string
): boolean => {
  try {
    const pubKey = new PublicKey(publicKey); // Create PublicKey object
    const sig = Buffer.from(signature, "base64"); // Decode base64 signature
    const msg = new TextEncoder().encode(message); // Encode message
    return nacl.sign.detached.verify(msg, sig, pubKey.toBytes());
  } catch (error) {
    console.error("Signature validation error:", error);
    return false;
  }
};

export const auth = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    if (req.headers["x-wallet-auth"]) {
      const { signature, publicKey, message } = req.headers;

      const isValid = await validateSignature(
        message as string,
        signature as string,
        publicKey as string
      );
      if (!isValid) {
        res.status(401).json({ error: "Invalid wallet signature" });
        return;
      }

      const token = jwt.sign(
        { id: publicKey, role: "user" },
        process.env.JWT_SECRET!,
        { expiresIn: "24h" }
      );

      req.user = { id: publicKey as string };

      // Set the cookie
      res.setHeader(
        "Set-Cookie",
        cookie.serialize("authToken", token, {
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: "strict",
          maxAge: 24 * 60 * 60, // 1 day
          path: "/", // Cookie accessible across the site
        })
      );

      next();
      return;
    }

    const token =
      req.header("Authorization")?.replace("Bearer ", "") || req.cookies.token;
    if (!token) throw new Error();

    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as {
      id: string;
      role: string;
    };

    req.user = decoded;
    next();
    return;
  } catch {
    res.status(401).json({ error: "Please authenticate" });
    return;
  }
};

export const adminOnly = (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): void => {
  if (req.user?.role !== "admin") {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  next();
};
