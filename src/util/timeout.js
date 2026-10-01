class TimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TimeoutError';
  }
}

/**
 * Race a promise against a timer. The timer is always cleared, so it never
 * keeps the process alive. The underlying work is not cancelled.
 */
function withTimeout(promise, ms, message = `Timed out after ${ms}ms`) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

module.exports = { withTimeout, TimeoutError };
