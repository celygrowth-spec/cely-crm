"use client";

// Productivité › To do list : ajout en une ligne, liste triée par urgence, modification sur place, zone « Terminées »
// repliée. Chaque écriture attend la réponse de la base : un échec garde la saisie et l'affiche clairement.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { createTodoAction } from "@/app/todo-actions";
import { CompanyPicker, type ClientOption } from "@/components/finance/forms";
import { CompanyLink, TODO_KEY, TodoCheck, UrgencySelect, useTodoUpdate } from "@/components/todo/todo-parts";
import { TrashButton } from "@/components/trash/trash-button";
import { Button, EmptyState, Input, PageHeader, Skeleton, Spinner, cn } from "@/components/ui";
import { apiGet, attempt } from "@/lib/client/query";
import { DEFAULT_URGENCY, splitTodos, type TodoItem, type Urgency } from "@/lib/todo/types";

export function TodoView() {
  const list = useQuery({ queryKey: TODO_KEY, queryFn: ({ signal }) => apiGet<TodoItem[]>("/api/todo", signal) });
  const titleRef = useRef<HTMLInputElement>(null);
  const { open, done } = splitTodos(list.data ?? []);

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="To do list" description="Vos tâches, de la plus urgente à la moins urgente. Reliez-les à une fiche si besoin." />
      <AddTodo titleRef={titleRef} />

      {list.isLoading && <div className="mt-4 grid gap-2"><Skeleton className="h-11 w-full" /><Skeleton className="h-11 w-full" /><Skeleton className="h-11 w-full" /></div>}
      {list.isError && <p role="alert" className="mt-4 text-sm text-danger">{list.error.message}</p>}

      {list.data && !open.length && !done.length && (
        <div className="mt-4">
          <EmptyState
            title="Aucune tâche pour l'instant"
            description="Ajoutez votre première tâche ci-dessus : un titre suffit. L'urgence est « Moyen » par défaut."
            action={<Button variant="primary" onClick={() => titleRef.current?.focus()}><Plus size={15} /> Créer ma première tâche</Button>}
          />
        </div>
      )}

      {list.data && (open.length > 0 || done.length > 0) && (
        <section className="mt-4" aria-label="Tâches à faire">
          {open.length ? (
            <ul className="divide-y divide-line rounded-xl border border-line bg-white" data-todo-open>
              {open.map((t) => <TodoRow key={t.id} todo={t} />)}
            </ul>
          ) : (
            <p className="rounded-xl border border-dashed border-line px-4 py-3 text-sm text-muted">Tout est fait. Ajoutez une nouvelle tâche ci-dessus.</p>
          )}
        </section>
      )}

      {done.length > 0 && (
        <details className="group mt-5" data-todo-done>
          <summary className="cursor-pointer font-label text-xs font-bold text-muted uppercase select-none hover:text-ink">
            Terminées · {done.length}
          </summary>
          <ul className="mt-2 divide-y divide-line rounded-xl border border-line bg-white">
            {done.map((t) => <TodoRow key={t.id} todo={t} />)}
          </ul>
        </details>
      )}
    </div>
  );
}

