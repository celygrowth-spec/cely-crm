import "server-only";

// Variables lues uniquement côté serveur : rien n'est exposé au navigateur.
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Variable d'environnement manquante : ${name} (voir .env.example)`);
  return value;
}

export const env = {
  get supabaseUrl() {
    return required("SUPABASE_URL").replace(/\/+$/, "");
  },
  get supabaseKey() {
    return required("SUPABASE_PUBLISHABLE_KEY");
  },
};
