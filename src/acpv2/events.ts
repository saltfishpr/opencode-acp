export class TypedEmitter<T> {
  private readonly listeners = new Set<(event: T) => void>();

  constructor(private readonly onListenerError: (error: unknown) => void) {}

  subscribe(listener: (event: T) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: T): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        this.onListenerError(error);
      }
    }
  }
}
