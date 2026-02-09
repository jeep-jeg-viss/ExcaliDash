export interface DrawingSummary {
  id: string;
  name: string;
  collectionId: string | null;
  updatedAt: number;
  createdAt: number;
  version: number;
  preview?: string | null;
}

export interface Drawing extends DrawingSummary {
  elements: any[];
  appState: any;
  files: Record<string, any> | null;
}

export interface Collection {
  id: string;
  name: string;
  createdAt: number;
}

export interface User {
  id: string;
  name: string;
  email: string;
  role: string | null;
  banned: boolean | null;
  banReason?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface AppSettings {
  signupsDisabled: boolean;
  isFirstTimeSetup: boolean;
}

export interface ShareLink {
  id: string;
  token: string;
  permission: 'view' | 'edit';
  expiresAt: string | null;
  isActive: boolean;
  createdAt: string;
}

export interface SharedDrawing {
  id: string;
  name: string;
  elements: any[];
  appState: any;
  files: Record<string, any> | null;
  permission: 'view' | 'edit';
  version: number;
}
