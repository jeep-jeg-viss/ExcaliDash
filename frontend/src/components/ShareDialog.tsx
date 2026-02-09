import React, { useState, useEffect, useCallback } from 'react';
import { X, Link2, Copy, Check, Trash2, ToggleLeft, ToggleRight, Eye, Pencil, Clock, Loader2, Plus } from 'lucide-react';
import * as api from '../api';
import type { ShareLink } from '../types';

interface ShareDialogProps {
  drawingId: string;
  drawingName: string;
  isOpen: boolean;
  onClose: () => void;
}

const EXPIRY_OPTIONS = [
  { label: 'Never', value: null },
  { label: '1 hour', value: 1 },
  { label: '24 hours', value: 24 },
  { label: '7 days', value: 168 },
  { label: '30 days', value: 720 },
];

const formatExpiry = (expiresAt: string | null): string => {
  if (!expiresAt) return 'Never';
  const date = new Date(expiresAt);
  if (date < new Date()) return 'Expired';
  const diff = date.getTime() - Date.now();
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h remaining`;
  if (hours > 0) return `${hours}h remaining`;
  const minutes = Math.floor(diff / (1000 * 60));
  return `${minutes}m remaining`;
};

export const ShareDialog: React.FC<ShareDialogProps> = ({ drawingId, drawingName, isOpen, onClose }) => {
  const [links, setLinks] = useState<ShareLink[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // New link form
  const [newPermission, setNewPermission] = useState<'view' | 'edit'>('view');
  const [newExpiry, setNewExpiry] = useState<number | null>(null);

  const fetchLinks = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await api.getShareLinks(drawingId);
      setLinks(data);
    } catch (err) {
      console.error('Failed to fetch share links:', err);
    } finally {
      setIsLoading(false);
    }
  }, [drawingId]);

  useEffect(() => {
    if (isOpen) {
      fetchLinks();
    }
  }, [isOpen, fetchLinks]);

  const handleCreate = async () => {
    setIsCreating(true);
    try {
      const link = await api.createShareLink(drawingId, {
        permission: newPermission,
        expiresIn: newExpiry,
      });
      setLinks(prev => [link, ...prev]);
      // Auto-copy
      const url = `${window.location.origin}/shared/${link.token}`;
      await navigator.clipboard.writeText(url);
      setCopiedId(link.id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch (err) {
      console.error('Failed to create share link:', err);
    } finally {
      setIsCreating(false);
    }
  };

  const handleToggleActive = async (link: ShareLink) => {
    try {
      const updated = await api.updateShareLink(link.id, { isActive: !link.isActive });
      setLinks(prev => prev.map(l => l.id === link.id ? updated : l));
    } catch (err) {
      console.error('Failed to toggle share link:', err);
    }
  };

  const handleDelete = async (linkId: string) => {
    try {
      await api.deleteShareLink(linkId);
      setLinks(prev => prev.filter(l => l.id !== linkId));
    } catch (err) {
      console.error('Failed to delete share link:', err);
    }
  };

  const handleCopy = async (token: string, linkId: string) => {
    const url = `${window.location.origin}/shared/${token}`;
    await navigator.clipboard.writeText(url);
    setCopiedId(linkId);
    setTimeout(() => setCopiedId(null), 2000);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-white dark:bg-neutral-900 rounded-2xl border-2 border-black dark:border-neutral-700 shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] dark:shadow-[4px_4px_0px_0px_rgba(255,255,255,0.2)] w-full max-w-lg mx-4 max-h-[80vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-gray-200 dark:border-neutral-700">
          <div className="flex items-center gap-2">
            <Link2 size={20} className="text-indigo-500" />
            <h2 className="text-lg font-bold text-slate-900 dark:text-white">Share Drawing</h2>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 dark:hover:bg-neutral-800 rounded-lg transition-colors">
            <X size={20} className="text-gray-500" />
          </button>
        </div>

        {/* Create new link */}
        <div className="p-5 border-b border-gray-200 dark:border-neutral-700">
          <p className="text-sm text-gray-500 dark:text-neutral-400 mb-3">
            Create a share link for <span className="font-medium text-gray-700 dark:text-neutral-200">{drawingName}</span>
          </p>
          <div className="flex flex-wrap items-center gap-3">
            {/* Permission toggle */}
            <div className="flex items-center gap-2">
              <button
                onClick={() => setNewPermission('view')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                  newPermission === 'view'
                    ? 'bg-indigo-100 dark:bg-indigo-900/50 text-indigo-700 dark:text-indigo-300'
                    : 'bg-gray-100 dark:bg-neutral-800 text-gray-600 dark:text-neutral-400 hover:bg-gray-200 dark:hover:bg-neutral-700'
                }`}
              >
                <Eye size={14} /> View
              </button>
              <button
                onClick={() => setNewPermission('edit')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                  newPermission === 'edit'
                    ? 'bg-amber-100 dark:bg-amber-900/50 text-amber-700 dark:text-amber-300'
                    : 'bg-gray-100 dark:bg-neutral-800 text-gray-600 dark:text-neutral-400 hover:bg-gray-200 dark:hover:bg-neutral-700'
                }`}
              >
                <Pencil size={14} /> Edit
              </button>
            </div>

            {/* Expiry select */}
            <div className="flex items-center gap-1.5">
              <Clock size={14} className="text-gray-400" />
              <select
                value={newExpiry === null ? '' : String(newExpiry)}
                onChange={e => setNewExpiry(e.target.value === '' ? null : Number(e.target.value))}
                className="text-sm bg-gray-100 dark:bg-neutral-800 border-0 rounded-lg px-2 py-1.5 text-gray-700 dark:text-neutral-300 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                {EXPIRY_OPTIONS.map(opt => (
                  <option key={String(opt.value)} value={opt.value === null ? '' : String(opt.value)}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Create button */}
            <button
              onClick={handleCreate}
              disabled={isCreating}
              className="flex items-center gap-1.5 px-4 py-1.5 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white rounded-lg text-sm font-medium transition-colors ml-auto"
            >
              {isCreating ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
              Create Link
            </button>
          </div>
        </div>

        {/* Links list */}
        <div className="flex-1 overflow-y-auto p-5">
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 size={24} className="animate-spin text-gray-400" />
            </div>
          ) : links.length === 0 ? (
            <div className="text-center py-8 text-gray-400 dark:text-neutral-500">
              <Link2 size={32} className="mx-auto mb-2 opacity-50" />
              <p className="text-sm">No share links yet</p>
            </div>
          ) : (
            <div className="space-y-3">
              {links.map(link => {
                const isExpired = link.expiresAt && new Date(link.expiresAt) < new Date();
                return (
                  <div
                    key={link.id}
                    className={`p-3 rounded-xl border-2 transition-colors ${
                      !link.isActive || isExpired
                        ? 'border-gray-200 dark:border-neutral-700 bg-gray-50 dark:bg-neutral-800/50 opacity-60'
                        : 'border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-800'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        {/* Permission badge */}
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium ${
                          link.permission === 'edit'
                            ? 'bg-amber-100 dark:bg-amber-900/50 text-amber-700 dark:text-amber-300'
                            : 'bg-indigo-100 dark:bg-indigo-900/50 text-indigo-700 dark:text-indigo-300'
                        }`}>
                          {link.permission === 'edit' ? <Pencil size={10} /> : <Eye size={10} />}
                          {link.permission}
                        </span>

                        {/* Expiry info */}
                        <span className={`text-xs ${isExpired ? 'text-red-500' : 'text-gray-400 dark:text-neutral-500'}`}>
                          {isExpired ? 'Expired' : formatExpiry(link.expiresAt)}
                        </span>

                        {!link.isActive && (
                          <span className="text-xs text-red-500 font-medium">Disabled</span>
                        )}
                      </div>

                      <div className="flex items-center gap-1">
                        {/* Copy */}
                        <button
                          onClick={() => handleCopy(link.token, link.id)}
                          className="p-1.5 hover:bg-gray-100 dark:hover:bg-neutral-700 rounded-lg transition-colors"
                          title="Copy link"
                        >
                          {copiedId === link.id ? (
                            <Check size={14} className="text-green-500" />
                          ) : (
                            <Copy size={14} className="text-gray-400" />
                          )}
                        </button>

                        {/* Toggle active */}
                        <button
                          onClick={() => handleToggleActive(link)}
                          className="p-1.5 hover:bg-gray-100 dark:hover:bg-neutral-700 rounded-lg transition-colors"
                          title={link.isActive ? 'Disable link' : 'Enable link'}
                        >
                          {link.isActive ? (
                            <ToggleRight size={14} className="text-green-500" />
                          ) : (
                            <ToggleLeft size={14} className="text-gray-400" />
                          )}
                        </button>

                        {/* Delete */}
                        <button
                          onClick={() => handleDelete(link.id)}
                          className="p-1.5 hover:bg-red-50 dark:hover:bg-red-900/30 rounded-lg transition-colors"
                          title="Delete link"
                        >
                          <Trash2 size={14} className="text-red-400" />
                        </button>
                      </div>
                    </div>

                    {/* URL display */}
                    <div className="mt-2 px-2 py-1.5 bg-gray-50 dark:bg-neutral-900 rounded-lg">
                      <code className="text-xs text-gray-500 dark:text-neutral-400 break-all">
                        {window.location.origin}/shared/{link.token}
                      </code>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