/** Ajout en une ligne. L'identifiant est fixé à la saisie : une double validation ou un « Réessayer » ne crée qu'une tâche. */
function AddTodo({ titleRef }: { titleRef: React.RefObject<HTMLInputElement | null> }) {
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const [urgency, setUrgency] = useState<Urgency>(DEFAULT_URGENCY);
  const [company, setCompany] = useState<ClientOption | null>(null);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const draftId = useRef<string>(crypto.randomUUID());
  const sending = useRef(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (sending.current) return; // double clic, double Entrée
    if (!title.trim()) {
      setError("Donnez un titre à la tâche.");
      titleRef.current?.focus();
      return;
    }
    sending.current = true;
    setBusy(true);
    setError(null);
    const r = await attempt(() => createTodoAction({ id: draftId.current, title, urgency, company_id: company?.id ?? null }));
    sending.current = false;
    setBusy(false);
    if (!r.ok) {
      setError(r.error); // saisie conservée, même identifiant pour réessayer
      toast.error(r.error);
      return;
    }
    qc.setQueryData<TodoItem[]>(TODO_KEY, (old) => (old ? [r.data, ...old.filter((t) => t.id !== r.data.id)] : old));
    qc.invalidateQueries({ queryKey: TODO_KEY });
    if (r.data.company_id) qc.invalidateQueries({ queryKey: ["company-todo", r.data.company_id] });
    draftId.current = crypto.randomUUID();
    setTitle("");
    setUrgency(DEFAULT_URGENCY);
    setCompany(null);
    setPicking(false);
    titleRef.current?.focus();
  }

  return (
    <form onSubmit={submit} className="rounded-xl border border-line bg-white p-3" aria-label="Nouvelle tâche" data-todo-add>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          ref={titleRef}
          value={title}
          onChange={(e) => { setTitle(e.target.value); if (error) setError(null); }}
          placeholder="Nouvelle tâche…"
          aria-label="Titre de la tâche"
          maxLength={300}
          className="min-w-48 flex-1"
          disabled={busy}
        />
        <UrgencySelect value={urgency} onChange={setUrgency} disabled={busy} className="h-9 px-3 text-xs" />
        {company ? (
          <span className="flex h-9 items-center gap-2 rounded-lg border border-line bg-surface px-3 text-sm">
            <span className="max-w-40 truncate font-semibold">{company.name}</span>
            <button type="button" className="text-xs font-semibold text-violet-strong" onClick={() => setCompany(null)} disabled={busy}>Retirer</button>
          </span>
        ) : (
          <Button onClick={() => setPicking(!picking)} aria-expanded={picking} disabled={busy}>Lier une fiche</Button>
        )}
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? <Spinner /> : <Plus size={15} />} Ajouter
        </Button>
      </div>
      {picking && !company && (
        <div className="mt-2 max-w-md">
          <CompanyPicker value={null} onChange={(c) => { setCompany(c); setPicking(false); }} suggestions={[]} />
        </div>
      )}
      {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
    </form>
  );
}

function TodoRow({ todo }: { todo: TodoItem }) {
  const update = useTodoUpdate();
  const [title, setTitle] = useState(todo.title);
  const [saved, setSaved] = useState(todo.title);
  const [busy, setBusy] = useState(false);
  const [titleError, setTitleError] = useState(false);
  const [picking, setPicking] = useState(false);
  const done = !!todo.done_at;
  // le titre suit la base quand il change ailleurs (sans écraser une saisie en cours)
  if (todo.title !== saved) {
    setSaved(todo.title);
    if (title === saved) setTitle(todo.title);
  }

  async function save(patch: Parameters<typeof update>[1]) {
    setBusy(true);
    const r = await update(todo.id, patch);
    setBusy(false);
    return r;
  }

  async function saveTitle() {
    const next = title.trim();
    if (next === todo.title) return setTitleError(false);
    if (!next) {
      setTitle(todo.title);
      return toast.error("Le titre ne peut pas être vide : il a été rétabli.");
    }
    const r = await save({ title: next });
    setTitleError(!r); // échec : la saisie reste affichée, à réessayer
  }

  return (
    <li className={cn("px-3 py-2", done && "bg-surface/50")} data-todo-row data-urgency={todo.urgency}>
      <div className="flex flex-wrap items-center gap-2">
        <TodoCheck todo={todo} />
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={saveTitle}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") { setTitle(todo.title); setTitleError(false); }
          }}
          maxLength={300}
          aria-label="Titre de la tâche"
          aria-invalid={titleError || undefined}
          className={cn(
            "h-8 min-w-40 flex-1 rounded-md border border-transparent bg-transparent px-1.5 text-sm text-ink hover:border-line focus:border-violet focus:bg-white focus:outline-none",
            done && "text-muted line-through",
            titleError && "border-danger",
          )}
        />
        <UrgencySelect value={todo.urgency} disabled={busy} onChange={(u) => save({ urgency: u })} />
        <span className="flex items-center gap-1.5">
          <CompanyLink todo={todo} />
          <button type="button" disabled={busy} className="text-xs text-muted hover:text-ink" onClick={() => setPicking(!picking)} aria-expanded={picking}>
            {todo.company_id ? "Changer" : "Lier une fiche"}
          </button>
          {todo.company_id && (
            <button type="button" disabled={busy} className="text-xs text-muted hover:text-ink" onClick={() => save({ company_id: null })}>Retirer</button>
          )}
        </span>
        <TrashButton kind="todo_list_item" id={todo.id} sync={[[...TODO_KEY], ["company-todo"]]} />
      </div>
      {titleError && <p role="alert" className="mt-1 pl-7 text-xs text-danger">Titre non enregistré. Votre texte est conservé : cliquez ailleurs pour réessayer.</p>}
      {picking && (
        <div className="mt-2 max-w-md pl-7">
          <CompanyPicker value={null} onChange={async (c) => { if (c && (await save({ company_id: c.id }))) setPicking(false); }} suggestions={[]} />
        </div>
      )}
    </li>
  );
}
