import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { admin } from "better-auth/plugins";
import { PrismaClient } from "./generated/client";

const prisma = new PrismaClient();

// Determine the base URL for Better-Auth
const getBaseURL = () => {
  if (process.env.BETTER_AUTH_BASE_URL) {
    return process.env.BETTER_AUTH_BASE_URL;
  }
  // Default to localhost for development
  const port = process.env.PORT || 8000;
  return `http://localhost:${port}`;
};

export const auth = betterAuth({
  baseURL: getBaseURL(),
  basePath: "/api/auth",
  database: prismaAdapter(prisma, {
    provider: "sqlite",
  }),
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    maxPasswordLength: 128,
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    updateAge: 60 * 60 * 24, // 1 day - how often to refresh the session
    cookieCache: {
      enabled: true,
      maxAge: 5 * 60, // 5 minutes
    },
  },
  plugins: [
    admin({
      defaultRole: "user",
      adminRoles: ["admin"],
    }),
  ],
  advanced: {
    crossSubDomainCookies: {
      enabled: false,
    },
  },
  trustedOrigins: process.env.FRONTEND_URL
    ? process.env.FRONTEND_URL.split(",").map((url) => url.trim())
    : ["http://localhost:5173", "http://localhost:6767"],
  
  // Hooks for signup logic
  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          // Check if signups are disabled
          const settings = await prisma.appSettings.findUnique({
            where: { id: "default" },
          });
          
          // Count existing users
          const userCount = await prisma.user.count();
          
          // If this is the first user, allow signup and make them admin
          if (userCount === 0) {
            return {
              data: {
                ...user,
                role: "admin",
              },
            };
          }
          
          // If signups are disabled, reject new signups
          if (settings?.signupsDisabled) {
            throw new Error("Signups are currently disabled. Please contact an administrator.");
          }
          
          // Normal user signup
          return {
            data: {
              ...user,
              role: "user",
            },
          };
        },
      },
    },
  },
});

// Helper to get the Prisma client for use elsewhere
export { prisma };

// Type exports for use in other files
export type Session = typeof auth.$Infer.Session;
export type User = typeof auth.$Infer.Session.user;

// Helper function to check if signups are allowed
export const isSignupAllowed = async (): Promise<{ allowed: boolean; reason?: string; isFirstUser: boolean }> => {
  const userCount = await prisma.user.count();
  
  // First user is always allowed
  if (userCount === 0) {
    return { allowed: true, isFirstUser: true };
  }
  
  const settings = await prisma.appSettings.findUnique({
    where: { id: "default" },
  });
  
  if (settings?.signupsDisabled) {
    return { allowed: false, reason: "Signups are currently disabled", isFirstUser: false };
  }
  
  return { allowed: true, isFirstUser: false };
};
