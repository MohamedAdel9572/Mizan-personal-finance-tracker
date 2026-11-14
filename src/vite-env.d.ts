// Types for the build-time variables written by build-config.sh (vite/client is loaded via tsconfig "types").
interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
}
