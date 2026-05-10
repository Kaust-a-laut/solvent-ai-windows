import React, { useCallback, useMemo, useRef, useEffect, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  addEdge,
  applyNodeChanges,
  applyEdgeChanges,
  useReactFlow,
  type Node,
  type Edge,
  type NodeChange,
  type EdgeChange,
  type Connection,
  type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useAppStore } from '../../store/useAppStore';
import { useShallow } from 'zustand/react/shallow';
import { TextNode } from './nodes/TextNode';
import { ImageNode } from './nodes/ImageNode';
import { LinkNode } from './nodes/LinkNode';
import { GroupNode } from './nodes/GroupNode';
import { NotepadContextMenu, type ContextMenuState } from './NotepadContextMenu';

const nodeTypes = {
  text: TextNode,
  image: ImageNode,
  link: LinkNode,
  group: GroupNode,
};

const newId = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

const NotepadCanvasInner: React.FC = () => {
  const { activeDoc, updateActive, activeDocId, undo, redo } = useAppStore(
    useShallow((s) => ({
      activeDoc: s.notepadActiveDoc,
      updateActive: s.notepadUpdateActive,
      activeDocId: s.notepadActiveDocId,
      undo: s.notepadUndo,
      redo: s.notepadRedo,
    }))
  );
  const flowRef = useRef<HTMLDivElement | null>(null);
  const rfInstance = useRef<ReactFlowInstance | null>(null);
  const { screenToFlowPosition } = useReactFlow();
  const [menu, setMenu] = useState<ContextMenuState | null>(null);

  const nodes: Node[] = useMemo(() => {
    if (!activeDoc) return [];
    return activeDoc.nodes.map((n) => ({
      id: n.id,
      type: n.type,
      position: n.position,
      data: n.data,
      width: n.width,
      height: n.height,
      style: n.style,
    }));
  }, [activeDoc]);

  const edges: Edge[] = useMemo(() => {
    if (!activeDoc) return [];
    return activeDoc.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle ?? null,
      targetHandle: e.targetHandle ?? null,
      label: e.label,
      animated: false,
      style: { stroke: 'rgba(60,113,247,0.6)', strokeWidth: 1.5 },
    }));
  }, [activeDoc]);

  const isTransientNodeChange = (changes: NodeChange[]): boolean => {
    if (changes.length === 0) return true;
    return changes.every((c) => {
      if (c.type === 'position' && c.dragging) return true;
      if (c.type === 'dimensions' && c.resizing) return true;
      if (c.type === 'select') return true;
      return false;
    });
  };

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const transient = isTransientNodeChange(changes);
      updateActive(
        (doc) => {
          const updated = applyNodeChanges(changes, doc.nodes as unknown as Node[]) as unknown as NotepadCanvasNode[];
          return { ...doc, nodes: updated };
        },
        { transient }
      );
    },
    [updateActive]
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      const transient = changes.every((c) => c.type === 'select');
      updateActive(
        (doc) => {
          const updated = applyEdgeChanges(changes, doc.edges as unknown as Edge[]) as unknown as NotepadCanvasEdge[];
          return { ...doc, edges: updated };
        },
        { transient }
      );
    },
    [updateActive]
  );

  const onConnect = useCallback(
    (params: Connection) => {
      updateActive((doc) => {
        const updated = addEdge(
          { ...params, id: newId('e'), style: { stroke: 'rgba(60,113,247,0.6)', strokeWidth: 1.5 } },
          doc.edges as unknown as Edge[]
        ) as unknown as NotepadCanvasEdge[];
        return { ...doc, edges: updated };
      });
    },
    [updateActive]
  );

  const handlePaste = useCallback(
    async (event: ClipboardEvent) => {
      if (!activeDoc) return;
      // Only handle paste when canvas (or a child not capturing it) is focused
      const target = event.target as HTMLElement;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;

      const items = event.clipboardData?.items;
      if (!items) return;

      const pos = screenToFlowPosition({
        x: window.innerWidth / 2,
        y: window.innerHeight / 2,
      });

      for (const item of Array.from(items)) {
        if (item.type.startsWith('image/')) {
          event.preventDefault();
          const file = item.getAsFile();
          if (!file) continue;
          const reader = new FileReader();
          reader.onload = async () => {
            const base64 = reader.result as string;
            const ext = (file.type.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '');
            let src = base64;
            try {
              const api = window.electron?.notepad;
              if (api && activeDocId) {
                const saved = await api.saveImage(activeDocId, base64, ext);
                src = saved.url;
              }
            } catch (e) {
              console.error('[notepad] image save failed, falling back to data URL', e);
            }
            updateActive((doc) => ({
              ...doc,
              nodes: [
                ...doc.nodes,
                {
                  id: newId('n'),
                  type: 'image',
                  position: pos,
                  data: { src, text: '' },
                  width: 280,
                  height: 220,
                },
              ],
            }));
          };
          reader.readAsDataURL(file);
          return;
        }
      }

      const text = event.clipboardData?.getData('text/plain');
      if (text && text.trim()) {
        const isUrl = /^https?:\/\/\S+$/i.test(text.trim());
        event.preventDefault();
        updateActive((doc) => ({
          ...doc,
          nodes: [
            ...doc.nodes,
            isUrl
              ? {
                  id: newId('n'),
                  type: 'link',
                  position: pos,
                  data: { url: text.trim(), title: '' },
                  width: 280,
                  height: 280,
                }
              : {
                  id: newId('n'),
                  type: 'text',
                  position: pos,
                  data: { text },
                  width: 260,
                  height: 140,
                },
          ],
        }));
      }
    },
    [activeDoc, activeDocId, updateActive, screenToFlowPosition]
  );

  useEffect(() => {
    const handler = (e: ClipboardEvent) => handlePaste(e);
    window.addEventListener('paste', handler);
    return () => window.removeEventListener('paste', handler);
  }, [handlePaste]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((key === 'z' && e.shiftKey) || key === 'y') {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);

  const onMoveEnd = useCallback(
    (_event: unknown, viewport: { x: number; y: number; zoom: number }) => {
      updateActive((doc) => ({ ...doc, viewport }), { transient: true });
    },
    [updateActive]
  );

  // ─── Right-click context menu ──────────────────────────────────────────
  const openMenu = (e: React.MouseEvent, target: ContextMenuState['target']) => {
    e.preventDefault();
    setMenu({ target, screen: { x: e.clientX, y: e.clientY } });
  };

  const onPaneContextMenu = useCallback(
    (event: React.MouseEvent | MouseEvent) => {
      const e = event as React.MouseEvent;
      const flowPos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      openMenu(e, { kind: 'pane', flowPos });
    },
    [screenToFlowPosition]
  );

  const onNodeContextMenu = useCallback((event: React.MouseEvent, node: Node) => {
    openMenu(event, { kind: 'node', nodeId: node.id, nodeType: node.type || 'text' });
  }, []);

  const onEdgeContextMenu = useCallback((event: React.MouseEvent, edge: Edge) => {
    openMenu(event, { kind: 'edge', edgeId: edge.id });
  }, []);

  const addNodeAtPos = (pos: { x: number; y: number }, type: NotepadCanvasNode['type']) => {
    const defaults: Record<NotepadCanvasNode['type'], { width: number; height: number; data: NotepadCanvasNode['data'] }> = {
      text:  { width: 260, height: 140, data: { text: '' } },
      link:  { width: 280, height: 280, data: { url: '', title: '' } },
      image: { width: 280, height: 220, data: { src: '', text: '' } },
      group: { width: 360, height: 240, data: { text: 'Group' } },
    };
    const def = defaults[type];
    updateActive((doc) => ({
      ...doc,
      nodes: [...doc.nodes, { id: newId('n'), type, position: pos, data: def.data, width: def.width, height: def.height }],
    }));
  };

  const triggerImagePickerAt = (pos: { x: number; y: number }) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async () => {
        const base64 = reader.result as string;
        const ext = (file.type.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '');
        let src = base64;
        try {
          const api = window.electron?.notepad;
          if (api && activeDocId) {
            const saved = await api.saveImage(activeDocId, base64, ext);
            src = saved.url;
          }
        } catch (e) { console.error('[notepad] image save failed', e); }
        updateActive((doc) => ({
          ...doc,
          nodes: [...doc.nodes, {
            id: newId('n'), type: 'image', position: pos,
            data: { src, text: file.name }, width: 280, height: 220,
          }],
        }));
      };
      reader.readAsDataURL(file);
    };
    input.click();
  };

  const menuActions = useMemo(() => ({
    onClose: () => setMenu(null),
    onAddNote:  (pos: { x: number; y: number }) => addNodeAtPos(pos, 'text'),
    onAddImage: (pos: { x: number; y: number }) => triggerImagePickerAt(pos),
    onAddLink:  (pos: { x: number; y: number }) => addNodeAtPos(pos, 'link'),
    onAddGroup: (pos: { x: number; y: number }) => addNodeAtPos(pos, 'group'),
    onEditNode: (nodeId: string) => {
      // Best-effort: dispatch a dblclick to the node's wrapper so its inline editor opens.
      const el = document.querySelector(`.react-flow__node[data-id="${CSS.escape(nodeId)}"]`);
      if (el) el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    },
    onDuplicateNode: (nodeId: string) => {
      updateActive((doc) => {
        const src = doc.nodes.find((n) => n.id === nodeId);
        if (!src) return doc;
        const dup: NotepadCanvasNode = {
          ...src,
          id: newId('n'),
          position: { x: src.position.x + 24, y: src.position.y + 24 },
          data: { ...src.data, og: undefined }, // re-fetch OG on duplicate
        };
        return { ...doc, nodes: [...doc.nodes, dup] };
      });
    },
    onDeleteNode: (nodeId: string) => {
      updateActive((doc) => ({
        ...doc,
        nodes: doc.nodes.filter((n) => n.id !== nodeId),
        edges: doc.edges.filter((e) => e.source !== nodeId && e.target !== nodeId),
      }));
    },
    onColorNode: (nodeId: string, color: string) => {
      updateActive((doc) => ({
        ...doc,
        nodes: doc.nodes.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, color } } : n)),
      }));
    },
    onLabelEdge: (edgeId: string) => {
      const current = activeDoc?.edges.find((e) => e.id === edgeId)?.label ?? '';
      const next = window.prompt('Edge label:', current);
      if (next === null) return;
      updateActive((doc) => ({
        ...doc,
        edges: doc.edges.map((e) => (e.id === edgeId ? { ...e, label: next.trim() || undefined } : e)),
      }));
    },
    onDeleteEdge: (edgeId: string) => {
      updateActive((doc) => ({ ...doc, edges: doc.edges.filter((e) => e.id !== edgeId) }));
    },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [updateActive, activeDoc, activeDocId]);

  const onDrop = useCallback(
    async (event: React.DragEvent) => {
      event.preventDefault();
      if (!activeDoc) return;
      const pos = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const files = Array.from(event.dataTransfer.files || []);
      for (const file of files) {
        if (file.type.startsWith('image/')) {
          const reader = new FileReader();
          reader.onload = async () => {
            const base64 = reader.result as string;
            const ext = (file.type.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '');
            let src = base64;
            try {
              const api = window.electron?.notepad;
              if (api && activeDocId) {
                const saved = await api.saveImage(activeDocId, base64, ext);
                src = saved.url;
              }
            } catch (e) {
              console.error('[notepad] image save failed', e);
            }
            updateActive((doc) => ({
              ...doc,
              nodes: [
                ...doc.nodes,
                {
                  id: newId('n'),
                  type: 'image',
                  position: pos,
                  data: { src, text: file.name },
                  width: 280,
                  height: 220,
                },
              ],
            }));
          };
          reader.readAsDataURL(file);
        }
      }
    },
    [activeDoc, activeDocId, updateActive, screenToFlowPosition]
  );

  const defaultViewport = activeDoc?.viewport ?? { x: 0, y: 0, zoom: 1 };

  return (
    <div className="flex-1 min-h-0 relative" ref={flowRef} onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onInit={(inst) => { rfInstance.current = inst; }}
        onMoveEnd={onMoveEnd}
        onPaneContextMenu={onPaneContextMenu}
        onNodeContextMenu={onNodeContextMenu}
        onEdgeContextMenu={onEdgeContextMenu}
        defaultViewport={defaultViewport}
        proOptions={{ hideAttribution: true }}
        fitView={!activeDoc?.viewport || (activeDoc.viewport.x === 0 && activeDoc.viewport.y === 0 && activeDoc.viewport.zoom === 1)}
        deleteKeyCode={['Delete', 'Backspace']}
      >
        <Background color="rgba(255,255,255,0.04)" gap={24} size={1} />
        <Controls className="!bg-black/60 !border !border-white/10 !rounded-lg" />
        <MiniMap
          className="!bg-black/40 !border !border-white/10 !rounded-lg"
          nodeColor={(n) => {
            switch (n.type) {
              case 'image': return '#3c71f7';
              case 'link': return '#9d5bd2';
              case 'group': return '#fb923c';
              default: return '#94a3b8';
            }
          }}
          maskColor="rgba(0,0,0,0.6)"
        />
      </ReactFlow>

      {menu && (
        <NotepadContextMenu
          state={menu}
          actions={menuActions}
          canColor={
            menu.target.kind === 'node' &&
            (menu.target.nodeType === 'text' || menu.target.nodeType === 'group')
          }
        />
      )}
    </div>
  );
};

export const NotepadCanvas: React.FC = () => <NotepadCanvasInner />;

