// The server's clock, in one place so time-dependent rules (admission windows) can be tested at an exact instant.
// Production always returns the real time; nothing a client sends can reach this.
export const clock = {
  now: (): Date => new Date()
};
