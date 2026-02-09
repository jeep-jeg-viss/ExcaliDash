import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { Layout } from '../components/Layout';
import { api } from '../api';
import { 
  Users, 
  Shield, 
  ShieldOff, 
  Ban, 
  UserCheck, 
  Trash2, 
  UserPlus,
  RefreshCw,
  ChevronLeft,
  ToggleLeft,
  ToggleRight
} from 'lucide-react';
import { ConfirmModal } from '../components/ConfirmModal';
import clsx from 'clsx';

interface AdminUser {
  id: string;
  name: string;
  email: string;
  role: string | null;
  banned: boolean | null;
  banReason: string | null;
  createdAt: string;
  updatedAt: string;
}

interface CreateUserForm {
  name: string;
  email: string;
  password: string;
  role: 'user' | 'admin';
}

export const AdminDashboard: React.FC = () => {
  const navigate = useNavigate();
  const { user: currentUser, appSettings, refreshAppSettings } = useAuth();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createForm, setCreateForm] = useState<CreateUserForm>({
    name: '',
    email: '',
    password: '',
    role: 'user',
  });
  const [createError, setCreateError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [userToDelete, setUserToDelete] = useState<AdminUser | null>(null);
  const [userToBan, setUserToBan] = useState<AdminUser | null>(null);
  const [banReason, setBanReason] = useState('');
  const [isUpdatingSettings, setIsUpdatingSettings] = useState(false);

  const fetchUsers = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      const response = await api.get<AdminUser[]>('/admin/users');
      setUsers(response.data);
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to fetch users');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  const handleToggleSignups = async () => {
    try {
      setIsUpdatingSettings(true);
      await api.put('/settings/app', {
        signupsDisabled: !appSettings?.signupsDisabled,
      });
      await refreshAppSettings();
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to update settings');
    } finally {
      setIsUpdatingSettings(false);
    }
  };

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreateError(null);
    setIsCreating(true);

    try {
      await api.post('/admin/users', createForm);
      setShowCreateModal(false);
      setCreateForm({ name: '', email: '', password: '', role: 'user' });
      fetchUsers();
    } catch (err: any) {
      setCreateError(err.response?.data?.message || 'Failed to create user');
    } finally {
      setIsCreating(false);
    }
  };

  const handleToggleRole = async (userId: string, currentRole: string | null) => {
    try {
      const newRole = currentRole === 'admin' ? 'user' : 'admin';
      await api.put(`/admin/users/${userId}/role`, { role: newRole });
      fetchUsers();
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to update role');
    }
  };

  const handleBanUser = async () => {
    if (!userToBan) return;
    
    try {
      await api.post(`/admin/users/${userToBan.id}/ban`, { reason: banReason });
      setUserToBan(null);
      setBanReason('');
      fetchUsers();
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to ban user');
    }
  };

  const handleUnbanUser = async (userId: string) => {
    try {
      await api.post(`/admin/users/${userId}/unban`);
      fetchUsers();
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to unban user');
    }
  };

  const handleDeleteUser = async () => {
    if (!userToDelete) return;

    try {
      await api.delete(`/admin/users/${userToDelete.id}`);
      setUserToDelete(null);
      fetchUsers();
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to delete user');
    }
  };

  return (
    <Layout
      collections={[]}
      selectedCollectionId="ADMIN"
      onSelectCollection={() => navigate('/')}
      onCreateCollection={() => {}}
      onEditCollection={() => {}}
      onDeleteCollection={() => {}}
    >
      <div className="p-6 max-w-6xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-4">
            <button
              onClick={() => navigate('/')}
              className="p-2 text-slate-600 dark:text-neutral-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-neutral-800 rounded-lg transition-colors"
            >
              <ChevronLeft size={24} />
            </button>
            <div>
              <h1 className="text-2xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
                <Users size={28} />
                Admin Dashboard
              </h1>
              <p className="text-slate-600 dark:text-neutral-400 text-sm mt-1">
                Manage users and application settings
              </p>
            </div>
          </div>
          <button
            onClick={fetchUsers}
            className="p-2 text-slate-600 dark:text-neutral-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-neutral-800 rounded-lg transition-colors"
            title="Refresh"
          >
            <RefreshCw size={20} />
          </button>
        </div>

        {/* Error Alert */}
        {error && (
          <div className="mb-6 p-4 bg-rose-50 dark:bg-rose-900/30 border-2 border-rose-300 dark:border-rose-700 rounded-xl text-rose-700 dark:text-rose-300 text-sm">
            {error}
            <button 
              onClick={() => setError(null)} 
              className="ml-2 font-bold hover:underline"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Settings Section */}
        <div className="bg-white dark:bg-neutral-900 rounded-xl border-2 border-black dark:border-neutral-700 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] dark:shadow-[2px_2px_0px_0px_rgba(255,255,255,0.2)] p-6 mb-6">
          <h2 className="text-lg font-bold text-slate-900 dark:text-white mb-4">
            Application Settings
          </h2>
          <div className="flex items-center justify-between">
            <div>
              <p className="font-bold text-slate-900 dark:text-white">
                Public Signups
              </p>
              <p className="text-sm text-slate-600 dark:text-neutral-400">
                {appSettings?.signupsDisabled 
                  ? 'New users cannot create accounts. Only admins can create users.' 
                  : 'Anyone can create an account.'}
              </p>
            </div>
            <button
              onClick={handleToggleSignups}
              disabled={isUpdatingSettings}
              className={clsx(
                "p-2 rounded-lg transition-colors",
                appSettings?.signupsDisabled
                  ? "text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-900/30"
                  : "text-emerald-600 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/30"
              )}
            >
              {isUpdatingSettings ? (
                <RefreshCw size={24} className="animate-spin" />
              ) : appSettings?.signupsDisabled ? (
                <ToggleLeft size={32} />
              ) : (
                <ToggleRight size={32} />
              )}
            </button>
          </div>
        </div>

        {/* Users Section */}
        <div className="bg-white dark:bg-neutral-900 rounded-xl border-2 border-black dark:border-neutral-700 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] dark:shadow-[2px_2px_0px_0px_rgba(255,255,255,0.2)] p-6">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-lg font-bold text-slate-900 dark:text-white">
              Users ({users.length})
            </h2>
            <button
              onClick={() => setShowCreateModal(true)}
              className="flex items-center gap-2 px-4 py-2 text-sm font-bold text-white bg-indigo-600 hover:bg-indigo-700 border-2 border-black dark:border-neutral-700 rounded-xl shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] dark:shadow-[2px_2px_0px_0px_rgba(255,255,255,0.2)] transition-all hover:-translate-y-0.5"
            >
              <UserPlus size={18} />
              Create User
            </button>
          </div>

          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <div className="animate-spin rounded-full h-8 w-8 border-2 border-indigo-500 border-t-transparent"></div>
            </div>
          ) : (
            <div className="space-y-3">
              {users.map((user) => (
                <div
                  key={user.id}
                  className={clsx(
                    "flex items-center justify-between p-4 rounded-xl border-2 transition-colors",
                    user.banned
                      ? "bg-rose-50 dark:bg-rose-900/20 border-rose-300 dark:border-rose-700"
                      : "bg-slate-50 dark:bg-neutral-800 border-slate-200 dark:border-neutral-700"
                  )}
                >
                  <div className="flex items-center gap-4">
                    {/* Avatar */}
                    <div className={clsx(
                      "w-10 h-10 rounded-full flex items-center justify-center text-white font-bold text-sm",
                      user.role === 'admin' ? "bg-indigo-600" : "bg-slate-500"
                    )}>
                      {user.name?.substring(0, 2).toUpperCase() || 'U'}
                    </div>
                    
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-slate-900 dark:text-white">
                          {user.name}
                        </span>
                        {user.role === 'admin' && (
                          <span className="px-2 py-0.5 text-xs font-bold bg-indigo-100 dark:bg-indigo-900/50 text-indigo-700 dark:text-indigo-300 rounded-full">
                            Admin
                          </span>
                        )}
                        {user.banned && (
                          <span className="px-2 py-0.5 text-xs font-bold bg-rose-100 dark:bg-rose-900/50 text-rose-700 dark:text-rose-300 rounded-full">
                            Banned
                          </span>
                        )}
                        {user.id === currentUser?.id && (
                          <span className="px-2 py-0.5 text-xs font-bold bg-emerald-100 dark:bg-emerald-900/50 text-emerald-700 dark:text-emerald-300 rounded-full">
                            You
                          </span>
                        )}
                      </div>
                      <p className="text-sm text-slate-600 dark:text-neutral-400">
                        {user.email}
                      </p>
                      {user.banned && user.banReason && (
                        <p className="text-xs text-rose-600 dark:text-rose-400 mt-1">
                          Ban reason: {user.banReason}
                        </p>
                      )}
                    </div>
                  </div>

                  {/* Actions */}
                  {user.id !== currentUser?.id && (
                    <div className="flex items-center gap-2">
                      {/* Toggle Role */}
                      <button
                        onClick={() => handleToggleRole(user.id, user.role)}
                        className={clsx(
                          "p-2 rounded-lg transition-colors",
                          user.role === 'admin'
                            ? "text-amber-600 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-900/30"
                            : "text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/30"
                        )}
                        title={user.role === 'admin' ? 'Remove admin' : 'Make admin'}
                      >
                        {user.role === 'admin' ? <ShieldOff size={18} /> : <Shield size={18} />}
                      </button>

                      {/* Ban/Unban */}
                      {user.banned ? (
                        <button
                          onClick={() => handleUnbanUser(user.id)}
                          className="p-2 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/30 rounded-lg transition-colors"
                          title="Unban user"
                        >
                          <UserCheck size={18} />
                        </button>
                      ) : (
                        <button
                          onClick={() => setUserToBan(user)}
                          className="p-2 text-amber-600 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-900/30 rounded-lg transition-colors"
                          title="Ban user"
                        >
                          <Ban size={18} />
                        </button>
                      )}

                      {/* Delete */}
                      <button
                        onClick={() => setUserToDelete(user)}
                        className="p-2 text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-900/30 rounded-lg transition-colors"
                        title="Delete user"
                      >
                        <Trash2 size={18} />
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Create User Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white dark:bg-neutral-900 rounded-2xl border-2 border-black dark:border-neutral-700 shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] dark:shadow-[4px_4px_0px_0px_rgba(255,255,255,0.2)] p-6 w-full max-w-md m-4">
            <h3 className="text-lg font-bold text-slate-900 dark:text-white mb-4">
              Create New User
            </h3>

            {createError && (
              <div className="mb-4 p-3 bg-rose-50 dark:bg-rose-900/30 border-2 border-rose-300 dark:border-rose-700 rounded-xl text-rose-700 dark:text-rose-300 text-sm">
                {createError}
              </div>
            )}

            <form onSubmit={handleCreateUser} className="space-y-4">
              <div>
                <label className="block text-sm font-bold text-slate-700 dark:text-neutral-300 mb-1">
                  Name
                </label>
                <input
                  type="text"
                  value={createForm.name}
                  onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })}
                  required
                  className="w-full px-3 py-2 text-sm bg-white dark:bg-neutral-800 border-2 border-black dark:border-neutral-700 rounded-xl shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] dark:shadow-[2px_2px_0px_0px_rgba(255,255,255,0.2)] outline-none focus:ring-2 focus:ring-indigo-500 font-medium text-slate-900 dark:text-white"
                />
              </div>

              <div>
                <label className="block text-sm font-bold text-slate-700 dark:text-neutral-300 mb-1">
                  Email
                </label>
                <input
                  type="email"
                  value={createForm.email}
                  onChange={(e) => setCreateForm({ ...createForm, email: e.target.value })}
                  required
                  className="w-full px-3 py-2 text-sm bg-white dark:bg-neutral-800 border-2 border-black dark:border-neutral-700 rounded-xl shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] dark:shadow-[2px_2px_0px_0px_rgba(255,255,255,0.2)] outline-none focus:ring-2 focus:ring-indigo-500 font-medium text-slate-900 dark:text-white"
                />
              </div>

              <div>
                <label className="block text-sm font-bold text-slate-700 dark:text-neutral-300 mb-1">
                  Password
                </label>
                <input
                  type="password"
                  value={createForm.password}
                  onChange={(e) => setCreateForm({ ...createForm, password: e.target.value })}
                  required
                  minLength={8}
                  className="w-full px-3 py-2 text-sm bg-white dark:bg-neutral-800 border-2 border-black dark:border-neutral-700 rounded-xl shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] dark:shadow-[2px_2px_0px_0px_rgba(255,255,255,0.2)] outline-none focus:ring-2 focus:ring-indigo-500 font-medium text-slate-900 dark:text-white"
                />
              </div>

              <div>
                <label className="block text-sm font-bold text-slate-700 dark:text-neutral-300 mb-1">
                  Role
                </label>
                <select
                  value={createForm.role}
                  onChange={(e) => setCreateForm({ ...createForm, role: e.target.value as 'user' | 'admin' })}
                  className="w-full px-3 py-2 text-sm bg-white dark:bg-neutral-800 border-2 border-black dark:border-neutral-700 rounded-xl shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] dark:shadow-[2px_2px_0px_0px_rgba(255,255,255,0.2)] outline-none focus:ring-2 focus:ring-indigo-500 font-medium text-slate-900 dark:text-white"
                >
                  <option value="user">User</option>
                  <option value="admin">Admin</option>
                </select>
              </div>

              <div className="flex gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => {
                    setShowCreateModal(false);
                    setCreateForm({ name: '', email: '', password: '', role: 'user' });
                    setCreateError(null);
                  }}
                  className="flex-1 px-4 py-2 text-sm font-bold text-slate-700 dark:text-neutral-300 bg-slate-100 dark:bg-neutral-800 hover:bg-slate-200 dark:hover:bg-neutral-700 border-2 border-black dark:border-neutral-700 rounded-xl shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] dark:shadow-[2px_2px_0px_0px_rgba(255,255,255,0.2)] transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isCreating}
                  className="flex-1 px-4 py-2 text-sm font-bold text-white bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 border-2 border-black dark:border-neutral-700 rounded-xl shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] dark:shadow-[2px_2px_0px_0px_rgba(255,255,255,0.2)] transition-colors disabled:cursor-not-allowed"
                >
                  {isCreating ? 'Creating...' : 'Create User'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Ban User Modal */}
      {userToBan && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white dark:bg-neutral-900 rounded-2xl border-2 border-black dark:border-neutral-700 shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] dark:shadow-[4px_4px_0px_0px_rgba(255,255,255,0.2)] p-6 w-full max-w-md m-4">
            <h3 className="text-lg font-bold text-slate-900 dark:text-white mb-2">
              Ban User
            </h3>
            <p className="text-sm text-slate-600 dark:text-neutral-400 mb-4">
              Are you sure you want to ban <strong>{userToBan.name}</strong>? They will be logged out and unable to access their account.
            </p>

            <div className="mb-4">
              <label className="block text-sm font-bold text-slate-700 dark:text-neutral-300 mb-1">
                Reason (optional)
              </label>
              <input
                type="text"
                value={banReason}
                onChange={(e) => setBanReason(e.target.value)}
                placeholder="Enter ban reason..."
                className="w-full px-3 py-2 text-sm bg-white dark:bg-neutral-800 border-2 border-black dark:border-neutral-700 rounded-xl shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] dark:shadow-[2px_2px_0px_0px_rgba(255,255,255,0.2)] outline-none focus:ring-2 focus:ring-indigo-500 font-medium text-slate-900 dark:text-white"
              />
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => {
                  setUserToBan(null);
                  setBanReason('');
                }}
                className="flex-1 px-4 py-2 text-sm font-bold text-slate-700 dark:text-neutral-300 bg-slate-100 dark:bg-neutral-800 hover:bg-slate-200 dark:hover:bg-neutral-700 border-2 border-black dark:border-neutral-700 rounded-xl shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] dark:shadow-[2px_2px_0px_0px_rgba(255,255,255,0.2)] transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleBanUser}
                className="flex-1 px-4 py-2 text-sm font-bold text-white bg-rose-600 hover:bg-rose-700 border-2 border-black dark:border-neutral-700 rounded-xl shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] dark:shadow-[2px_2px_0px_0px_rgba(255,255,255,0.2)] transition-colors"
              >
                Ban User
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete User Confirm Modal */}
      <ConfirmModal
        isOpen={!!userToDelete}
        title="Delete User"
        message={`Are you sure you want to delete ${userToDelete?.name}? This action cannot be undone. All their drawings and collections will also be deleted.`}
        confirmText="Delete User"
        onConfirm={handleDeleteUser}
        onCancel={() => setUserToDelete(null)}
      />
    </Layout>
  );
};
