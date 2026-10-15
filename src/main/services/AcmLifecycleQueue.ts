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

  /**
   * Runs a cancellable operation after prior lifecycle work is admitted, then
   * releases the queue as soon as the operation returns its promise. This
   * keeps stop/disable requests responsive during compiler probing or runs.
   */
  runDetached<T>(operation: () => Promise<T> | T): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    return previous.then(() => {
      try {
        const result = operation();
        release();
        return result;
      } catch (error) {
        release();
        throw error;
      }
    });
  }
}

export const acmLifecycleQueue = new AcmLifecycleQueue();
