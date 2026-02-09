import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { promises as fsPromises } from "fs";
import { createServer } from "http";
import { Server } from "socket.io";
import { Worker } from "worker_threads";
import multer from "multer";
import archiver from "archiver";
import { z } from "zod";
import { toNodeHandler, fromNodeHeaders } from "better-auth/node";
import { auth, prisma } from "./auth";
import type { Prisma } from "./generated/client";
import {
  sanitizeDrawingData,
  validateImportedDrawing,
  sanitizeText,
  sanitizeSvg,
  elementSchema,
  appStateSchema,
  createCsrfToken,
  validateCsrfToken,
  getCsrfTokenHeader,
  getOriginFromReferer,
} from "./security";

dotenv.config();

const backendRoot = path.resolve(__dirname, "../");
const defaultDbPath = path.resolve(backendRoot, "prisma/dev.db");
const resolveDatabaseUrl = (rawUrl?: string) => {
  if (!rawUrl || rawUrl.trim().length === 0) {
    return `file:${defaultDbPath}`;
  }

  if (!rawUrl.startsWith("file:")) {
    return rawUrl;
  }

  const filePath = rawUrl.replace(/^file:/, "");

  // Prisma treats relative SQLite paths as relative to the schema directory
  // (i.e. `backend/prisma/schema.prisma`). Historically this project used
  // `file:./prisma/dev.db`, which Prisma interprets as `prisma/prisma/dev.db`.
  // To keep runtime and migrations aligned:
  // - Prefer resolving relative paths against `backend/prisma`
  // - But if the path already includes a leading `prisma/`, resolve from repo root
  const prismaDir = path.resolve(backendRoot, "prisma");
  const normalizedRelative = filePath.replace(/^\.\/?/, "");
  const hasLeadingPrismaDir =
    normalizedRelative === "prisma" ||
    normalizedRelative.startsWith("prisma/");

  const absolutePath = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(hasLeadingPrismaDir ? backendRoot : prismaDir, normalizedRelative);

  return `file:${absolutePath}`;
};

process.env.DATABASE_URL = resolveDatabaseUrl(process.env.DATABASE_URL);
console.log("Resolved DATABASE_URL:", process.env.DATABASE_URL);

// Helper to get the resolved database file path
const getResolvedDbPath = (): string => {
  const dbUrl = process.env.DATABASE_URL || `file:${defaultDbPath}`;
  if (dbUrl.startsWith("file:")) {
    return dbUrl.replace(/^file:/, "");
  }
  // Fallback to default for non-file URLs (e.g., Postgres)
  return defaultDbPath;
};

const normalizeOrigins = (rawOrigins?: string | null): string[] => {
  const fallback = "http://localhost:6767";
  if (!rawOrigins || rawOrigins.trim().length === 0) {
    return [fallback];
  }

  const ensureProtocol = (origin: string) =>
    /^https?:\/\//i.test(origin) ? origin : `http://${origin}`;

  const removeTrailingSlash = (origin: string) =>
    origin.endsWith("/") ? origin.slice(0, -1) : origin;

  const parsed = rawOrigins
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0)
    .map(ensureProtocol)
    .map(removeTrailingSlash);

  return parsed.length > 0 ? parsed : [fallback];
};

const allowedOrigins = normalizeOrigins(process.env.FRONTEND_URL);
console.log("Allowed origins:", allowedOrigins);

const uploadDir = path.resolve(__dirname, "../uploads");

const moveFile = async (source: string, destination: string) => {
  try {
    await fsPromises.rename(source, destination);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (!err || err.code !== "EXDEV") {
      throw error;
    }

    await fsPromises
      .unlink(destination)
      .catch((unlinkError: NodeJS.ErrnoException) => {
        if (unlinkError && unlinkError.code !== "ENOENT") {
          throw unlinkError;
        }
      });

    await fsPromises.copyFile(source, destination);
    await fsPromises.unlink(source);
  }
};

const initializeUploadDir = async () => {
  try {
    await fsPromises.mkdir(uploadDir, { recursive: true });
  } catch (error) {
    console.error("Failed to create upload directory:", error);
  }
};

const app = express();

// Trust proxy headers (X-Forwarded-For, X-Real-IP) from nginx
// Required for correct client IP detection when running behind a reverse proxy
// Fix for issue #38: Use 'true' to handle multiple proxy layers (e.g., Traefik, Synology NAS)
// This ensures Express extracts the real client IP from the leftmost X-Forwarded-For value
const trustProxyConfig = process.env.TRUST_PROXY || "true";
const trustProxyValue = trustProxyConfig === "true"
  ? true
  : trustProxyConfig === "false"
  ? false
  : parseInt(trustProxyConfig, 10) || 1;
app.set("trust proxy", trustProxyValue);

if (trustProxyValue === true) {
  console.log("[config] trust proxy: enabled (handles multiple proxy layers)");
} else {
  console.log(`[config] trust proxy: ${trustProxyValue}`);
}

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: allowedOrigins,
    credentials: true,
  },
  maxHttpBufferSize: 1e8,
  // Prefer WebSocket for lower latency; fall back to polling
  transports: ['websocket', 'polling'],
  // Reduce ping interval/timeout for faster disconnect detection
  pingInterval: 10000,
  pingTimeout: 5000,
  // Allow binary data for efficiency
  perMessageDeflate: false,
});

const parseJsonField = <T>(
  rawValue: string | null | undefined,
  fallback: T
): T => {
  if (!rawValue) return fallback;
  try {
    return JSON.parse(rawValue) as T;
  } catch (error) {
    console.warn("Failed to parse JSON field", {
      error,
      valuePreview: rawValue.slice(0, 50),
    });
    return fallback;
  }
};

const DRAWINGS_CACHE_TTL_MS = (() => {
  const parsed = Number(process.env.DRAWINGS_CACHE_TTL_MS);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 5_000;
  }
  return parsed;
})();
type DrawingsCacheEntry = { body: Buffer; expiresAt: number };
const drawingsCache = new Map<string, DrawingsCacheEntry>();

const buildDrawingsCacheKey = (keyParts: {
  userId: string;
  searchTerm: string;
  collectionFilter: string;
  includeData: boolean;
}) =>
  JSON.stringify([
    keyParts.userId,
    keyParts.searchTerm,
    keyParts.collectionFilter,
    keyParts.includeData ? "full" : "summary",
  ]);

