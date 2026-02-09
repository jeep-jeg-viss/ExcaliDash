import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { useSession, signOut as authSignOut, type User, type Session } from '../lib/auth-client';
import { API_URL } from '../api';

interface AppSettings {
  signupsDisabled: boolean;
  isFirstTimeSetup: boolean;
}

interface AuthContextType {
  user: User | null;
  session: Session | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  isAdmin: boolean;
  appSettings: AppSettings | null;
  signOut: () => Promise<void>;
  refreshSession: () => void;
  refreshAppSettings: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { data: sessionData, isPending, refetch } = useSession();
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null);
  const [isLoadingSettings, setIsLoadingSettings] = useState(true);

  const fetchAppSettings = useCallback(async () => {
    try {
      const response = await fetch(`${API_URL}/settings/app`);
      if (response.ok) {
        const data = await response.json();
        setAppSettings(data);
      }
    } catch (error) {
      console.error('Failed to fetch app settings:', error);
    } finally {
      setIsLoadingSettings(false);
    }
  }, []);

  useEffect(() => {
    fetchAppSettings();
  }, [fetchAppSettings]);

  const handleSignOut = async () => {
    try {
      await authSignOut();
      // Redirect to login after sign out
      window.location.href = '/login';
    } catch (error) {
      console.error('Sign out failed:', error);
    }
  };

  const user = sessionData?.user ?? null;
  const session = sessionData ?? null;
  const isLoading = isPending || isLoadingSettings;
  const isAuthenticated = !!user;
  const isAdmin = user?.role === 'admin';

  return (
    <AuthContext.Provider
      value={{
        user,
        session,
        isLoading,
        isAuthenticated,
        isAdmin,
        appSettings,
        signOut: handleSignOut,
        refreshSession: refetch,
        refreshAppSettings: fetchAppSettings,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = (): AuthContextType => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
