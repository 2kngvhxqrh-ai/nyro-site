/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * "true" only in the demo build. Both vite configs `define` it literally, so
   * dot access folds to a constant and the demo code is dropped entirely from
   * the production bundle rather than shipped as never-loaded chunks.
   */
  readonly VITE_NYRO_DEMO: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
