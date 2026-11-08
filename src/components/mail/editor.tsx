"use client";

// Éditeur d'email (Tiptap / ProseMirror). Non contrôlé : le composeur reçoit le HTML à chaque frappe
// mais ne réinjecte jamais de contenu pendant la saisie, donc l'enregistrement automatique ne déplace
// ni le curseur ni la sélection. Le contenu n'est remplacé que sur demande explicite (modèle, reprise).
import { EditorContent, Node, mergeAttributes, useEditor, useEditorState, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { Bold, Braces, ClipboardPaste, Eraser, Italic, Link2, List, ListOrdered, MoreHorizontal, Quote, Redo2, Underline, Undo2, Unlink } from "lucide-react";
import { cn } from "@/components/ui";
import { htmlToText } from "@/lib/mail/render";
import { VARIABLES, isKnown, labelOf } from "@/lib/mail/variables";

/**
 * Variable : pastille insécable (« Prénom »). Copiée-collée dans l'éditeur, elle reste une variable ;
 * en texte brut, elle devient son libellé. Le curseur la saute d'un bloc, sans jamais la couper.
 */
const Variable = Node.create({
  name: "variable",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return { key: { default: "prenom", parseHTML: (el) => el.getAttribute("data-variable"), renderHTML: (a) => ({ "data-variable": a.key }) } };
  },
  parseHTML() {
    return [{ tag: "span[data-variable]", getAttrs: (el) => (isKnown((el as HTMLElement).getAttribute("data-variable") ?? "") ? null : false) }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, { class: "mail-var", contenteditable: "false" }), labelOf(node.attrs.key as string)];
  },
  renderText({ node }) {
    return labelOf(node.attrs.key as string);
  },
});

export type MailEditorHandle = {
  setHtml: (html: string) => void;
  insertVariable: (key: string) => void;
  insertHtml: (html: string) => void;
  focus: () => void;
  editor: () => Editor | null;
};

/** Adresse de lien acceptée : web, email ou téléphone. « cely.fr » devient « https://cely.fr ». */
export function normalizeUrl(raw: string): string | null {
  const v = raw.trim();
  if (!v || /\s/.test(v)) return null;
  if (/^(https?:\/\/|mailto:|tel:)/i.test(v)) return /^(javascript|data|vbscript):/i.test(v) ? null : v;
  if (/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(v)) return `mailto:${v}`;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/i.test(v)) return `https://${v}`;
  return null;
}
const allowed = (url: string) => /^(https?:|mailto:|tel:)/i.test(url);

/** Nettoie un collage venant de Google Docs, Word ou Gmail avant que l'éditeur ne l'interprète. */
export function cleanPastedHtml(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "") // commentaires conditionnels de Word
    .replace(/<\/?o:p[^>]*>/g, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<meta[^>]*>/gi, "")
    // Google Docs enveloppe tout dans un <b style="font-weight:normal"> : ce n'est pas du gras
    .replace(/<b\b[^>]*id="docs-internal-guid[^"]*"[^>]*>([\s\S]*)<\/b>/i, "$1")
    .replace(/<b\b([^>]*)style="[^"]*font-weight:\s*normal[^"]*"([^>]*)>([\s\S]*?)<\/b>/gi, "$3")
    // tailles, polices et couleurs imposées : l'email garde sa propre mise en forme
    .replace(/\s(class|lang|dir|face|size|color)="[^"]*"/gi, "");
}

