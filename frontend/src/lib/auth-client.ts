import { createAuthClient } from "better-auth/react";
import { adminClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  // Use the current origin so requests stay same-origin.
  // Vite (dev) proxies /api/auth/* → http://localhost:8000/api/auth/*
  // Nginx (prod) proxies /api/auth/* → backend:8000/api/auth/*
  baseURL: window.location.origin,
  basePath: "/api/auth",
  plugins: [adminClient()],
});

// Export commonly used hooks and functions
export const {
  signIn,
  signUp,
  signOut,
  useSession,
  getSession,
} = authClient;

// Type exports
export type Session = typeof authClient.$Infer.Session;
export type User = Session["user"];
