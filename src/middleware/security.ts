import { Application } from "express";
import helmet from "helmet";
import cors from "cors";

export const setupSecurity = (app: Application): void => {
  const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(",") || [];
  // Basic security headers
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'"],
        },
      },
      hsts: {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true,
      },
    })
  );

  // CORS configuration
  app.use(
    cors({
      origin: (origin, callback) => {
        // Allow requests with no origin (like mobile apps or Postman)
        if (!origin || allowedOrigins.includes(origin)) {
          callback(null, true);
        } else {
          callback(new Error("Not allowed by CORS"));
        }
      },
      methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
      allowedHeaders: ["Content-Type", "Authorization"],
      credentials: true,
    })
  );

  // Remove sensitive headers
  app.disable("x-powered-by");
};