const getCachedDrawingsBody = (key: string): Buffer | null => {
  const entry = drawingsCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    drawingsCache.delete(key);
    return null;
  }
  return entry.body;
};

const cacheDrawingsResponse = (key: string, payload: any): Buffer => {
  const body = Buffer.from(JSON.stringify(payload));
  drawingsCache.set(key, {
    body,
    expiresAt: Date.now() + DRAWINGS_CACHE_TTL_MS,
  });
  return body;
};

const invalidateDrawingsCache = () => {
  drawingsCache.clear();
};

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of drawingsCache.entries()) {
    if (now > entry.expiresAt) {
      drawingsCache.delete(key);
    }
  }
}, 60_000).unref();

const PORT = process.env.PORT || 8000;

const upload = multer({
  dest: uploadDir,
  limits: {
    fileSize: 100 * 1024 * 1024,
    files: 1,
  },
  fileFilter: (req, file, cb) => {
    if (file.fieldname === "db") {
      const isSqliteDb =
        file.originalname.endsWith(".db") ||
        file.originalname.endsWith(".sqlite");
      if (!isSqliteDb) {
        return cb(new Error("Only .db or .sqlite files are allowed"));
      }
    }
    cb(null, true);
  },
});

app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization", "x-csrf-token"],
    exposedHeaders: ["x-csrf-token"],
  })
);

// Mount Better Auth handler BEFORE express.json() middleware
// Better-Auth needs to parse its own requests
app.all("/api/auth/{*any}", toNodeHandler(auth));

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

app.use((req, res, next) => {
  const contentLength = req.headers["content-length"];
  if (contentLength) {
    const sizeInMB = parseInt(contentLength, 10) / 1024 / 1024;
    if (sizeInMB > 10) {
      console.log(
        `[LARGE REQUEST] ${req.method} ${req.path} - ${sizeInMB.toFixed(
          2
        )}MB - Content-Length: ${contentLength} bytes`
      );
    }
  }
  next();
});

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader(
    "Permissions-Policy",
    "geolocation=(), microphone=(), camera=()"
  );

  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://unpkg.com; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src 'self' https://fonts.gstatic.com; " +
    "img-src 'self' data: blob: https:; " +
    "connect-src 'self' ws: wss:; " +
    "frame-ancestors 'none';"
  );

  next();
});

const requestCounts = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT_WINDOW = 15 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [ip, data] of requestCounts.entries()) {
    if (now > data.resetTime) {
      requestCounts.delete(ip);
    }
  }
}, 5 * 60 * 1000).unref();

const RATE_LIMIT_MAX_REQUESTS = (() => {
  const parsed = Number(process.env.RATE_LIMIT_MAX_REQUESTS);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 1000;
  }
  return parsed;
})();

app.use((req, res, next) => {
  // Skip rate limiting for auth routes (Better-Auth handles its own)
  if (req.path.startsWith("/api/auth")) {
    return next();
  }

  const ip = req.ip || req.connection.remoteAddress || "unknown";
  const now = Date.now();
  const clientData = requestCounts.get(ip);

  if (!clientData || now > clientData.resetTime) {
    requestCounts.set(ip, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
    return next();
  }

  if (clientData.count >= RATE_LIMIT_MAX_REQUESTS) {
    return res.status(429).json({
      error: "Rate limit exceeded",
      message: "Too many requests, please try again later",
    });
  }

  clientData.count++;
  next();
});

// CSRF Protection Middleware
// Generates a unique client ID based on IP and User-Agent for token association
const getClientId = (req: express.Request): string => {
  const ip = req.ip || req.connection.remoteAddress || "unknown";
  const userAgent = req.headers["user-agent"] || "unknown";
  const clientId = `${ip}:${userAgent}`.slice(0, 256);

  // Debug logging for CSRF troubleshooting (issue #38)
  if (process.env.DEBUG_CSRF === "true") {
    console.log("[CSRF DEBUG] getClientId", {
      method: req.method,
      path: req.path,
      ip,
      remoteAddress: req.connection.remoteAddress,
      "x-forwarded-for": req.headers["x-forwarded-for"],
      "x-real-ip": req.headers["x-real-ip"],
      userAgent: userAgent.slice(0, 100),
      clientIdPreview: clientId.slice(0, 60) + "...",
      trustProxySetting: req.app.get("trust proxy"),
    });
  }

  return clientId;
};

// Rate limiter specifically for CSRF token generation to prevent store exhaustion
const csrfRateLimit = new Map<string, { count: number; resetTime: number }>();
const CSRF_RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const CSRF_MAX_REQUESTS = (() => {
  const parsed = Number(process.env.CSRF_MAX_REQUESTS);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 60; // 1 per second average
  }
  return parsed;
})();

// CSRF token endpoint - clients should call this to get a token
app.get("/csrf-token", (req, res) => {
  const ip = req.ip || req.connection.remoteAddress || "unknown";
  const now = Date.now();
  const clientLimit = csrfRateLimit.get(ip);

  if (clientLimit && now < clientLimit.resetTime) {
    if (clientLimit.count >= CSRF_MAX_REQUESTS) {
      return res.status(429).json({
        error: "Rate limit exceeded",
        message: "Too many CSRF token requests",
      });
    }
    clientLimit.count++;
  } else {
    csrfRateLimit.set(ip, { count: 1, resetTime: now + CSRF_RATE_LIMIT_WINDOW });
  }

  // Cleanup old rate limit entries occasionally
  if (Math.random() < 0.01) {
    for (const [key, data] of csrfRateLimit.entries()) {
      if (now > data.resetTime) csrfRateLimit.delete(key);
    }
  }

  const clientId = getClientId(req);
  const token = createCsrfToken(clientId);

  res.json({
    token,
    header: getCsrfTokenHeader()
  });
});

