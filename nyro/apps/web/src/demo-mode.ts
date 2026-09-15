/**
 * Demo-mode flag, in its own module.
 *
 * It lived in main.tsx, which made App.tsx import from the entry point that
 * imports App — a cycle that happened to work and would not have stayed that
 * way. A build-time constant belongs on its own.
 */
export const DEMO_MODE = import.meta.env.VITE_NYRO_DEMO === "true";
