"use client";

// Composants de base, dans l'esprit shadcn/ui, aux couleurs Cely Growth.
import { clsx, type ClassValue } from "clsx";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, type ComponentProps, type ReactNode } from "react";
import { twMerge } from "tailwind-merge";
import { X } from "lucide-react";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
const buttonStyles: Record<ButtonVariant, string> = {
  primary: "bg-ink text-white hover:bg-violet-strong",
  secondary: "border border-line bg-white text-ink hover:border-violet hover:bg-violet-soft",
  ghost: "text-muted hover:bg-violet-soft hover:text-ink",
  danger: "border border-danger/30 bg-white text-danger hover:bg-danger/5",
};

export function Button({
  variant = "secondary",
  size = "md",
  className,
  ...props
}: ComponentProps<"button"> & { variant?: ButtonVariant; size?: "sm" | "md" }) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex items-center justify-center gap-1.5 rounded-lg font-semibold whitespace-nowrap transition-colors disabled:pointer-events-none disabled:opacity-50",
        size === "sm" ? "h-7 px-2.5 text-xs" : "h-9 px-3.5 text-sm",
        buttonStyles[variant],
        className,
      )}
      {...props}
    />
  );
}

export function ButtonLink({
  variant = "secondary",
  className,
  ...props
}: ComponentProps<typeof Link> & { variant?: ButtonVariant }) {
  return (
    <Link
      className={cn(
        "inline-flex h-9 items-center justify-center gap-1.5 rounded-lg px-3.5 text-sm font-semibold whitespace-nowrap transition-colors",
        buttonStyles[variant],
        className,
      )}
      {...props}
    />
  );
}

const fieldBase =
  "w-full rounded-lg border border-line bg-white px-3 text-sm text-ink placeholder:text-muted/70 focus:border-violet focus:outline-none focus:ring-2 focus:ring-violet/20 disabled:bg-surface";

export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input className={cn(fieldBase, "h-9", className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return <textarea className={cn(fieldBase, "min-h-20 py-2 leading-relaxed", className)} {...props} />;
}

export function Select({ className, ...props }: ComponentProps<"select">) {
  return <select className={cn(fieldBase, "h-9 pr-8", className)} {...props} />;
}

export function Label({ className, ...props }: ComponentProps<"label">) {
  return <label className={cn("mb-1 block font-label text-xs font-semibold text-muted", className)} {...props} />;
}

export function Field({ label, children, className, hint }: { label: string; children: ReactNode; className?: string; hint?: string }) {
  return (
    <div className={className}>
      <Label>{label}</Label>
      {children}
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </div>
  );
}

const badgeTones = {
  neutral: "bg-surface text-muted border-line",
  violet: "bg-violet-soft text-violet-strong border-violet-line",
  success: "bg-success/10 text-success border-success/20",
  danger: "bg-danger/10 text-danger border-danger/20",
  warning: "bg-amber-50 text-warning border-amber-200",
  ink: "bg-ink text-white border-ink",
};

export function Badge({ tone = "neutral", className, ...props }: ComponentProps<"span"> & { tone?: keyof typeof badgeTones }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-label text-[11px] font-semibold whitespace-nowrap",
        badgeTones[tone],
        className,
      )}
      {...props}
    />
  );
}

export function Card({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("rounded-xl border border-line bg-white", className)} {...props} />;
}

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="font-display text-2xl font-extrabold tracking-tight text-ink">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function EmptyState({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center rounded-xl border border-dashed border-line bg-surface/60 px-6 py-12 text-center">
      <p className="font-display text-lg font-bold text-ink">{title}</p>
      {description && <p className="mt-1 max-w-md text-sm text-muted">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Tabs({ items }: { items: { href: string; label: string; exact?: boolean }[] }) {
  const pathname = usePathname();
  return (
    <nav className="mb-5 flex gap-1 overflow-x-auto border-b border-line">
      {items.map((it) => {
        const active = it.exact ? pathname === it.href : pathname === it.href || pathname.startsWith(it.href + "/");
        return (
          <Link
            key={it.href}
            href={it.href}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 font-label text-sm font-semibold whitespace-nowrap",
              active ? "border-violet text-ink" : "border-transparent text-muted hover:text-ink",
            )}
          >
            {it.label}
          </Link>
        );
      })}
    </nav>
  );
}

/** Fenêtre modale basée sur <dialog> (accessible au clavier, Échap pour fermer). */
export function Modal({
  open,
  onClose,
  title,
  children,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      // showModal() place le focus sur le premier bouton (la croix) : on le donne au premier champ
      d.querySelector<HTMLElement>("input:not([type=hidden]):not([type=checkbox]), textarea, select")?.focus();
    }
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={onClose}
      className={cn(
        "m-auto w-[calc(100%-2rem)] rounded-2xl border border-line bg-white p-0 text-ink shadow-xl",
        wide ? "max-w-3xl" : "max-w-lg",
      )}
    >
      {open && (
        <div className="max-h-[85vh] overflow-y-auto p-5">
          <div className="mb-4 flex items-start justify-between gap-4">
            <h2 className="font-display text-lg font-bold">{title}</h2>
            <button onClick={onClose} className="rounded-md p-1 text-muted hover:bg-surface" aria-label="Fermer">
              <X size={18} />
            </button>
          </div>
          {children}
        </div>
      )}
    </dialog>
  );
}

export function Spinner() {
  return <span className="inline-block size-4 animate-spin rounded-full border-2 border-violet border-t-transparent" />;
}