// CSRF validation middleware for state-changing requests
const csrfProtectionMiddleware = (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) => {
  // Skip CSRF validation for auth routes (Better-Auth handles its own CSRF)
  if (req.path.startsWith("/api/auth")) {
    return next();
  }

  // Skip CSRF validation for safe methods (GET, HEAD, OPTIONS)
  // Note: /csrf-token is a GET endpoint, so it's automatically exempt
  const safeMethods = ["GET", "HEAD", "OPTIONS"];
  if (safeMethods.includes(req.method)) {
    return next();
  }

  // Origin/Referer check for defense in depth
  const origin = req.headers["origin"];
  const referer = req.headers["referer"];

  // If Origin is present, it must match allowed origins
  const originValue = Array.isArray(origin) ? origin[0] : origin;
  const refererValue = Array.isArray(referer) ? referer[0] : referer;

  if (originValue) {
    if (!allowedOrigins.includes(originValue)) {
      return res.status(403).json({
        error: "CSRF origin mismatch",
        message: "Origin not allowed",
      });
    }
  } else if (refererValue) {
    // If no Origin but Referer exists, validate its *origin* (avoid prefix bypass)
    const refererOrigin = getOriginFromReferer(refererValue);
    if (!refererOrigin || !allowedOrigins.includes(refererOrigin)) {
      return res.status(403).json({
        error: "CSRF referer mismatch",
        message: "Referer not allowed",
      });
    }
  }
  // Note: If neither Origin nor Referer is present, we proceed to token check.
  // Some legitimate clients/proxies might strip these, so we don't block strictly on their absence,
  // but relying on the token is the primary defense.

  const clientId = getClientId(req);
  const headerName = getCsrfTokenHeader();
  const tokenHeader = req.headers[headerName];
  const token = Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader;

  if (!token) {
    return res.status(403).json({
      error: "CSRF token missing",
      message: `Missing ${headerName} header`,
    });
  }

  if (!validateCsrfToken(clientId, token)) {
    return res.status(403).json({
      error: "CSRF token invalid",
      message: "Invalid or expired CSRF token. Please refresh and try again.",
    });
  }

  next();
};

// Apply CSRF protection to all routes
app.use(csrfProtectionMiddleware);

// ==========================================
// Authentication Middleware
// ==========================================

interface AuthenticatedRequest extends express.Request {
  user?: {
    id: string;
    email: string;
    name: string;
    role: string | null;
    banned: boolean | null;
  };
  session?: {
    id: string;
    userId: string;
    expiresAt: Date;
  };
}

// Middleware to require authentication
const requireAuth = async (
  req: AuthenticatedRequest,
  res: express.Response,
  next: express.NextFunction
) => {
  try {
    const session = await auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });

    if (!session) {
      return res.status(401).json({
        error: "Unauthorized",
        message: "You must be logged in to access this resource",
      });
    }

    // Check if user is banned
    if (session.user.banned) {
      return res.status(403).json({
        error: "Forbidden",
        message: "Your account has been banned",
      });
    }

    req.user = {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
      role: session.user.role ?? null,
      banned: session.user.banned ?? null,
    };
    req.session = {
      id: session.session.id,
      userId: session.session.userId,
      expiresAt: session.session.expiresAt,
    };

    next();
  } catch (error) {
    console.error("Auth middleware error:", error);
    return res.status(401).json({
      error: "Unauthorized",
      message: "Authentication failed",
    });
  }
};

// Middleware to require admin role
const requireAdmin = async (
  req: AuthenticatedRequest,
  res: express.Response,
  next: express.NextFunction
) => {
  // First run requireAuth
  await requireAuth(req, res, () => {
    if (!req.user) {
      return; // requireAuth already sent response
    }

    if (req.user.role !== "admin") {
      return res.status(403).json({
        error: "Forbidden",
        message: "Admin access required",
      });
    }

    next();
  });
};

// ==========================================
// App Settings Endpoints
// ==========================================

// Get app settings (public - needed for login page)
app.get("/settings/app", async (req, res) => {
  try {
    const settings = await prisma.appSettings.findUnique({
      where: { id: "default" },
    });

    // Check if this is first time setup (no users exist)
    const userCount = await prisma.user.count();
    const isFirstTimeSetup = userCount === 0;

    res.json({
      signupsDisabled: settings?.signupsDisabled ?? false,
      isFirstTimeSetup,
    });
  } catch (error) {
    console.error("Failed to fetch app settings:", error);
    res.status(500).json({ error: "Failed to fetch app settings" });
  }
});

// Update app settings (admin only)
app.put("/settings/app", requireAdmin as any, async (req: AuthenticatedRequest, res) => {
  try {
    const { signupsDisabled } = req.body;

    const settings = await prisma.appSettings.upsert({
      where: { id: "default" },
      update: { signupsDisabled: Boolean(signupsDisabled) },
      create: { id: "default", signupsDisabled: Boolean(signupsDisabled) },
    });

    res.json(settings);
  } catch (error) {
    console.error("Failed to update app settings:", error);
    res.status(500).json({ error: "Failed to update app settings" });
  }
});

// ==========================================
// Admin User Management Endpoints
// ==========================================

// List all users (admin only)
app.get("/admin/users", requireAdmin as any, async (req: AuthenticatedRequest, res) => {
  try {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        banned: true,
        banReason: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: "desc" },
    });

    res.json(users);
  } catch (error) {
    console.error("Failed to list users:", error);
    res.status(500).json({ error: "Failed to list users" });
  }
});

// Create user (admin only)
app.post("/admin/users", requireAdmin as any, async (req: AuthenticatedRequest, res) => {
  try {
    const { email, password, name, role } = req.body;

    if (!email || !password || !name) {
      return res.status(400).json({
        error: "Missing required fields",
        message: "Email, password, and name are required",
      });
    }

    // Use Better-Auth's admin API to create user
    const result = await auth.api.createUser({
      body: {
        email,
        password,
        name,
        role: role || "user",
      },
    });

    res.json(result);
  } catch (error: any) {
    console.error("Failed to create user:", error);
    res.status(400).json({
      error: "Failed to create user",
      message: error.message || "Unknown error",
    });
  }
});

// Update user role (admin only)
app.put("/admin/users/:userId/role", requireAdmin as any, async (req: AuthenticatedRequest, res) => {
  try {
    const { userId } = req.params;
    const { role } = req.body;

    if (!role || !["user", "admin"].includes(role)) {
      return res.status(400).json({
        error: "Invalid role",
        message: "Role must be 'user' or 'admin'",
      });
    }

    // Prevent admin from removing their own admin role
    if (userId === req.user!.id && role !== "admin") {
      return res.status(400).json({
        error: "Cannot demote self",
        message: "You cannot remove your own admin role",
      });
    }

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: { role },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        banned: true,
      },
    });

    res.json(updatedUser);
  } catch (error) {
    console.error("Failed to update user role:", error);
    res.status(500).json({ error: "Failed to update user role" });
  }
});

