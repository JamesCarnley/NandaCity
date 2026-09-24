import { randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { keccak256, toBytes } from 'viem';

import { storedTaskRecordSchema, type StoredTaskRecord } from './wire.js';

const MAX_RECORD_BYTES = 1024 * 1024;

function fileNameFor(interactionKey: string): string {
  return `${keccak256(toBytes(interactionKey)).slice(2)}.json`;
}
export class CityTaskStore {
  readonly #directory: string;
  readonly #byInteraction = new Map<string, StoredTaskRecord>();
  readonly #interactionByTask = new Map<string, string>();
  readonly #locks = new Map<string, Promise<void>>();

  private constructor(directory: string) {
    this.#directory = directory;
  }

  static async open(directory: string): Promise<CityTaskStore> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const store = new CityTaskStore(directory);
    const names = await readdir(directory);
    for (const name of names.sort()) {
      if (!/^[0-9a-f]{64}\.json$/.test(name)) continue;
      const path = join(directory, name);
      if ((await stat(path)).size > MAX_RECORD_BYTES) throw new Error(`stored task exceeds ${MAX_RECORD_BYTES} bytes`);
      const record = storedTaskRecordSchema.parse(JSON.parse(await readFile(path, 'utf8')));
      if (fileNameFor(record.interactionKey) !== name) throw new Error('stored task filename does not match interaction key');
      if (store.#byInteraction.has(record.interactionKey) || store.#interactionByTask.has(record.task.id)) {
        throw new Error('stored task identifiers are not unique');
      }
      store.#byInteraction.set(record.interactionKey, record);
      store.#interactionByTask.set(record.task.id, record.interactionKey);
    }
    return store;
  }

  getByInteraction(interactionKey: string): StoredTaskRecord | undefined {
    return this.#byInteraction.get(interactionKey);
  }

  getByTask(taskId: string): StoredTaskRecord | undefined {
    const interaction = this.#interactionByTask.get(taskId);
    return interaction ? this.#byInteraction.get(interaction) : undefined;
  }

  async save(record: StoredTaskRecord): Promise<void> {
    const validated = storedTaskRecordSchema.parse(record);
    const serialized = JSON.stringify(validated);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_RECORD_BYTES) throw new Error('stored task record is too large');
    const destination = join(this.#directory, fileNameFor(validated.interactionKey));
    const temporary = join(this.#directory, `.${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(serialized, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, destination);
    const directoryHandle = await open(this.#directory, 'r');
    try { await directoryHandle.sync(); }
    finally { await directoryHandle.close(); }
    this.#byInteraction.set(validated.interactionKey, validated);
    this.#interactionByTask.set(validated.task.id, validated.interactionKey);
  }

  async withInteractionLock<T>(interactionKey: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(interactionKey) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    this.#locks.set(interactionKey, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#locks.get(interactionKey) === tail) this.#locks.delete(interactionKey);
    }
  }
}
