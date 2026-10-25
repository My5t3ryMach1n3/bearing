// Retries a flaky call, doubling the wait each time. Nothing calls it yet.
export async function retryWithBackoff<T>(call: () => Promise<T>, attempts = 3, delayMs = 100): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      if (attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs * 2 ** (attempt - 1)));
    }
  }
}
