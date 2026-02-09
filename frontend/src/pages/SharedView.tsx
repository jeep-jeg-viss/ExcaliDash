import React, { useCallback, useEffect, useState, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { Eye, Pencil, Loader2, AlertTriangle } from 'lucide-react';
import { Excalidraw } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import debounce from 'lodash/debounce';
import throttle from 'lodash/throttle';
import { Toaster, toast } from 'sonner';
import { io, Socket } from 'socket.io-client';
import { useTheme } from '../context/ThemeContext';
import { getUserIdentity } from '../utils/identity';
import { reconcileElements } from '../utils/sync';
import type { UserIdentity } from '../utils/identity';
import * as api from '../api';
import type { SharedDrawing } from '../types';
import { Logo } from '../components/Logo';

interface Peer extends UserIdentity {
  isActive: boolean;
}

interface ElementVersionInfo {
  version: number;
  versionNonce: number;
}

export const SharedView: React.FC = () => {
  const { token } = useParams<{ token: string }>();
  const { theme } = useTheme();

  const [drawing, setDrawing] = useState<SharedDrawing | null>(null);
  const [initialData, setInitialData] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [me] = useState(getUserIdentity());

  const excalidrawAPI = useRef<any>(null);
  const socketRef = useRef<Socket | null>(null);
  const isSyncing = useRef(false);
  const latestElementsRef = useRef<readonly any[]>([]);
  const elementVersionMap = useRef(new Map<string, ElementVersionInfo>());
  const cursorBuffer = useRef(new Map<string, any>());
  const elementUpdateBuffer = useRef<any[]>([]);
  const animationFrameId = useRef(0);
  const lastCursorEmit = useRef(0);

  const setExcalidrawAPI = useCallback((api: any) => {
    excalidrawAPI.current = api;
    setIsReady(true);
  }, []);

  const recordElementVersion = useCallback((element: any) => {
    elementVersionMap.current.set(element.id, {
      version: element.version ?? 0,
      versionNonce: element.versionNonce ?? 0,
    });
  }, []);

  const hasElementChanged = useCallback((element: any) => {
    const previous = elementVersionMap.current.get(element.id);
    if (!previous) {
      recordElementVersion(element);
      return true;
    }
    return previous.version !== (element.version ?? 0) || previous.versionNonce !== (element.versionNonce ?? 0);
  }, [recordElementVersion]);

  // Debounced save to persist edits via API
  const debouncedSave = useRef(
    debounce(async (elements: any[], appState: any) => {
      if (!token || !drawing || drawing.permission !== 'edit') return;
      try {
        await api.updateSharedDrawing(token, {
          elements: elements.filter((e: any) => !e.isDeleted),
          appState: {
            viewBackgroundColor: appState.viewBackgroundColor,
            currentItemFontFamily: appState.currentItemFontFamily,
            gridSize: appState.gridSize,
          },
        });
      } catch (err) {
        console.error('[SharedView] Save failed:', err);
        toast.error('Failed to save changes');
      }
    }, 1500)
  ).current;

  // Broadcast changed elements via socket
  const broadcastChanges = useCallback(
    throttle((elements: readonly any[]) => {
      if (!socketRef.current || !drawing) return;

      const changes: any[] = [];
      elements.forEach((el) => {
        if (hasElementChanged(el)) {
          changes.push(el);
          recordElementVersion(el);
        }
      });

      if (changes.length > 0) {
        socketRef.current.emit('element-update', {
          drawingId: drawing.id,
          elements: changes,
          userId: me.id,
        });
      }
    }, 50, { leading: true, trailing: true }),
    [drawing, hasElementChanged, recordElementVersion, me.id]
  );

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      debouncedSave.cancel();
      broadcastChanges.cancel();
    };
  }, [debouncedSave, broadcastChanges]);

  // Load drawing data
  useEffect(() => {
    if (!token) return;

    const load = async () => {
      setIsLoading(true);
      try {
        const data = await api.getSharedDrawing(token);
        setDrawing(data);

        const elements = data.elements || [];
        elements.forEach((el: any) => recordElementVersion(el));
        latestElementsRef.current = elements;

        setInitialData({
          elements,
          appState: {
            ...(data.appState || {}),
            collaborators: new Map(),
          },
          files: data.files || {},
        });
      } catch (err: any) {
        const msg = err.response?.data?.error || 'Failed to load shared drawing';
        setError(msg);
      } finally {
        setIsLoading(false);
      }
    };

    load();
  }, [token, recordElementVersion]);

  // Socket.io real-time collaboration
  useEffect(() => {
    if (!drawing || !isReady) return;

    // Use window.location.origin when API is proxied (relative path or undefined)
    const apiUrl = import.meta.env.VITE_API_URL || '/api';
    const socketUrl = apiUrl.startsWith('http')
      ? apiUrl
      : window.location.origin;

    const socket = io(socketUrl, {
      path: '/socket.io',
      transports: ['websocket', 'polling'],
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      console.log('[SharedView] Socket connected:', socket.id, 'joining room for drawing:', drawing.id);
      socket.emit('join-room', { drawingId: drawing.id, user: me });
    });

    socket.on('connect_error', (err) => {
      console.error('[SharedView] Socket connection error:', err.message);
    });

    // If already connected (reconnect), join immediately
    if (socket.connected) {
      socket.emit('join-room', { drawingId: drawing.id, user: me });
    }

    // Unified render loop: apply buffered element updates + cursor updates per frame
    const renderLoop = () => {
      if (!excalidrawAPI.current) {
        animationFrameId.current = requestAnimationFrame(renderLoop);
        return;
      }

      const sceneUpdate: any = {};

      // Apply buffered remote element updates
      if (elementUpdateBuffer.current.length > 0) {
        isSyncing.current = true;

        const currentAppState = excalidrawAPI.current.getAppState();
        const mySelectedIds = currentAppState.selectedElementIds || {};

        // Deduplicate: keep latest version of each element across all buffered messages
        const dedupMap = new Map<string, any>();
        elementUpdateBuffer.current.forEach((el: any) => {
          const existing = dedupMap.get(el.id);
          if (!existing || (el.version ?? 0) > (existing.version ?? 0)) {
            dedupMap.set(el.id, el);
          }
        });
        elementUpdateBuffer.current = [];

        const remoteElements = Array.from(dedupMap.values()).filter(
          (el: any) => !mySelectedIds[el.id]
        );

        if (remoteElements.length > 0) {
          const localElements = excalidrawAPI.current.getSceneElementsIncludingDeleted();
          const mergedElements = reconcileElements(localElements, remoteElements);

          remoteElements.forEach((el: any) => recordElementVersion(el));

          sceneUpdate.elements = mergedElements;
          latestElementsRef.current = mergedElements;
        }
      }

      // Apply buffered cursor updates
      if (cursorBuffer.current.size > 0) {
        const collaborators = new Map(excalidrawAPI.current.getAppState().collaborators || []);
        cursorBuffer.current.forEach((data, userId) => {
          collaborators.set(userId, data);
        });
        cursorBuffer.current.clear();
        sceneUpdate.collaborators = collaborators;
      }

      // Single updateScene call per frame
      if (Object.keys(sceneUpdate).length > 0) {
        excalidrawAPI.current.updateScene(sceneUpdate);
      }

      // Reset isSyncing after React processes the update (next frame)
      if (isSyncing.current) {
        requestAnimationFrame(() => {
          isSyncing.current = false;
        });
      }

      animationFrameId.current = requestAnimationFrame(renderLoop);
    };
    renderLoop();

    socket.on('presence-update', (users: Peer[]) => {
      setPeers(users.filter(u => u.id !== me.id));

      if (excalidrawAPI.current) {
        const collaborators = new Map(excalidrawAPI.current.getAppState().collaborators || []);
        users.forEach(user => {
          if (!user.isActive && user.id !== me.id) {
            collaborators.delete(user.id);
          }
        });
        excalidrawAPI.current.updateScene({ collaborators });
      }
    });

    socket.on('cursor-move', (data: any) => {
      cursorBuffer.current.set(data.userId, {
        pointer: data.pointer,
        button: data.button || 'up',
        selectedElementIds: data.selectedElementIds || {},
        username: data.username,
        avatarUrl: data.avatarUrl,
        color: { background: data.color, stroke: data.color },
        id: data.userId,
      });
    });

    socket.on('element-update', ({ elements }: { elements: any[] }) => {
      // Buffer incoming elements — applied in the rAF render loop
      elementUpdateBuffer.current.push(...elements);
    });

    const handleActivity = (isActive: boolean) => {
      socket.emit('user-activity', { drawingId: drawing.id, isActive });
    };

    const onFocus = () => handleActivity(true);
    const onBlur = () => handleActivity(false);
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);

    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
      socket.off('connect');
      socket.off('connect_error');
      socket.off('presence-update');
      socket.off('cursor-move');
      socket.off('element-update');
      socket.disconnect();
      cancelAnimationFrame(animationFrameId.current);
    };
  }, [drawing, me, isReady, recordElementVersion]);

  const onPointerUpdate = useCallback((payload: any) => {
    if (!drawing) return;
    const now = Date.now();
    if (now - lastCursorEmit.current > 33 && socketRef.current) {
      socketRef.current.emit('cursor-move', {
        pointer: payload.pointer,
        button: payload.button,
        username: me.name,
        userId: me.id,
        drawingId: drawing.id,
        color: me.color,
      });
      lastCursorEmit.current = now;
    }
  }, [drawing, me]);

  const handleCanvasChange = useCallback((elements: readonly any[], appState: any) => {
    if (!drawing) return;
    if (isSyncing.current) return;

    // Use getSceneElementsIncludingDeleted for proper sync of deletions
    const allElements = excalidrawAPI.current
      ? excalidrawAPI.current.getSceneElementsIncludingDeleted()
      : elements;

    latestElementsRef.current = allElements;

    if (drawing.permission === 'edit') {
      debouncedSave([...allElements], appState);
      broadcastChanges(allElements);
    }
  }, [drawing, debouncedSave, broadcastChanges]);

  const UIOptions = {
    canvasActions: {
      export: { saveFileToDisk: true },
      loadScene: false,
      saveToActiveFile: false,
      saveAsImage: true,
    },
  };

  if (isLoading) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-slate-100 dark:bg-neutral-950 gap-3">
        <Loader2 size={32} className="animate-spin text-indigo-500" />
        <span className="text-sm text-gray-500 dark:text-neutral-400">Loading shared drawing...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-slate-100 dark:bg-neutral-950 gap-4">
        <div className="bg-white dark:bg-neutral-900 rounded-2xl border-2 border-black dark:border-neutral-700 shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] dark:shadow-[4px_4px_0px_0px_rgba(255,255,255,0.2)] p-8 max-w-md text-center">
          <AlertTriangle size={40} className="mx-auto mb-4 text-amber-500" />
          <h2 className="text-lg font-bold text-slate-900 dark:text-white mb-2">Cannot Access Drawing</h2>
          <p className="text-sm text-gray-600 dark:text-neutral-400">{error}</p>
        </div>
      </div>
    );
  }

  if (!drawing || !initialData) return null;

  return (
    <div className="h-screen flex flex-col bg-white dark:bg-neutral-950">
      {/* Header */}
      <header className="h-14 border-b border-gray-200 dark:border-neutral-800 flex items-center justify-between px-4 bg-white dark:bg-neutral-900 z-50 shrink-0">
        <div className="flex items-center gap-3">
          <Logo className="w-7 h-7" />
          <h1 className="font-medium text-gray-900 dark:text-white px-2 py-1">
            {drawing.name}
          </h1>
        </div>

        <div className="flex items-center gap-2">
          <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-medium ${
            drawing.permission === 'edit'
              ? 'bg-amber-100 dark:bg-amber-900/50 text-amber-700 dark:text-amber-300'
              : 'bg-indigo-100 dark:bg-indigo-900/50 text-indigo-700 dark:text-indigo-300'
          }`}>
            {drawing.permission === 'edit' ? <Pencil size={12} /> : <Eye size={12} />}
            {drawing.permission === 'edit' ? 'Can edit' : 'View only'}
          </span>

          {/* Collaborator avatars */}
          <div className="flex items-center gap-1 ml-2">
            <div className="relative group">
              <div
                className="w-8 h-8 rounded-xl flex items-center justify-center text-xs font-bold text-white shadow-sm"
                style={{ backgroundColor: me.color }}
              >
                {me.initials}
              </div>
              <div className="absolute top-full mt-2 right-0 bg-gray-900 text-white text-xs py-1 px-2 rounded whitespace-nowrap z-50 pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity">
                {me.name} (You)
              </div>
            </div>
            {peers.map(peer => (
              <div key={peer.id} className="relative group">
                <div
                  className={`w-8 h-8 rounded-xl flex items-center justify-center text-xs font-bold text-white shadow-sm transition-all duration-300 ${!peer.isActive ? 'opacity-30 grayscale' : ''}`}
                  style={{ backgroundColor: peer.color }}
                >
                  {peer.initials}
                </div>
                <div className="absolute top-full mt-2 right-0 bg-gray-900 text-white text-xs py-1 px-2 rounded whitespace-nowrap z-50 pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity">
                  {peer.name}
                </div>
              </div>
            ))}
          </div>
        </div>
      </header>

      {/* Canvas */}
      <div className="flex-1 w-full relative" style={{ height: 'calc(100vh - 3.5rem)' }}>
        <Excalidraw
          theme={theme === 'dark' ? 'dark' : 'light'}
          initialData={initialData}
          onChange={handleCanvasChange}
          onPointerUpdate={onPointerUpdate}
          viewModeEnabled={drawing.permission === 'view'}
          excalidrawAPI={setExcalidrawAPI}
          UIOptions={UIOptions}
        />
        <Toaster position="bottom-center" />
      </div>
    </div>
  );
};