export function MailEditor({ initialHtml, onChange, handle, placeholder = "Votre message…", label = "Message" }: {
  initialHtml: string; onChange: (html: string, text: string) => void; handle?: Ref<MailEditorHandle>; placeholder?: string; label?: string;
}) {
  const changed = useRef(onChange);
  useEffect(() => { changed.current = onChange; });
  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        heading: false, code: false, codeBlock: false, horizontalRule: false, strike: false,
        link: { openOnClick: false, autolink: false, linkOnPaste: true, defaultProtocol: "https", isAllowedUri: (url) => allowed(url) },
      }),
      Placeholder.configure({ placeholder }),
      Variable,
    ],
    content: initialHtml,
    editorProps: {
      attributes: {
        class: "mail-editor prose-mail min-h-full px-3 py-2.5 text-sm leading-relaxed outline-none",
        spellcheck: "true",
        lang: "fr",
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": label,
      },
      transformPastedHTML: cleanPastedHtml,
    },
    onUpdate: ({ editor: e }) => {
      const html = e.isEmpty ? "" : e.getHTML();
      changed.current(html, htmlToText(html));
    },
  });

  useImperativeHandle(handle, () => ({
    setHtml: (html) => {
      if (!editor) return;
      editor.chain().setContent(html, { emitUpdate: true }).focus("end").run();
    },
    insertHtml: (html) => editor?.chain().focus().insertContent(html).run(),
    insertVariable: (key) => editor?.chain().focus().insertContent({ type: "variable", attrs: { key } }).run(),
    focus: () => editor?.commands.focus(),
    editor: () => editor,
  }), [editor]);

  return (
    <div className="flex min-h-0 flex-1 flex-col rounded-lg border border-line bg-white focus-within:border-violet focus-within:ring-2 focus-within:ring-violet/20" data-editor>
      {editor && <Toolbar editor={editor} />}
      <EditorContent editor={editor} className="min-h-40 flex-1 overflow-y-auto" />
    </div>
  );
}

function Toolbar({ editor }: { editor: Editor }) {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive("bold"), italic: e.isActive("italic"), underline: e.isActive("underline"),
      bullet: e.isActive("bulletList"), ordered: e.isActive("orderedList"), link: e.isActive("link"), quote: e.isActive("blockquote"),
      canUndo: e.can().undo(), canRedo: e.can().redo(), href: (e.getAttributes("link").href as string | undefined) ?? "",
    }),
  });
  const [linkOpen, setLinkOpen] = useState(false);
  const [more, setMore] = useState(false);
  const [vars, setVars] = useState(false);
  const chain = () => editor.chain().focus();
  const b = (label: string, icon: React.ReactNode, active: boolean, run: () => void, shortcut?: string, disabled = false) => (
    <button type="button" aria-label={label} title={shortcut ? `${label} (${shortcut})` : label} aria-pressed={active} disabled={disabled}
      onMouseDown={(e) => e.preventDefault()} onClick={run}
      className={cn("inline-flex size-8 items-center justify-center rounded-md text-muted hover:bg-surface hover:text-ink disabled:opacity-40", active && "bg-violet-soft text-violet-strong")}>
      {icon}
    </button>
  );

  // Ctrl/⌘ + K : lien
  useEffect(() => {
    const dom = editor.view.dom;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); e.stopPropagation(); setLinkOpen(true); } // pas la recherche globale
    };
    dom.addEventListener("keydown", onKey);
    return () => dom.removeEventListener("keydown", onKey);
  }, [editor]);

  async function pastePlain() {
    setMore(false);
    try {
      const text = await navigator.clipboard.readText();
      if (text) chain().insertContent(text.split(/\n{2,}/).map((p) => ({ type: "paragraph", content: p ? p.split("\n").flatMap((l, i) => (i ? [{ type: "hardBreak" }, ...(l ? [{ type: "text", text: l }] : [])] : l ? [{ type: "text", text: l }] : [])) : [] }))).run();
    } catch {
      alert("Le navigateur n'autorise pas la lecture du presse-papiers ici : utilisez Ctrl + Maj + V (⌘ + Maj + V sur Mac).");
    }
  }

  return (
    <div className="relative border-b border-line">
      <div className="flex flex-wrap items-center gap-0.5 px-1.5 py-1" role="toolbar" aria-label="Mise en forme">
        {b("Gras", <Bold size={15} />, s.bold, () => chain().toggleBold().run(), "Ctrl+B")}
        {b("Italique", <Italic size={15} />, s.italic, () => chain().toggleItalic().run(), "Ctrl+I")}
        {b("Souligné", <Underline size={15} />, s.underline, () => chain().toggleUnderline().run(), "Ctrl+U")}
        <span className="mx-1 h-5 w-px bg-line" aria-hidden />
        {b("Liste à puces", <List size={15} />, s.bullet, () => chain().toggleBulletList().run(), "Ctrl+Maj+8")}
        {b("Liste numérotée", <ListOrdered size={15} />, s.ordered, () => chain().toggleOrderedList().run(), "Ctrl+Maj+7")}
        {b(s.link ? "Modifier le lien" : "Ajouter un lien", <Link2 size={15} />, s.link, () => setLinkOpen((o) => !o), "Ctrl+K")}
        <div className="relative">
          <button type="button" aria-label="Insérer une variable" aria-expanded={vars} onMouseDown={(e) => e.preventDefault()} onClick={() => setVars((v) => !v)}
            className={cn("inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs font-semibold text-muted hover:bg-surface hover:text-ink", vars && "bg-violet-soft text-violet-strong")}>
            <Braces size={14} /> Variable
          </button>
          {vars && (
            <div className="absolute left-0 z-20 mt-1 w-48 rounded-xl border border-line bg-white p-1 shadow-lg" role="menu" data-variable-menu>
              {VARIABLES.map((v) => (
                <MenuItem key={v.key} icon={<Braces size={13} />} onClick={() => { setVars(false); chain().insertContent({ type: "variable", attrs: { key: v.key } }).run(); }}>{v.label}</MenuItem>
              ))}
            </div>
          )}
        </div>
        <span className="mx-1 h-5 w-px bg-line" aria-hidden />
        {b("Annuler", <Undo2 size={15} />, false, () => chain().undo().run(), "Ctrl+Z", !s.canUndo)}
        {b("Rétablir", <Redo2 size={15} />, false, () => chain().redo().run(), "Ctrl+Maj+Z", !s.canRedo)}
        <div className="relative ml-auto">
          {b("Plus d'options", <MoreHorizontal size={15} />, more, () => setMore((m) => !m))}
          {more && (
            <div className="absolute right-0 z-20 mt-1 w-60 rounded-xl border border-line bg-white p-1 shadow-lg" role="menu">
              <MenuItem icon={<Eraser size={14} />} onClick={() => { setMore(false); chain().unsetAllMarks().clearNodes().run(); }}>Effacer la mise en forme</MenuItem>
              <MenuItem icon={<ClipboardPaste size={14} />} onClick={() => void pastePlain()}>Coller sans mise en forme <span className="ml-auto text-[10px] text-muted">Ctrl+Maj+V</span></MenuItem>
              <MenuItem icon={<Quote size={14} />} onClick={() => { setMore(false); chain().toggleBlockquote().run(); }}>{s.quote ? "Retirer la citation" : "Citation"}</MenuItem>
            </div>
          )}
        </div>
      </div>
      {linkOpen && <LinkPanel key={s.href} editor={editor} href={s.href} onClose={() => setLinkOpen(false)} />}
    </div>
  );
}

