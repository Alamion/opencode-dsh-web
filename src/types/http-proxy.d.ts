declare module 'http-proxy' {
  export interface ServerOptions {
    target?: string;
    ws?: boolean;
    changeOrigin?: boolean;
    xfwd?: boolean;
  }

  export interface ProxyServer {
    web(req: unknown, res: unknown, options?: unknown): void;
    ws(req: unknown, socket: unknown, head: unknown, options?: unknown): void;
    on(event: string, listener: (...args: any[]) => void): void;
  }

  export function createProxyServer(options?: ServerOptions): ProxyServer;
  export function createServer(options?: ServerOptions): unknown;
}
