'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  Building2,
  Calendar,
  CheckSquare,
  ChevronDown,
  GripVertical,
  Mail,
  Paperclip,
  PenLine,
  PenTool,
  Phone,
  Save,
  Trash2,
  Type,
  User,
  Briefcase,
} from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import type { FieldType, TemplateDetail, TemplateField } from '@/lib/types';

const FIELD_TYPES: Array<{ type: FieldType; label: string; icon: React.ComponentType<{ className?: string }>; defaultSize: { width: number; height: number } }> = [
  { type: 'SIGNATURE', label: 'Signature', icon: PenLine, defaultSize: { width: 30, height: 12 } },
  { type: 'INITIAL', label: 'Initials', icon: PenTool, defaultSize: { width: 16, height: 10 } },
  { type: 'NAME', label: 'Name', icon: User, defaultSize: { width: 30, height: 8 } },
  { type: 'EMAIL', label: 'Email', icon: Mail, defaultSize: { width: 30, height: 8 } },
  { type: 'DATE', label: 'Date', icon: Calendar, defaultSize: { width: 20, height: 8 } },
  { type: 'TEXT', label: 'Text', icon: Type, defaultSize: { width: 30, height: 8 } },
  { type: 'CHECKBOX', label: 'Checkbox', icon: CheckSquare, defaultSize: { width: 8, height: 8 } },
  { type: 'DROPDOWN', label: 'Dropdown', icon: ChevronDown, defaultSize: { width: 24, height: 8 } },
  { type: 'ATTACHMENT', label: 'Attachment', icon: Paperclip, defaultSize: { width: 22, height: 10 } },
  { type: 'COMPANY', label: 'Company', icon: Building2, defaultSize: { width: 30, height: 8 } },
  { type: 'JOB_TITLE', label: 'Job title', icon: Briefcase, defaultSize: { width: 30, height: 8 } },
  { type: 'PHONE', label: 'Phone', icon: Phone, defaultSize: { width: 24, height: 8 } },
];

const FIELD_COLORS: Record<string, string> = {
  SIGNATURE: 'border-emerald-400 bg-emerald-50 text-emerald-700',
  INITIAL: 'border-teal-400 bg-teal-50 text-teal-700',
  DATE: 'border-amber-400 bg-amber-50 text-amber-700',
  TEXT: 'border-sky-400 bg-sky-50 text-sky-700',
  CHECKBOX: 'border-violet-400 bg-violet-50 text-violet-700',
  DROPDOWN: 'border-fuchsia-400 bg-fuchsia-50 text-fuchsia-700',
  ATTACHMENT: 'border-rose-400 bg-rose-50 text-rose-700',
  NAME: 'border-indigo-400 bg-indigo-50 text-indigo-700',
  EMAIL: 'border-blue-400 bg-blue-50 text-blue-700',
  COMPANY: 'border-cyan-400 bg-cyan-50 text-cyan-700',
  JOB_TITLE: 'border-slate-400 bg-slate-50 text-slate-700',
  PHONE: 'border-orange-400 bg-orange-50 text-orange-700',
};

interface DraggableField extends TemplateField {
  id: string; // client-side stable key
}

const STORAGE_KEY = 'signara:template-editor';

function toClientFields(fields: TemplateField[]): DraggableField[] {
  return fields.map((f, i) => ({ ...f, id: f.id ?? `f-${i}` }));
}

function toServerFields(fields: DraggableField[]): TemplateField[] {
  return fields.map(({ id: _id, ...f }) => ({ ...f, x: f.x ?? 10, y: f.y ?? 10 }));
}

