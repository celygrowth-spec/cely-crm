"use client";

// Tableau de tâches façon tableur, volontairement limité : cellules typées (texte, liste, date), pas de
// formules. Navigation clavier (flèches, Entrée/F2 pour modifier, Échap pour annuler, Entrée pour valider),
// tri par colonne, colonnes redimensionnables, en-tête fixe. Chaque modification est enregistrée
// immédiatement ; en cas d'échec la valeur précédente revient et l'erreur est affichée.
import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Loader2, PanelRightOpen } from "lucide-react";
import { cn } from "@/lib/cn";

export type GridColumn<R> = {
  key: string;
  label: string;
  width: number;
  /** valeur utilisée pour le tri et l'édition */
  value: (r: R) => string;
  render?: (r: R) => ReactNode;
  editor?: "text" | "select" | "date";
  options?: (r: R) => { value: string; label: string }[];
  editable?: (r: R) => boolean;
  sortValue?: (r: R) => string | number;
};

export function TaskGrid<R extends { id: string }>({
  rows, columns, onCommit, onOpen, empty, footer, ariaLabel,
}: {
  rows: R[];
  columns: GridColumn<R>[];
  onCommit: (row: R, key: string, value: string) => Promise<boolean>;
  onOpen?: (row: R) => void;
  empty?: ReactNode;
  footer?: ReactNode;
  ariaLabel: string;
}) {
  const [sort, setSort] = useState<{ key: string; asc: boolean } | null>(null);
  const [widths, setWidths] = useState<Record<string, number>>(() => Object.fromEntries(columns.map((c) => [c.key, c.width])));
  const [active, setActive] = useState<{ r: number; c: number } | null>(null);
  const [editing, setEditing] = useState<{ r: number; c: number; value: string } | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col) return rows;
    const val = col.sortValue ?? col.value;
    return [...rows].sort((a, b) => {
      const x = val(a);
      const y = val(b);
      const cmp = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), "fr", { numeric: true });
      return sort.asc ? cmp : -cmp;
    });
  }, [rows, columns, sort]);

  const cellId = (r: number, c: number) => `cell-${ariaLabel.replace(/\W/g, "")}-${r}-${c}`;
  function focusCell(r: number, c: number) {
    const rr = Math.max(0, Math.min(sorted.length - 1, r));
    const cc = Math.max(0, Math.min(columns.length - 1, c));
    setActive({ r: rr, c: cc });
    requestAnimationFrame(() => document.getElementById(cellId(rr, cc))?.focus());
  }
  const canEdit = (r: number, c: number) => {
    const col = columns[c];
    return !!col.editor && (col.editable ? col.editable(sorted[r]) : true);
  };

  async function commit(r: number, c: number, value: string) {
    const row = sorted[r];
    const col = columns[c];
    setEditing(null);
    if (value === col.value(row)) return focusCell(r, c);
    setSaving(`${row.id}:${col.key}`);
    await onCommit(row, col.key, value);
    setSaving(null);
    focusCell(r, c);
  }

  function onKey(e: KeyboardEvent, r: number, c: number) {
    if (editing) return;
    const moves: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    if (moves[e.key]) {
      e.preventDefault();
      focusCell(r + moves[e.key][0], c + moves[e.key][1]);
    } else if ((e.key === "Enter" || e.key === "F2") && canEdit(r, c)) {
      e.preventDefault();
      setEditing({ r, c, value: columns[c].value(sorted[r]) });
    } else if (e.key === "Enter" && onOpen) {
      e.preventDefault();
      onOpen(sorted[r]);
    } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && columns[c].editor === "text" && canEdit(r, c)) {
      setEditing({ r, c, value: e.key });
      e.preventDefault();
    }
  }

  function startResize(e: React.PointerEvent, key: string) {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const start = widths[key];
    const move = (ev: PointerEvent) => setWidths((w) => ({ ...w, [key]: Math.max(70, Math.min(600, start + ev.clientX - startX)) }));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  const total = columns.reduce((s, c) => s + widths[c.key], 0) + (onOpen ? 40 : 0);

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-white">
      <div ref={gridRef} className="max-h-[65vh] overflow-auto">
        <table role="grid" aria-label={ariaLabel} className="text-sm" style={{ tableLayout: "fixed", width: total, minWidth: "100%" }}>
          <colgroup>
            {columns.map((c) => <col key={c.key} style={{ width: widths[c.key] }} />)}
            {onOpen && <col style={{ width: 40 }} />}
          </colgroup>
          <thead className="sticky top-0 z-10 bg-surface">
            <tr>
              {columns.map((c) => (
                <th key={c.key} scope="col" aria-sort={sort?.key === c.key ? (sort.asc ? "ascending" : "descending") : "none"} className="relative border-b border-line px-0 text-left font-label text-xs font-semibold text-muted">
                  <button type="button" onClick={() => setSort(sort?.key === c.key ? { key: c.key, asc: !sort.asc } : { key: c.key, asc: true })} className="flex w-full items-center gap-1 px-2.5 py-2 hover:text-ink">
                    {c.label}
                    {sort?.key === c.key && (sort.asc ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
                  </button>
                  <span role="separator" aria-orientation="vertical" aria-label={`Redimensionner ${c.label}`} onPointerDown={(e) => startResize(e, c.key)} className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-violet/40" />
                </th>
              ))}
              {onOpen && <th className="border-b border-line" aria-label="Détail" />}
            </tr>
          </thead>
          <tbody>
            {sorted.map((row, r) => (
              <tr key={row.id} className="group">
                {columns.map((col, c) => {
                  const isEditing = editing?.r === r && editing.c === c;
                  const isActive = active?.r === r && active.c === c;
                  const busy = saving === `${row.id}:${col.key}`;
                  const editable = canEdit(r, c);
                  return (
                    <td
                      key={col.key}
                      id={cellId(r, c)}
                      role="gridcell"
                      tabIndex={isActive || (!active && r === 0 && c === 0) ? 0 : -1}
                      aria-readonly={!editable}
                      onFocus={() => setActive({ r, c })}
                      onKeyDown={(e) => onKey(e, r, c)}
                      onDoubleClick={() => editable && setEditing({ r, c, value: col.value(row) })}
                      onClick={() => { setActive({ r, c }); if (editable && col.editor !== "text") setEditing({ r, c, value: col.value(row) }); }}
                      className={cn(
                        "h-9 truncate border-b border-line/70 px-2.5 align-middle outline-none",
                        editable && "cursor-cell hover:bg-violet-soft/40",
                        isActive && !isEditing && "ring-2 ring-violet ring-inset",
                        busy && "opacity-60",
                      )}
                    >
                      {isEditing ? (
                        <CellEditor
                          col={col}
                          row={row}
                          initial={editing.value}
                          onCancel={() => { setEditing(null); focusCell(r, c); }}
                          onCommit={(v, move) => { void commit(r, c, v).then(() => move && focusCell(r + 1, c)); }}
                        />
                      ) : (
                        <span className="flex items-center gap-1.5">
                          {busy && <Loader2 size={12} className="shrink-0 animate-spin" aria-label="Enregistrement" />}
                          {col.render ? col.render(row) : col.value(row) || <span className="text-muted/60">—</span>}
                        </span>
                      )}
                    </td>
                  );
                })}
                {onOpen && (
                  <td className="border-b border-line/70 px-1 text-center">
                    <button type="button" onClick={() => onOpen(row)} className="rounded p-1 text-muted opacity-60 group-hover:opacity-100 hover:bg-surface hover:text-ink" aria-label="Ouvrir le détail">
                      <PanelRightOpen size={15} />
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {sorted.length === 0 && empty}
      </div>
      {footer}
    </div>
  );
}

function CellEditor<R>({ col, row, initial, onCancel, onCommit }: { col: GridColumn<R>; row: R; initial: string; onCancel: () => void; onCommit: (v: string, moveDown: boolean) => void }) {
  const [v, setV] = useState(initial);
  const done = useRef(false);
  const finish = (value: string, move: boolean) => {
    if (done.current) return;
    done.current = true;
    onCommit(value, move);
  };
  const keys = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") { done.current = true; onCancel(); }
    if (e.key === "Enter") { e.preventDefault(); finish(v, true); }
  };
  const cls = "h-7 w-full rounded border border-violet bg-white px-1.5 text-sm outline-none";
  if (col.editor === "select") {
    return (
      <select autoFocus className={cls} value={v} onKeyDown={keys} onBlur={() => finish(v, false)} onChange={(e) => { setV(e.target.value); finish(e.target.value, false); }} aria-label={col.label}>
        {(col.options?.(row) ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    );
  }
  return <input autoFocus type={col.editor === "date" ? "date" : "text"} className={cls} value={v} onKeyDown={keys} onBlur={() => finish(v, false)} onChange={(e) => setV(e.target.value)} aria-label={col.label} maxLength={300} />;
}