function MenuItem({ icon, children, onClick }: { icon: React.ReactNode; children: React.ReactNode; onClick: () => void }) {
  return (
    <button type="button" role="menuitem" onMouseDown={(e) => e.preventDefault()} onClick={onClick} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-surface">
      {icon}{children}
    </button>
  );
}

function LinkPanel({ editor, href, onClose }: { editor: Editor; href: string; onClose: () => void }) {
  const [value, setValue] = useState(href);
  const [error, setError] = useState<string | null>(null);
  const apply = () => {
    const url = normalizeUrl(value);
    if (!url) return setError("Adresse invalide : un site (https://…), un email ou un numéro (tel:…)");
    const { empty } = editor.state.selection;
    if (empty && !editor.isActive("link")) {
      // aucun texte sélectionné : l'adresse devient le texte du lien
      // le texte tapé ensuite ne doit pas prolonger le lien
      editor.chain().focus().insertContent({ type: "text", text: value.trim(), marks: [{ type: "link", attrs: { href: url } }] }).unsetMark("link").run();
    } else {
      editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
    }
    onClose();
  };
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-line bg-surface/60 px-2 py-1.5" data-link-panel>
      <input autoFocus value={value} onChange={(e) => { setValue(e.target.value); setError(null); }} placeholder="https://… ou adresse email" aria-label="Adresse du lien"
        className="h-8 min-w-0 flex-1 rounded-md border border-line bg-white px-2 text-sm outline-none focus:border-violet"
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); apply(); } if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); editor.commands.focus(); } }} />
      <button type="button" onClick={apply} className="h-8 rounded-md bg-ink px-3 text-xs font-semibold text-white">Appliquer</button>
      {href && <button type="button" onClick={() => { editor.chain().focus().extendMarkRange("link").unsetLink().run(); onClose(); }} className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs font-semibold text-muted hover:text-danger"><Unlink size={13} /> Retirer</button>}
      <button type="button" onClick={() => { onClose(); editor.commands.focus(); }} className="h-8 rounded-md px-2 text-xs text-muted">Annuler</button>
      {error && <p className="w-full text-xs text-danger">{error}</p>}
    </div>
  );
}