export function TemplateEditorClient({ templateId }: { templateId: string }) {
  const [template, setTemplate] = useState<TemplateDetail | null>(null);
  const [fields, setFields] = useState<DraggableField[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activePage, setActivePage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const canvasRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ fieldId: string; mode: 'move' | 'resize'; offsetX: number; offsetY: number; startX: number; startY: number } | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const t = await api.get<TemplateDetail>(`/api/v1/templates/${templateId}`);
      setTemplate(t);
      setFields(toClientFields(t.fields));
      setActivePage(1);
      setSelectedId(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load template');
    } finally {
      setLoading(false);
    }
  }, [templateId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Recover a draft from the previous session (before the template was loaded)
  useEffect(() => {
    if (!template) return;
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw) as { templateId: string; fields: DraggableField[] };
        if (saved.templateId === templateId && saved.fields.length > 0) {
          setFields(saved.fields);
          window.localStorage.removeItem(STORAGE_KEY);
        }
      }
    } catch {
      /* ignore corrupted drafts */
    }
  }, [template, templateId]);

  const pageCount = useMemo(() => Math.max(1, ...fields.map((f) => f.pageNumber)), [fields]);

  useEffect(() => {
    if (activePage > pageCount) setActivePage(pageCount);
  }, [pageCount, activePage]);

  // ------------------------------------------------------------ persistence --
  useEffect(() => {
    if (!template) return;
    const timer = window.setTimeout(() => {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ templateId, fields }));
    }, 400);
    return () => window.clearTimeout(timer);
  }, [fields, template, templateId]);

  async function save() {
    if (!template) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await api.patch<TemplateDetail>(`/api/v1/templates/${templateId}`, {
        name: template.name,
        description: template.description,
        fields: toServerFields(fields),
      });
      setTemplate(updated);
      setFields(toClientFields(updated.fields));
      window.localStorage.removeItem(STORAGE_KEY);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save template');
    } finally {
      setSaving(false);
    }
  }

  // --------------------------------------------------------------- editing --
  function selectField(id: string | null) {
    setSelectedId(id);
  }

  function updateField(id: string, patch: Partial<DraggableField>) {
    setFields((prev) => prev.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  }

  function addField(type: FieldType) {
    const spec = FIELD_TYPES.find((t) => t.type === type)!;
    const base = Math.max(10, 10 + fields.length * 2);
    const field: DraggableField = {
      id: `f-${Date.now()}`,
      type,
      name: spec.label,
      key: null,
      isRequired: true,
      pageNumber: activePage,
      x: base % 60,
      y: base % 50,
      width: spec.defaultSize.width,
      height: spec.defaultSize.height,
    };
    setFields((prev) => [...prev, field]);
    setSelectedId(field.id);
  }

  function removeField(id: string) {
    setFields((prev) => prev.filter((f) => f.id !== id));
    if (selectedId === id) setSelectedId(null);
  }

  // ------------------------------------------------------------- dragging --
  function canvasPoint(clientX: number, clientY: number) {
    const rect = canvasRef.current!.getBoundingClientRect();
    return {
      x: Math.min(100, Math.max(0, ((clientX - rect.left) / rect.width) * 100)),
      y: Math.min(100, Math.max(0, ((clientY - rect.top) / rect.height) * 100)),
    };
  }

  function onPointerDown(e: React.PointerEvent, field: DraggableField, mode: 'move' | 'resize') {
    e.preventDefault();
    e.stopPropagation();
    selectField(field.id);
    // Move the canvas element to capture the pointer across the whole sheet
    const rect = canvasRef.current!.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * 100;
    const py = ((e.clientY - rect.top) / rect.height) * 100;
    dragRef.current = {
      fieldId: field.id,
      mode,
      offsetX: px - (field.x ?? 0),
      offsetY: py - (field.y ?? 0),
      startX: px,
      startY: py,
    };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: React.PointerEvent) {
    const drag = dragRef.current;
    if (!drag) return;
    const pt = canvasPoint(e.clientX, e.clientY);
    const field = fields.find((f) => f.id === drag.fieldId);
    if (!field) return;
    if (drag.mode === 'move') {
      updateField(drag.fieldId, {
        x: Math.min(100 - (field.width ?? 10), Math.max(0, pt.x - drag.offsetX)),
        y: Math.min(100 - (field.height ?? 8), Math.max(0, pt.y - drag.offsetY)),
      });
    } else {
      updateField(drag.fieldId, {
        width: Math.min(100 - (field.x ?? 0), Math.max(4, pt.x - (field.x ?? 0))),
        height: Math.min(100 - (field.y ?? 0), Math.max(4, pt.y - (field.y ?? 0))),
      });
    }
  }

  function onPointerUp() {
    dragRef.current = null;
  }

  function onCanvasClick(e: React.MouseEvent) {
    if (dragRef.current) return;
    selectField(null);
    void e;
  }

  // ---------------------------------------------------------------- render --
  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Spinner className="h-8 w-8 text-primary-500" />
      </div>
    );
  }

  if (!template) {
    return (
      <div>
        <p className="text-sm text-slate-500">{error ?? 'Template not found.'}</p>
        <Link href="/templates" className="btn-outline mt-4">
          Back to templates
        </Link>
      </div>
    );
  }

  const selected = fields.find((f) => f.id === selectedId) ?? null;

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href="/templates" className="mb-2 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700">
            <ArrowLeft className="h-4 w-4" />
            Templates
          </Link>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold">{template.name}</h1>
            <Badge tone={template.status === 'ACTIVE' ? 'green' : template.status === 'ARCHIVED' ? 'gray' : 'amber'}>
              {template.status}
            </Badge>
          </div>
          <p className="text-sm text-slate-500">{fields.length} field(s) · {pageCount} page(s)</p>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => void save()} loading={saving}>
            <Save className="h-4 w-4" />
            Save template
          </Button>
        </div>
      </div>

      {error && (
        <div className="mb-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[240px_1fr_280px]">
        {/* Palette */}
        <Card className="h-fit">
          <CardHeader>
            <CardTitle>Fields</CardTitle>
            <CardDescription>Click to add to the current page.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-2">
              {FIELD_TYPES.map(({ type, label, icon: Icon }) => (
                <button
                  key={type}
                  type="button"
                  onClick={() => addField(type)}
                  className="flex flex-col items-center gap-1.5 rounded-lg border border-slate-200 px-2 py-3 text-xs font-medium text-slate-600 hover:border-primary-400 hover:bg-primary-50 hover:text-primary-700"
                >
                  <Icon className="h-4 w-4" />
                  {label}
                </button>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Canvas */}
        <div>
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-1 rounded-lg border border-slate-200 bg-white p-1" role="tablist" aria-label="Pages">
              {Array.from({ length: pageCount }, (_, i) => i + 1).map((page) => (
                <button
                  key={page}
                  type="button"
                  role="tab"
                  aria-selected={page === activePage}
                  onClick={() => setActivePage(page)}
                  className={`rounded-md px-3 py-1.5 text-sm font-medium ${
                    page === activePage ? 'bg-primary-500 text-white' : 'text-slate-600 hover:bg-slate-100'
                  }`}
                >
                  Page {page}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setActivePage(pageCount + 1)}
                className="rounded-md px-2 py-1.5 text-sm text-slate-400 hover:bg-slate-100"
                aria-label="Add page"
                title="Add page"
              >
                +
              </button>
            </div>
            <p className="text-xs text-slate-400">Drag to move · handle to resize</p>
          </div>

          <div
            ref={canvasRef}
            role="application"
            aria-label={`Page ${activePage} canvas`}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onClick={onCanvasClick}
            className="relative aspect-[1/1.414] w-full rounded-lg border border-slate-200 bg-white shadow-card"
          >
            {fields
              .filter((f) => f.pageNumber === activePage)
              .map((field) => {
                const color = FIELD_COLORS[field.type];
                const isSelected = field.id === selectedId;
                const Icon = FIELD_TYPES.find((t) => t.type === field.type)?.icon ?? Type;
                return (
                  <div
                    key={field.id}
                    onPointerDown={(e) => onPointerDown(e, field, 'move')}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                    className={`absolute flex cursor-move items-center justify-center rounded border-2 border-dashed text-[10px] font-medium ${color} ${
                      isSelected ? 'ring-2 ring-primary-500 ring-offset-1' : ''
                    }`}
                    style={{
                      left: `${field.x ?? 0}%`,
                      top: `${field.y ?? 0}%`,
                      width: `${field.width ?? 10}%`,
                      height: `${field.height ?? 8}%`,
                      touchAction: 'none',
                    }}
                    title={`${field.name ?? field.type} — page ${field.pageNumber}`}
                  >
                    <span className="flex items-center gap-1 truncate px-1">
                      <Icon className="h-3 w-3 shrink-0" />
                      <span className="truncate">{field.name ?? field.type}</span>
                    </span>
                    {isSelected && (
                      <span
                        onPointerDown={(e) => onPointerDown(e, field, 'resize')}
                        onPointerMove={onPointerMove}
                        onPointerUp={onPointerUp}
                        className="absolute -bottom-1.5 -right-1.5 h-3.5 w-3.5 cursor-nwse-resize rounded-sm border border-primary-600 bg-primary-500"
                        style={{ touchAction: 'none' }}
                        aria-label="Resize"
                      />
                    )}
                  </div>
                );
              })}
            {fields.filter((f) => f.pageNumber === activePage).length === 0 && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <p className="text-sm text-slate-300">Click a field type on the left to place it here</p>
              </div>
            )}
          </div>
        </div>

        {/* Inspector */}
        <Card className="h-fit">
          <CardHeader>
            <CardTitle>Selected field</CardTitle>
          </CardHeader>
          <CardContent>
            {!selected ? (
              <p className="py-6 text-center text-sm text-slate-500">Click a field to edit its properties.</p>
            ) : (
              <div className="space-y-4">
                <div>
                  <span className="label">Type</span>
                  <div className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm">
                    {(() => {
                      const Icon = FIELD_TYPES.find((t) => t.type === selected.type)?.icon ?? Type;
                      return <Icon className="h-4 w-4" />;
                    })()}
                    <span className="font-medium">{selected.type}</span>
                  </div>
                </div>
                <div>
                  <label className="label" htmlFor="field-label">
                    Label
                  </label>
                  <input
                    id="field-label"
                    className="input"
                    value={selected.name ?? ''}
                    onChange={(e) => updateField(selected.id, { name: e.target.value })}
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="label" htmlFor="field-page">
                      Page
                    </label>
                    <select
                      id="field-page"
                      className="input"
                      value={selected.pageNumber}
                      onChange={(e) => updateField(selected.id, { pageNumber: Number(e.target.value) })}
                    >
                      {Array.from({ length: Math.max(pageCount, selected.pageNumber) }, (_, i) => i + 1).map((p) => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <span className="label">Required</span>
                    <label className="flex items-center gap-2 pt-2 text-sm">
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-slate-300 text-primary-600"
                        checked={selected.isRequired}
                        onChange={(e) => updateField(selected.id, { isRequired: e.target.checked })}
                      />
                      Required
                    </label>
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <label className="label" htmlFor="field-x">
                      X %
                    </label>
                    <input
                      id="field-x"
                      type="number"
                      className="input"
                      min={0}
                      max={100}
                      value={selected.x ?? 0}
                      onChange={(e) => updateField(selected.id, { x: Number(e.target.value) })}
                    />
                  </div>
                  <div>
                    <label className="label" htmlFor="field-y">
                      Y %
                    </label>
                    <input
                      id="field-y"
                      type="number"
                      className="input"
                      min={0}
                      max={100}
                      value={selected.y ?? 0}
                      onChange={(e) => updateField(selected.id, { y: Number(e.target.value) })}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="label" htmlFor="field-w">
                        W
                      </label>
                      <input
                        id="field-w"
                        type="number"
                        className="input"
                        min={4}
                        max={100}
                        value={selected.width ?? 10}
                        onChange={(e) => updateField(selected.id, { width: Number(e.target.value) })}
                      />
                    </div>
                    <div>
                      <label className="label" htmlFor="field-h">
                        H
                      </label>
                      <input
                        id="field-h"
                        type="number"
                        className="input"
                        min={4}
                        max={100}
                        value={selected.height ?? 8}
                        onChange={(e) => updateField(selected.id, { height: Number(e.target.value) })}
                      />
                    </div>
                  </div>
                </div>
                <Button variant="danger" className="w-full" onClick={() => removeField(selected.id)}>
                  <Trash2 className="h-4 w-4" />
                  Remove field
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="mt-4 flex items-center gap-2 text-xs text-slate-400">
        <GripVertical className="h-3.5 w-3.5" />
        Changes auto-save to this browser as a draft and are published when you click Save template.
      </div>
    </div>
  );
}

function Spinner({ className }: { className?: string }) {
  return <div className={`h-8 w-8 animate-spin rounded-full border-2 border-primary-500 border-t-transparent ${className ?? ''}`} />;
}