import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";

export interface JournalEntry {
  stored: boolean;
  event: unknown;
}

export class EventJournal {
  private writeChain: Promise<void> = Promise.resolve();

  constructor(readonly path: string) {}

  async append(event: unknown): Promise<void> {
    const entry: JournalEntry = { stored: false, event };
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      await appendFile(this.path, `${JSON.stringify(entry)}\n`, "utf8");
    });
    return this.writeChain;
  }

  async markStored(event: unknown): Promise<void> {
    const entry: JournalEntry = { stored: true, event };
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      await appendFile(this.path, `${JSON.stringify(entry)}\n`, "utf8");
    });
    return this.writeChain;
  }

  async replay(onEvent: (event: unknown) => Promise<void>): Promise<number> {
    await this.writeChain;
    let raw = "";
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
    const states = new Map<string, JournalEntry>();
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line) as JournalEntry;
      const key = eventKey(entry.event);
      const previous = states.get(key);
      states.set(key, {
        event: entry.event,
        stored: entry.stored || previous?.stored === true,
      });
    }
    let count = 0;
    for (const entry of states.values()) {
      if (entry.stored) continue;
      await onEvent(entry.event);
      count += 1;
    }
    return count;
  }

  async clear(): Promise<void> {
    await this.writeChain;
    await rm(this.path, { force: true });
  }
}

function eventKey(event: unknown): string {
  if (event && typeof event === "object" && "id" in event && typeof event.id === "string") {
    return event.id;
  }
  return JSON.stringify(event);
}