// Ban user (admin only)
app.post("/admin/users/:userId/ban", requireAdmin as any, async (req: AuthenticatedRequest, res) => {
  try {
    const { userId } = req.params;
    const { reason } = req.body;

    // Prevent admin from banning themselves
    if (userId === req.user!.id) {
      return res.status(400).json({
        error: "Cannot ban self",
        message: "You cannot ban your own account",
      });
    }

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: {
        banned: true,
        banReason: reason || "No reason provided",
      },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        banned: true,
        banReason: true,
      },
    });

    // Revoke all sessions for banned user
    await prisma.session.deleteMany({
      where: { userId },
    });

    res.json(updatedUser);
  } catch (error) {
    console.error("Failed to ban user:", error);
    res.status(500).json({ error: "Failed to ban user" });
  }
});

// Unban user (admin only)
app.post("/admin/users/:userId/unban", requireAdmin as any, async (req: AuthenticatedRequest, res) => {
  try {
    const { userId } = req.params;

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: {
        banned: false,
        banReason: null,
      },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        banned: true,
      },
    });

    res.json(updatedUser);
  } catch (error) {
    console.error("Failed to unban user:", error);
    res.status(500).json({ error: "Failed to unban user" });
  }
});

// Delete user (admin only)
app.delete("/admin/users/:userId", requireAdmin as any, async (req: AuthenticatedRequest, res) => {
  try {
    const { userId } = req.params;

    // Prevent admin from deleting themselves
    if (userId === req.user!.id) {
      return res.status(400).json({
        error: "Cannot delete self",
        message: "You cannot delete your own account",
      });
    }

    await prisma.user.delete({
      where: { id: userId },
    });

    res.json({ success: true });
  } catch (error) {
    console.error("Failed to delete user:", error);
    res.status(500).json({ error: "Failed to delete user" });
  }
});

// ==========================================
// Zod Schemas
// ==========================================

const filesFieldSchema = z
  .union([z.record(z.string(), z.any()), z.null()])
  .optional()
  .transform((value) => (value === null ? undefined : value));

const drawingBaseSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  collectionId: z.union([z.string().trim().min(1), z.null()]).optional(),
  preview: z.string().nullable().optional(),
});

const drawingCreateSchema = drawingBaseSchema
  .extend({
    elements: elementSchema.array().default([]),
    appState: appStateSchema.default({}),
    files: filesFieldSchema,
  })
  .refine(
    (data) => {
      try {
        const sanitized = sanitizeDrawingData(data);
        Object.assign(data, sanitized);
        return true;
      } catch (error) {
        console.error("Sanitization failed:", error);
        return false;
      }
    },
    {
      message: "Invalid or malicious drawing data detected",
    }
  );

const drawingUpdateSchema = drawingBaseSchema
  .extend({
    elements: elementSchema.array().optional(),
    appState: appStateSchema.optional(),
    files: filesFieldSchema,
  })
  .refine(
    (data) => {
      try {
        const sanitizedData = { ...data };
        if (data.elements !== undefined || data.appState !== undefined) {
          const fullData = {
            elements: Array.isArray(data.elements) ? data.elements : [],
            appState:
              typeof data.appState === "object" && data.appState !== null
                ? data.appState
                : {},
            files: data.files || {},
            preview: data.preview,
            name: data.name,
            collectionId: data.collectionId,
          };
          const sanitized = sanitizeDrawingData(fullData);
          sanitizedData.elements = sanitized.elements;
          sanitizedData.appState = sanitized.appState;
          if (data.files !== undefined) sanitizedData.files = sanitized.files;
          if (data.preview !== undefined)
            sanitizedData.preview = sanitized.preview;
          Object.assign(data, sanitizedData);
        }
        return true;
      } catch (error) {
        console.error("Sanitization failed:", error);
        if (
          data.elements === undefined &&
          data.appState === undefined &&
          (data.name !== undefined ||
            data.preview !== undefined ||
            data.collectionId !== undefined)
        ) {
          return true;
        }
        return false;
      }
    },
    {
      message: "Invalid or malicious drawing data detected",
    }
  );

const respondWithValidationErrors = (
  res: express.Response,
  issues: z.ZodIssue[]
) => {
  res.status(400).json({
    error: "Invalid drawing payload",
    details: issues,
  });
};

const validateSqliteHeader = (filePath: string): boolean => {
  try {
    const buffer = Buffer.alloc(16);
    const fd = fs.openSync(filePath, "r");
    const bytesRead = fs.readSync(fd, buffer, 0, 16, 0);
    fs.closeSync(fd);

    if (bytesRead < 16) {
      console.warn("File too small to be a valid SQLite database");
      return false;
    }

    const expectedHeader = Buffer.from([
      0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61,
      0x74, 0x20, 0x33, 0x00,
    ]);

    const isValid = buffer.equals(expectedHeader);
    if (!isValid) {
      console.warn("Invalid SQLite file header detected", {
        filePath,
        header: buffer.toString("hex"),
        expected: expectedHeader.toString("hex"),
      });
    }

    return isValid;
  } catch (error) {
    console.error("Failed to validate SQLite header:", error);
    return false;
  }
};
const verifyDatabaseIntegrityAsync = (filePath: string): Promise<boolean> => {
  if (!validateSqliteHeader(filePath)) {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    const worker = new Worker(
      path.resolve(__dirname, "./workers/db-verify.js"),
      {
        workerData: { filePath },
      }
    );
    let timeoutHandle: NodeJS.Timeout;
    let settled = false;

    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      resolve(result);
    };

    worker.on("message", (isValid: boolean) => finish(isValid));
    worker.on("error", (err) => {
      console.error("Worker error:", err);
      finish(false);
    });
    worker.on("exit", (code) => {
      if (code !== 0) {
        finish(false);
      }
    });

    timeoutHandle = setTimeout(() => {
      console.warn("Integrity check worker timed out", { filePath });
      worker.terminate();
      finish(false);
    }, 10000);
  });
};

const removeFileIfExists = async (filePath?: string) => {
  if (!filePath) return;
  try {
    await fsPromises.access(filePath).catch(() => {
      return;
    });
    await fsPromises.unlink(filePath);
  } catch (error) {
    console.error("Failed to remove file", { filePath, error });
  }
};

// ==========================================
// Socket.IO for Real-time Collaboration
// ==========================================

interface SocketUser {
  id: string;
  name: string;
  initials: string;
  color: string;
  socketId: string;
  isActive: boolean;
}

