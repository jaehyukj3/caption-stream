/// <reference types="vite/client" />
declare const __BUILD__: string;
declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<object, object, unknown>;
  export default component;
}
