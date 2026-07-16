import type { ServerResponse } from "node:http";

export class EventHub {
  private readonly clients = new Set<ServerResponse>();

  add(response: ServerResponse): () => void {
    this.clients.add(response);
    return () => this.clients.delete(response);
  }

  publish(event: string, data: unknown): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const response of this.clients) {
      try {
        response.write(payload);
      } catch {
        this.clients.delete(response);
      }
    }
  }

  close(): void {
    for (const response of this.clients) response.end();
    this.clients.clear();
  }
}