const roomUsers = new Map<string, SocketUser[]>();

io.on("connection", (socket) => {
  socket.on(
    "join-room",
    ({
      drawingId,
      user,
    }: {
      drawingId: string;
      user: Omit<SocketUser, "socketId" | "isActive">;
    }) => {
      const roomId = `drawing_${drawingId}`;
      socket.join(roomId);

      const newUser: SocketUser = { ...user, socketId: socket.id, isActive: true };

      const currentUsers = roomUsers.get(roomId) || [];
      const filteredUsers = currentUsers.filter((u) => u.id !== user.id);
      filteredUsers.push(newUser);
      roomUsers.set(roomId, filteredUsers);

      io.to(roomId).emit("presence-update", filteredUsers);
    }
  );

  socket.on("cursor-move", (data) => {
    const roomId = `drawing_${data.drawingId}`;
    socket.volatile.to(roomId).emit("cursor-move", data);
  });

  socket.on("element-update", (data) => {
    const roomId = `drawing_${data.drawingId}`;
    socket.to(roomId).emit("element-update", data);
  });

  socket.on(
    "user-activity",
    ({ drawingId, isActive }: { drawingId: string; isActive: boolean }) => {
      const roomId = `drawing_${drawingId}`;
      const users = roomUsers.get(roomId);
      if (users) {
        const user = users.find((u) => u.socketId === socket.id);
        if (user) {
          user.isActive = isActive;
          io.to(roomId).emit("presence-update", users);
        }
      }
    }
  );

  socket.on("disconnect", () => {
    roomUsers.forEach((users, roomId) => {
      const index = users.findIndex((u) => u.socketId === socket.id);
      if (index !== -1) {
        users.splice(index, 1);
        roomUsers.set(roomId, users);
        io.to(roomId).emit("presence-update", users);
      }
    });
  });
});

// ==========================================
// API Routes
// ==========================================

app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

// Get current user info
app.get("/me", requireAuth as any, async (req: AuthenticatedRequest, res) => {
  res.json({
    user: req.user,
    session: req.session,
  });
});

// ==========================================
// Drawings API (Protected)
// ==========================================

app.get("/drawings", requireAuth as any, async (req: AuthenticatedRequest, res) => {
  try {
    const { search, collectionId, includeData } = req.query;
    const userId = req.user!.id;

    const where: any = { userId };
    const searchTerm =
      typeof search === "string" && search.trim().length > 0
        ? search.trim()
        : undefined;

    if (searchTerm) {
      where.name = { contains: searchTerm };
    }

    let collectionFilterKey = "default";
    if (collectionId === "null") {
      where.collectionId = null;
      collectionFilterKey = "null";
    } else if (collectionId) {
      const normalizedCollectionId = String(collectionId);
      where.collectionId = normalizedCollectionId;
      collectionFilterKey = `id:${normalizedCollectionId}`;
    } else {
      where.OR = [{ collectionId: { not: "trash" } }, { collectionId: null }];
    }

    const shouldIncludeData =
      typeof includeData === "string"
        ? includeData.toLowerCase() === "true" || includeData === "1"
        : false;

    const cacheKey = buildDrawingsCacheKey({
      userId,
      searchTerm: searchTerm ?? "",
      collectionFilter: collectionFilterKey,
      includeData: shouldIncludeData,
    });

    const cachedBody = getCachedDrawingsBody(cacheKey);
    if (cachedBody) {
      res.setHeader("X-Cache", "HIT");
      res.setHeader("Content-Type", "application/json");
      return res.send(cachedBody);
    }

    const summarySelect: Prisma.DrawingSelect = {
      id: true,
      name: true,
      collectionId: true,
      preview: true,
      version: true,
      createdAt: true,
      updatedAt: true,
    };

    const queryOptions: Prisma.DrawingFindManyArgs = {
      where,
      orderBy: { updatedAt: "desc" },
    };

    if (!shouldIncludeData) {
      queryOptions.select = summarySelect;
    }

    const drawings = await prisma.drawing.findMany(queryOptions);

    let responsePayload: any = drawings;

    if (shouldIncludeData) {
      responsePayload = drawings.map((d: any) => ({
        ...d,
        elements: parseJsonField(d.elements, []),
        appState: parseJsonField(d.appState, {}),
        files: parseJsonField(d.files, {}),
      }));
    }

    const body = cacheDrawingsResponse(cacheKey, responsePayload);
    res.setHeader("X-Cache", "MISS");
    res.setHeader("Content-Type", "application/json");
    return res.send(body);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch drawings" });
  }
});

app.get("/drawings/:id", requireAuth as any, async (req: AuthenticatedRequest, res) => {
  try {
    const { id } = req.params;
    const userId = req.user!.id;

    console.log("[API] Fetching drawing", { id, userId });
    const drawing = await prisma.drawing.findFirst({
      where: { id, userId },
    });

    if (!drawing) {
      console.warn("[API] Drawing not found", { id });
      return res.status(404).json({ error: "Drawing not found" });
    }

    res.json({
      ...drawing,
      elements: JSON.parse(drawing.elements),
      appState: JSON.parse(drawing.appState),
      files: JSON.parse(drawing.files || "{}"),
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch drawing" });
  }
});

app.post("/drawings", requireAuth as any, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.id;
    const isImportedDrawing = req.headers["x-imported-file"] === "true";

    if (isImportedDrawing && !validateImportedDrawing(req.body)) {
      return res.status(400).json({
        error: "Invalid imported drawing file",
        message:
          "The imported file contains potentially malicious content or invalid structure",
      });
    }

    const parsed = drawingCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return respondWithValidationErrors(res, parsed.error.issues);
    }

    const payload = parsed.data;
    const drawingName = payload.name ?? "Untitled Drawing";
    const targetCollectionId =
      payload.collectionId === undefined ? null : payload.collectionId;

    const newDrawing = await prisma.drawing.create({
      data: {
        name: drawingName,
        elements: JSON.stringify(payload.elements),
        appState: JSON.stringify(payload.appState),
        collectionId: targetCollectionId,
        preview: payload.preview ?? null,
        files: JSON.stringify(payload.files ?? {}),
        userId,
      },
    });
    invalidateDrawingsCache();

    res.json({
      ...newDrawing,
      elements: JSON.parse(newDrawing.elements),
      appState: JSON.parse(newDrawing.appState),
      files: JSON.parse(newDrawing.files || "{}"),
    });
  } catch (error) {
    console.error("Failed to create drawing:", error);
    res.status(500).json({ error: "Failed to create drawing" });
  }
});

