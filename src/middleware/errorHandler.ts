// src/middleware/errorHandler.ts
import { Request, Response, NextFunction, ErrorRequestHandler } from "express";

export class AppError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
    this.name = "AppError";
  }
}

export const errorHandler: ErrorRequestHandler = (
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
) => {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: err.message,
    });
    return;
  }

  console.error("Unexpected error:", err);
  res.status(500).json({
    error:
      process.env.NODE_ENV === "production"
        ? "An unexpected error occurred"
        : err.message,
  });
};
