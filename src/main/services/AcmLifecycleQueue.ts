/**
 * Serializes ACM lifecycle operations so a plugin state transition cannot
 * interleave with accepting a new runner or diff task.
 */
export class AcmLifecycleQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(operation: () => Promise<T> | T): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    return previous.then(operation).finally(() => release());
  }
}

export const acmLifecycleQueue = new AcmLifecycleQueue();