app.put("/drawings/:id", requireAuth as any, async (req: AuthenticatedRequest, res) => {
  try {
    const { id } = req.params;
    const userId = req.user!.id;

    // Verify ownership
    const existing = await prisma.drawing.findFirst({
      where: { id, userId },
    });

    if (!existing) {
      return res.status(404).json({ error: "Drawing not found" });
    }

    const parsed = drawingUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      console.error("[API] Validation failed", {
        id,
        errorCount: parsed.error.issues.length,
        errors: parsed.error.issues.map((issue) => ({
          path: issue.path,
          message: issue.message,
          received:
            issue.path.length > 0 ? req.body?.[issue.path.join(".")] : "root",
        })),
      });
      return respondWithValidationErrors(res, parsed.error.issues);
    }

    const payload = parsed.data;

    const data: any = {
      version: { increment: 1 },
    };

    if (payload.name !== undefined) data.name = payload.name;
    if (payload.elements !== undefined)
      data.elements = JSON.stringify(payload.elements);
    if (payload.appState !== undefined)
      data.appState = JSON.stringify(payload.appState);
    if (payload.files !== undefined) data.files = JSON.stringify(payload.files);
    if (payload.collectionId !== undefined)
      data.collectionId = payload.collectionId;
    if (payload.preview !== undefined) data.preview = payload.preview;

    const updatedDrawing = await prisma.drawing.update({
      where: { id },
      data,
    });
    invalidateDrawingsCache();

    res.json({
      ...updatedDrawing,
      elements: JSON.parse(updatedDrawing.elements),
      appState: JSON.parse(updatedDrawing.appState),
      files: JSON.parse(updatedDrawing.files || "{}"),
    });
  } catch (error) {
    console.error("[CRITICAL] Update failed:", error);
    res.status(500).json({ error: "Failed to update drawing" });
  }
});

app.delete("/drawings/:id", requireAuth as any, async (req: AuthenticatedRequest, res) => {
  try {
    const { id } = req.params;
    const userId = req.user!.id;

    // Verify ownership
    const existing = await prisma.drawing.findFirst({
      where: { id, userId },
    });

    if (!existing) {
      return res.status(404).json({ error: "Drawing not found" });
    }

    await prisma.drawing.delete({ where: { id } });
    invalidateDrawingsCache();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: "Failed to delete drawing" });
  }
});

app.post("/drawings/:id/duplicate", requireAuth as any, async (req: AuthenticatedRequest, res) => {
  try {
    const { id } = req.params;
    const userId = req.user!.id;

    const original = await prisma.drawing.findFirst({
      where: { id, userId },
    });

    if (!original) {
      return res.status(404).json({ error: "Original drawing not found" });
    }

    const newDrawing = await prisma.drawing.create({
      data: {
        name: `${original.name} (Copy)`,
        elements: original.elements,
        appState: original.appState,
        files: original.files,
        collectionId: original.collectionId,
        version: 1,
        userId,
      },
    });
    invalidateDrawingsCache();

    res.json({
      ...newDrawing,
      elements: JSON.parse(newDrawing.elements),
      appState: JSON.parse(newDrawing.appState),
      files: JSON.parse(newDrawing.files || "{}"),
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to duplicate drawing" });
  }
});

// ==========================================
// Share Links API
// ==========================================

// Create a share link for a drawing
app.post("/drawings/:id/share", requireAuth as any, async (req: AuthenticatedRequest, res) => {
  try {
    const { id } = req.params;
    const userId = req.user!.id;
    const { permission = "view", expiresIn } = req.body;

    // Validate permission
    if (!["view", "edit"].includes(permission)) {
      return res.status(400).json({ error: "Permission must be 'view' or 'edit'" });
    }

    // Verify ownership
    const drawing = await prisma.drawing.findFirst({
      where: { id, userId },
    });
    if (!drawing) {
      return res.status(404).json({ error: "Drawing not found" });
    }

    // Calculate expiry
    let expiresAt: Date | null = null;
    if (expiresIn) {
      const hours = parseInt(expiresIn, 10);
      if (isNaN(hours) || hours <= 0) {
        return res.status(400).json({ error: "expiresIn must be a positive number of hours" });
      }
      expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000);
    }

    const shareLink = await prisma.shareLink.create({
      data: {
        drawingId: id,
        createdBy: userId,
        permission,
        expiresAt,
      },
    });

    res.json({
      id: shareLink.id,
      token: shareLink.token,
      permission: shareLink.permission,
      expiresAt: shareLink.expiresAt,
      isActive: shareLink.isActive,
      createdAt: shareLink.createdAt,
    });
  } catch (error) {
    console.error("Failed to create share link:", error);
    res.status(500).json({ error: "Failed to create share link" });
  }
});

// List share links for a drawing
app.get("/drawings/:id/share", requireAuth as any, async (req: AuthenticatedRequest, res) => {
  try {
    const { id } = req.params;
    const userId = req.user!.id;

    // Verify ownership
    const drawing = await prisma.drawing.findFirst({
      where: { id, userId },
    });
    if (!drawing) {
      return res.status(404).json({ error: "Drawing not found" });
    }

    const links = await prisma.shareLink.findMany({
      where: { drawingId: id },
      orderBy: { createdAt: "desc" },
    });

    res.json(links.map(link => ({
      id: link.id,
      token: link.token,
      permission: link.permission,
      expiresAt: link.expiresAt,
      isActive: link.isActive,
      createdAt: link.createdAt,
    })));
  } catch (error) {
    console.error("Failed to list share links:", error);
    res.status(500).json({ error: "Failed to list share links" });
  }
});

// Update a share link (toggle active, change permission/expiry)
app.put("/share-links/:linkId", requireAuth as any, async (req: AuthenticatedRequest, res) => {
  try {
    const { linkId } = req.params;
    const userId = req.user!.id;
    const { permission, isActive, expiresIn } = req.body;

    const link = await prisma.shareLink.findUnique({
      where: { id: linkId },
    });
    if (!link || link.createdBy !== userId) {
      return res.status(404).json({ error: "Share link not found" });
    }

    const data: any = {};
    if (permission !== undefined) {
      if (!["view", "edit"].includes(permission)) {
        return res.status(400).json({ error: "Permission must be 'view' or 'edit'" });
      }
      data.permission = permission;
    }
    if (isActive !== undefined) {
      data.isActive = Boolean(isActive);
    }
    if (expiresIn !== undefined) {
      if (expiresIn === null) {
        data.expiresAt = null;
      } else {
        const hours = parseInt(expiresIn, 10);
        if (isNaN(hours) || hours <= 0) {
          return res.status(400).json({ error: "expiresIn must be a positive number of hours" });
        }
        data.expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000);
      }
    }

    const updated = await prisma.shareLink.update({
      where: { id: linkId },
      data,
    });

    res.json({
      id: updated.id,
      token: updated.token,
      permission: updated.permission,
      expiresAt: updated.expiresAt,
      isActive: updated.isActive,
      createdAt: updated.createdAt,
    });
  } catch (error) {
    console.error("Failed to update share link:", error);
    res.status(500).json({ error: "Failed to update share link" });
  }
});

