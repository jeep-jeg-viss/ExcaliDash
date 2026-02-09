import React, { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { signIn } from '../lib/auth-client';
import { useAuth } from '../context/AuthContext';
import { Logo } from '../components/Logo';
import { Eye, EyeOff, LogIn } from 'lucide-react';

export const Login: React.FC = () => {
  const navigate = useNavigate();
  const { isAuthenticated, isLoading, appSettings } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Redirect if already authenticated
  useEffect(() => {
    if (!isLoading && isAuthenticated) {
      navigate('/');
    }
  }, [isAuthenticated, isLoading, navigate]);

  // Redirect to register if first time setup
  useEffect(() => {
    if (!isLoading && appSettings?.isFirstTimeSetup) {
      navigate('/register');
    }
  }, [appSettings, isLoading, navigate]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      const result = await signIn.email({
        email,
        password,
      });

      if (result.error) {
        setError(result.error.message || 'Login failed. Please check your credentials.');
      } else {
        // Successful login - redirect to dashboard
        navigate('/');
      }
    } catch (err: any) {
      setError(err.message || 'An unexpected error occurred');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-100 dark:bg-neutral-950">
        <div className="animate-spin rounded-full h-12 w-12 border-4 border-indigo-500 border-t-transparent"></div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-100 dark:bg-neutral-950 p-4">
      <div className="w-full max-w-md">
        <div className="bg-white dark:bg-neutral-900 rounded-2xl border-2 border-black dark:border-neutral-700 shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] dark:shadow-[4px_4px_0px_0px_rgba(255,255,255,0.2)] p-8">
          {/* Logo */}
          <div className="flex flex-col items-center mb-8">
            <div className="flex items-center gap-3 mb-2">
              <Logo className="w-12 h-12" />
              <h1 className="text-3xl text-slate-900 dark:text-white" style={{ fontFamily: 'Excalifont' }}>
                ExcaliDash
              </h1>
            </div>
            <p className="text-slate-600 dark:text-neutral-400 text-sm">
              Sign in to your account
            </p>
          </div>

          {/* Error Message */}
          {error && (
            <div className="mb-6 p-4 bg-rose-50 dark:bg-rose-900/30 border-2 border-rose-300 dark:border-rose-700 rounded-xl text-rose-700 dark:text-rose-300 text-sm">
              {error}
            </div>
          )}

          {/* Login Form */}
          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label htmlFor="email" className="block text-sm font-bold text-slate-700 dark:text-neutral-300 mb-2">
                Email
              </label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
                className="w-full px-4 py-3 text-sm bg-white dark:bg-neutral-800 border-2 border-black dark:border-neutral-700 rounded-xl shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] dark:shadow-[2px_2px_0px_0px_rgba(255,255,255,0.2)] outline-none focus:ring-2 focus:ring-indigo-500 dark:focus:ring-neutral-500 font-medium text-slate-900 dark:text-white placeholder:text-slate-400 dark:placeholder:text-neutral-500"
                placeholder="you@example.com"
              />
            </div>

            <div>
              <label htmlFor="password" className="block text-sm font-bold text-slate-700 dark:text-neutral-300 mb-2">
                Password
              </label>
              <div className="relative">
                <input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoComplete="current-password"
                  className="w-full px-4 py-3 pr-12 text-sm bg-white dark:bg-neutral-800 border-2 border-black dark:border-neutral-700 rounded-xl shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] dark:shadow-[2px_2px_0px_0px_rgba(255,255,255,0.2)] outline-none focus:ring-2 focus:ring-indigo-500 dark:focus:ring-neutral-500 font-medium text-slate-900 dark:text-white placeholder:text-slate-400 dark:placeholder:text-neutral-500"
                  placeholder="Enter your password"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:text-neutral-500 dark:hover:text-neutral-300"
                >
                  {showPassword ? <EyeOff size={20} /> : <Eye size={20} />}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={isSubmitting}
              className="w-full flex items-center justify-center gap-2 px-4 py-3 text-sm font-bold text-white bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 border-2 border-black dark:border-neutral-700 rounded-xl shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] dark:shadow-[2px_2px_0px_0px_rgba(255,255,255,0.2)] hover:shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] dark:hover:shadow-[4px_4px_0px_0px_rgba(255,255,255,0.2)] transition-all hover:-translate-y-0.5 disabled:hover:translate-y-0 disabled:cursor-not-allowed"
            >
              {isSubmitting ? (
                <div className="animate-spin rounded-full h-5 w-5 border-2 border-white border-t-transparent"></div>
              ) : (
                <>
                  <LogIn size={18} />
                  Sign In
                </>
              )}
            </button>
          </form>

          {/* Register Link */}
          {!appSettings?.signupsDisabled && (
            <p className="mt-6 text-center text-sm text-slate-600 dark:text-neutral-400">
              Don't have an account?{' '}
              <Link
                to="/register"
                className="font-bold text-indigo-600 hover:text-indigo-700 dark:text-indigo-400 dark:hover:text-indigo-300"
              >
                Create one
              </Link>
            </p>
          )}
        </div>
      </div>
    </div>
  );
};