// Delete a share link
app.delete("/share-links/:linkId", requireAuth as any, async (req: AuthenticatedRequest, res) => {
  try {
    const { linkId } = req.params;
    const userId = req.user!.id;

    const link = await prisma.shareLink.findUnique({
      where: { id: linkId },
    });
    if (!link || link.createdBy !== userId) {
      return res.status(404).json({ error: "Share link not found" });
    }

    await prisma.shareLink.delete({ where: { id: linkId } });
    res.json({ success: true });
  } catch (error) {
    console.error("Failed to delete share link:", error);
    res.status(500).json({ error: "Failed to delete share link" });
  }
});

// Public: Access a shared drawing via token (no auth required)
app.get("/shared/:token", async (req, res) => {
  try {
    const { token } = req.params;

    const link = await prisma.shareLink.findUnique({
      where: { token },
      include: { drawing: true },
    });

    if (!link) {
      return res.status(404).json({ error: "Shared link not found" });
    }

    if (!link.isActive) {
      return res.status(403).json({ error: "This share link has been deactivated" });
    }

    if (link.expiresAt && new Date() > link.expiresAt) {
      return res.status(403).json({ error: "This share link has expired" });
    }

    const drawing = link.drawing;
    res.json({
      id: drawing.id,
      name: drawing.name,
      elements: JSON.parse(drawing.elements),
      appState: JSON.parse(drawing.appState),
      files: JSON.parse(drawing.files || "{}"),
      permission: link.permission,
      version: drawing.version,
    });
  } catch (error) {
    console.error("Failed to access shared drawing:", error);
    res.status(500).json({ error: "Failed to access shared drawing" });
  }
});

// Public: Update a shared drawing (edit permission required, no auth required)
app.put("/shared/:token", async (req, res) => {
  try {
    const { token } = req.params;

    const link = await prisma.shareLink.findUnique({
      where: { token },
      include: { drawing: true },
    });

    if (!link) {
      return res.status(404).json({ error: "Shared link not found" });
    }

    if (!link.isActive) {
      return res.status(403).json({ error: "This share link has been deactivated" });
    }

    if (link.expiresAt && new Date() > link.expiresAt) {
      return res.status(403).json({ error: "This share link has expired" });
    }

    if (link.permission !== "edit") {
      return res.status(403).json({ error: "This share link is view-only" });
    }

    const { elements, appState, files } = req.body;
    const data: any = { version: { increment: 1 } };
    if (elements !== undefined) data.elements = JSON.stringify(elements);
    if (appState !== undefined) data.appState = JSON.stringify(appState);
    if (files !== undefined) data.files = JSON.stringify(files);

    const updated = await prisma.drawing.update({
      where: { id: link.drawingId },
      data,
    });
    invalidateDrawingsCache();

    res.json({
      id: updated.id,
      name: updated.name,
      elements: JSON.parse(updated.elements),
      appState: JSON.parse(updated.appState),
      files: JSON.parse(updated.files || "{}"),
      permission: link.permission,
      version: updated.version,
    });
  } catch (error) {
    console.error("Failed to update shared drawing:", error);
    res.status(500).json({ error: "Failed to update shared drawing" });
  }
});

// ==========================================
// Collections API (Protected)
// ==========================================

app.get("/collections", requireAuth as any, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.id;

    const collections = await prisma.collection.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });
    res.json(collections);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch collections" });
  }
});

app.post("/collections", requireAuth as any, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.id;
    const { name } = req.body;

    const newCollection = await prisma.collection.create({
      data: { name, userId },
    });
    res.json(newCollection);
  } catch (error) {
    res.status(500).json({ error: "Failed to create collection" });
  }
});

app.put("/collections/:id", requireAuth as any, async (req: AuthenticatedRequest, res) => {
  try {
    const { id } = req.params;
    const userId = req.user!.id;
    const { name } = req.body;

    // Verify ownership
    const existing = await prisma.collection.findFirst({
      where: { id, userId },
    });

    if (!existing) {
      return res.status(404).json({ error: "Collection not found" });
    }

    const updatedCollection = await prisma.collection.update({
      where: { id },
      data: { name },
    });
    res.json(updatedCollection);
  } catch (error) {
    res.status(500).json({ error: "Failed to update collection" });
  }
});

app.delete("/collections/:id", requireAuth as any, async (req: AuthenticatedRequest, res) => {
  try {
    const { id } = req.params;
    const userId = req.user!.id;

    // Verify ownership
    const existing = await prisma.collection.findFirst({
      where: { id, userId },
    });

    if (!existing) {
      return res.status(404).json({ error: "Collection not found" });
    }

    await prisma.$transaction([
      prisma.drawing.updateMany({
        where: { collectionId: id, userId },
        data: { collectionId: null },
      }),
      prisma.collection.delete({
        where: { id },
      }),
    ]);
    invalidateDrawingsCache();

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: "Failed to delete collection" });
  }
});

// ==========================================
// Library API (Protected)
// ==========================================

app.get("/library", requireAuth as any, async (req: AuthenticatedRequest, res) => {
  try {
    const library = await prisma.library.findUnique({
      where: { id: "default" },
    });

    if (!library) {
      return res.json({ items: [] });
    }

    res.json({
      items: JSON.parse(library.items),
    });
  } catch (error) {
    console.error("Failed to fetch library:", error);
    res.status(500).json({ error: "Failed to fetch library" });
  }
});

app.put("/library", requireAuth as any, async (req: AuthenticatedRequest, res) => {
  try {
    const { items } = req.body;

    if (!Array.isArray(items)) {
      return res.status(400).json({ error: "Items must be an array" });
    }

    const library = await prisma.library.upsert({
      where: { id: "default" },
      update: {
        items: JSON.stringify(items),
      },
      create: {
        id: "default",
        items: JSON.stringify(items),
      },
    });

    res.json({
      items: JSON.parse(library.items),
    });
  } catch (error) {
    console.error("Failed to update library:", error);
    res.status(500).json({ error: "Failed to update library" });
  }
});

// ==========================================
// Export/Import API (Protected)
// ==========================================

app.get("/export", requireAdmin as any, async (req: AuthenticatedRequest, res) => {
  try {
    const formatParam =
      typeof req.query.format === "string"
        ? req.query.format.toLowerCase()
        : undefined;
    const extension = formatParam === "db" ? "db" : "sqlite";
    const dbPath = getResolvedDbPath();

    try {
      await fsPromises.access(dbPath);
    } catch {
      return res.status(404).json({ error: "Database file not found" });
    }

    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="excalidash-db-${new Date().toISOString().split("T")[0]
      }.${extension}"`
    );

    const fileStream = fs.createReadStream(dbPath);
    fileStream.pipe(res);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to export database" });
  }
});

app.get("/export/json", requireAuth as any, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.id;

    const drawings = await prisma.drawing.findMany({
      where: { userId },
      include: {
        collection: true,
      },
    });

    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="excalidraw-drawings-${new Date().toISOString().split("T")[0]
      }.zip"`
    );

    const archive = archiver("zip", { zlib: { level: 9 } });

    archive.on("error", (err) => {
      console.error("Archive error:", err);
      res.status(500).json({ error: "Failed to create archive" });
    });

    archive.pipe(res);

    const drawingsByCollection: { [key: string]: any[] } = {};

    drawings.forEach((drawing: any) => {
      const collectionName = drawing.collection?.name || "Unorganized";
      if (!drawingsByCollection[collectionName]) {
        drawingsByCollection[collectionName] = [];
      }

      const drawingData = {
        elements: JSON.parse(drawing.elements),
        appState: JSON.parse(drawing.appState),
        files: JSON.parse(drawing.files || "{}"),
      };

      drawingsByCollection[collectionName].push({
        name: drawing.name,
        data: drawingData,
      });
    });

    Object.entries(drawingsByCollection).forEach(
      ([collectionName, collectionDrawings]) => {
        const folderName = collectionName.replace(/[<>:"/\\|?*]/g, "_");
        collectionDrawings.forEach((drawing, index) => {
          const fileName = `${drawing.name.replace(
            /[<>:"/\\|?*]/g,
            "_"
          )}.excalidraw`;
          const filePath = `${folderName}/${fileName}`;

          archive.append(JSON.stringify(drawing.data, null, 2), {
            name: filePath,
          });
        });
      }
    );

    const readmeContent = `ExcaliDash Export

This archive contains your ExcaliDash drawings organized by collection folders.

Structure:
- Each collection has its own folder
- Each drawing is saved as a .excalidraw file
- Files can be imported back into ExcaliDash

Export Date: ${new Date().toISOString()}
Total Collections: ${Object.keys(drawingsByCollection).length}
Total Drawings: ${drawings.length}

Collections:
${Object.entries(drawingsByCollection)
        .map(([name, drawings]) => `- ${name}: ${drawings.length} drawings`)
        .join("\n")}
`;

    archive.append(readmeContent, { name: "README.txt" });

    await archive.finalize();
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to export drawings" });
  }
});

app.post("/import/sqlite/verify", requireAdmin as any, upload.single("db"), async (req: AuthenticatedRequest, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const stagedPath = req.file.path;
    const isValid = await verifyDatabaseIntegrityAsync(stagedPath);
    await removeFileIfExists(stagedPath);

    if (!isValid) {
      return res.status(400).json({ error: "Invalid database format" });
    }

    res.json({ valid: true, message: "Database file is valid" });
  } catch (error) {
    console.error(error);
    if (req.file) {
      await removeFileIfExists(req.file.path);
    }
    res.status(500).json({ error: "Failed to verify database file" });
  }
});

app.post("/import/sqlite", requireAdmin as any, upload.single("db"), async (req: AuthenticatedRequest, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const originalPath = req.file.path;
    const stagedPath = path.join(
      uploadDir,
      `temp-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    );

    try {
      await moveFile(originalPath, stagedPath);
    } catch (error) {
      console.error("Failed to stage uploaded database", error);
      await removeFileIfExists(originalPath);
      await removeFileIfExists(stagedPath);
      return res.status(500).json({ error: "Failed to stage uploaded file" });
    }

    const isValid = await verifyDatabaseIntegrityAsync(stagedPath);
    if (!isValid) {
      await removeFileIfExists(stagedPath);
      return res
        .status(400)
        .json({ error: "Uploaded database failed integrity check" });
    }

    const dbPath = getResolvedDbPath();
    const backupPath = `${dbPath}.backup`;

    try {
      try {
        await fsPromises.access(dbPath);
        await fsPromises.copyFile(dbPath, backupPath);
      } catch { }

      await moveFile(stagedPath, dbPath);
    } catch (error) {
      console.error("Failed to replace database", error);
      await removeFileIfExists(stagedPath);
      return res.status(500).json({ error: "Failed to replace database" });
    }

    await prisma.$disconnect();
    invalidateDrawingsCache();

    res.json({ success: true, message: "Database imported successfully" });
  } catch (error) {
    console.error(error);
    if (req.file) {
      await removeFileIfExists(req.file.path);
    }
    res.status(500).json({ error: "Failed to import database" });
  }
});

// ==========================================
// Initialization
// ==========================================

const ensureTrashCollection = async () => {
  // Trash is now per-user, so we don't create a global one
  console.log("Trash collections are now per-user");
};

const ensureAppSettings = async () => {
  try {
    const settings = await prisma.appSettings.findUnique({
      where: { id: "default" },
    });
    if (!settings) {
      await prisma.appSettings.create({
        data: { id: "default", signupsDisabled: false },
      });
      console.log("Created default app settings");
    }
  } catch (error) {
    console.error("Failed to ensure app settings:", error);
  }
};

httpServer.listen(PORT, async () => {
  await initializeUploadDir();
  await ensureTrashCollection();
  await ensureAppSettings();
  console.log(`Server running on port ${PORT}`);
});
